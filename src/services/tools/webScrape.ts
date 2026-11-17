// src/services/tools/webScrape.ts
import { z } from "zod";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { chromium } from "playwright";
import { registerTool, errorResult, okResult } from "./registry.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { redisClient } from "../../config/redis.js";
import {
  checkDomain,
  checkUrlPath,
  checkTitle,
  checkContentScore,
} from "./webScrapeBlocklist.js";
import TurndownService from "turndown";
import sanitizeHtml from "sanitize-html";

const WebScrapeSchema = z.object({
  url: z.string().url().startsWith("http"),
  mode: z.enum(["fast", "render"]).default("fast"),
  startChar: z.number().int().min(0).default(0),
  maxChars: z.number().int().min(100).max(12000).default(8000),
});

const MAX_RESULT_CHARS = 14000;
const UA = "RensChatBot/1.0";

// ─── SSRF & DNS Pinning Helpers ───────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    // IPv6 check
    if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7
    if (
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb")
    )
      return true; // fe80::/10
    if (ip.startsWith("::ffff:")) {
      return isPrivateIp(ip.replace("::ffff:", ""));
    }
    return false;
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  finalUrl: string;
}

async function fetchWithSSRF(
  urlStr: string,
  timeoutMs: number,
  maxBytes: number,
  redirectsLeft = 5,
): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error("SSRF_BLOCKED: URL tidak valid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SSRF_BLOCKED: Skema URL tidak didukung");
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new Error("SSRF_BLOCKED: Port tidak didukung");
  }
  if (url.username || url.password) {
    throw new Error("SSRF_BLOCKED: URL tidak boleh mengandung kredensial");
  }

  let addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new Error("FETCH_FAILED: Gagal resolve DNS");
  }

  let validIp: string | null = null;
  for (const addr of addresses) {
    if (!isPrivateIp(addr.address)) {
      validIp = addr.address;
      break;
    }
  }

  if (!validIp) {
    throw new Error("SSRF_BLOCKED: IP privat/loopback terdeteksi");
  }

  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;

    // DNS Pinning: request ke IP yang sudah divalidasi, tapi set Host header aslinya
    const req = client.request(
      {
        hostname: validIp,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          "User-Agent": UA,
          Host: url.hostname,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        servername: url.hostname, // SNI untuk HTTPS
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        // Handle Redirect
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (redirectsLeft <= 0) {
            reject(new Error("SSRF_BLOCKED: Terlalu banyak redirect"));
            res.destroy();
            return;
          }
          const location = res.headers.location;
          if (!location) {
            reject(new Error("FETCH_FAILED: Redirect tanpa Location header"));
            res.destroy();
            return;
          }
          const nextUrl = new URL(location, url).toString();
          fetchWithSSRF(nextUrl, timeoutMs, maxBytes, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          res.destroy();
          return;
        }

        const contentType = (res.headers["content-type"] || "").toLowerCase();
        const allowedTypes = [
          "text/html",
          "text/plain",
          "application/json",
          "application/xhtml+xml",
          "text/xml",
        ];
        if (!allowedTypes.some((t) => contentType.includes(t))) {
          reject(new Error("UNSUPPORTED_CONTENT_TYPE"));
          res.destroy();
          return;
        }

        let body = "";
        let bytes = 0;

        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy();
            reject(new Error("FETCH_FAILED: Ukuran body melebihi batas"));
            return;
          }
          body += chunk.toString("utf-8");
        });

        res.on("end", () => {
          resolve({
            status,
            headers: res.headers,
            body,
            finalUrl: url.toString(),
          });
        });
      },
    );

    req.on("error", (err) => {
      reject(new Error(`FETCH_FAILED: ${err.message}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("FETCH_FAILED: Timeout"));
    });

    req.end();
  });
}

// ─── Rate Limit Helper ────────────────────────────────────────────────────

async function checkRateLimit(userId: string): Promise<boolean> {
  const key = `genui:ratelimit:web_scrape:${userId}`;
  try {
    const current = await redisClient.incr(key);
    if (current === 1) {
      await redisClient.expire(key, 3600); // 1 hour
    }
    return current <= env.WEB_SCRAPE_HOURLY_LIMIT;
  } catch (err) {
    logger.warn({ err }, "Redis rate limit failed, allowing request");
    return true; // fallback if Redis is down
  }
}

// ─── HTML Processing ──────────────────────────────────────────────────────

function processHtml(
  html: string,
  url: string,
): { title: string; text: string } {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  const sanitized = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["class", "id"],
      img: ["src", "alt"],
      a: ["href"],
    },
    nonTextTags: [
      "style",
      "script",
      "noscript",
      "iframe",
      "nav",
      "footer",
      "header",
      "aside",
    ],
  });

  const titleMatch = sanitized.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  let bodyHtml = sanitized;
  const bodyMatch = sanitized.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) bodyHtml = bodyMatch[1];

  const markdown = td.turndown(bodyHtml);
  const text = markdown.replace(/\n{3,}/g, "\n\n").trim();

  return { title, text };
}

// ─── Tool Definition ──────────────────────────────────────────────────────

export function registerWebScrapeTool(): void {
  registerTool({
    name: "web_scrape",
    kind: "web",
    maxResultChars: MAX_RESULT_CHARS,
    description:
      "Membuka dan membaca halaman web. Gunakan jika user meminta untuk merangkum, mencari informasi dari URL, atau butuh data terbaru dari internet.",
    schema: WebScrapeSchema,
    async run(args, ctx) {
      const a = WebScrapeSchema.parse(args);
      const userId = ctx.userId.toString();

      // 1. Rate Limit
      if (!(await checkRateLimit(userId))) {
        return errorResult(
          "RATE_LIMIT",
          "Batas scrape per jam terlampaui",
          undefined,
          MAX_RESULT_CHARS,
        );
      }

      // 2. Domain / URL Blocklist
      try {
        const parsedUrl = new URL(a.url);
        if (checkDomain(parsedUrl.hostname) || checkUrlPath(a.url)) {
          return errorResult(
            "CONTENT_BLOCKED",
            "Situs ini masuk dalam daftar blokir (judi/finansial terlarang).",
            undefined,
            MAX_RESULT_CHARS,
          );
        }
      } catch {
        return errorResult(
          "INVALID_ARGS",
          "URL tidak valid",
          undefined,
          MAX_RESULT_CHARS,
        );
      }

      let title = "";
      let text = "";
      let finalUrl = a.url;

      try {
        if (a.mode === "render" && env.WEB_SCRAPE_RENDER_ENABLED) {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage({ javaScriptEnabled: true });
            // Setup SSRF guard di Playwright (blokir request ke IP privat)
            await page.route("**/*", async (route) => {
              const reqUrl = route.request().url();
              try {
                const u = new URL(reqUrl);
                const addrs = await dns.lookup(u.hostname, { all: true });
                const hasPrivate = addrs.some((addr) =>
                  isPrivateIp(addr.address),
                );
                if (hasPrivate) {
                  return route.abort();
                }
              } catch {
                return route.abort();
              }
              return route.continue();
            });

            await page.goto(a.url, {
              waitUntil: "networkidle",
              timeout: env.WEB_SCRAPE_TIMEOUT_MS,
            });
            finalUrl = page.url();

            const html = await page.content();
            const res = processHtml(html, finalUrl);
            title = res.title;
            text = res.text;
          } finally {
            await browser.close();
          }
        } else {
          const res = await fetchWithSSRF(
            a.url,
            env.WEB_SCRAPE_TIMEOUT_MS,
            env.WEB_SCRAPE_MAX_BYTES,
          );
          finalUrl = res.finalUrl;
          const processed = processHtml(res.body, finalUrl);
          title = processed.title;
          text = processed.text;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("SSRF_BLOCKED"))
          return errorResult("SSRF_BLOCKED", msg, undefined, MAX_RESULT_CHARS);
        if (msg.includes("UNSUPPORTED_CONTENT_TYPE"))
          return errorResult(
            "UNSUPPORTED_CONTENT_TYPE",
            "Tipe konten tidak didukung",
            undefined,
            MAX_RESULT_CHARS,
          );
        return errorResult("FETCH_FAILED", msg, undefined, MAX_RESULT_CHARS);
      }

      // 3. Title Blocklist
      if (checkTitle(title)) {
        return errorResult(
          "CONTENT_BLOCKED",
          "Judul halaman terindikasi konten terlarang.",
          undefined,
          MAX_RESULT_CHARS,
        );
      }

      // 4. Content Blocklist (skor > 5)
      const score = checkContentScore(text);
      if (score > 5) {
        return errorResult(
          "CONTENT_BLOCKED",
          "Konten halaman terindikasi promosi judi/finansial terlarang.",
          undefined,
          MAX_RESULT_CHARS,
        );
      }

      // 5. Paginasi
      const totalChars = text.length;
      let nextStart: number | null = null;
      let chunk = text;

      if (a.startChar > 0 || a.maxChars < totalChars) {
        chunk = text.slice(a.startChar, a.startChar + a.maxChars);
        if (a.startChar + a.maxChars < totalChars) {
          nextStart = a.startChar + a.maxChars;
        }
      }

      // Bungkus dengan tag <web_content>
      const wrappedText = `<web_content source="${finalUrl}">\n${chunk}\n</web_content>`;

      return okResult(
        {
          title,
          url: a.url,
          finalUrl,
          text: wrappedText,
          totalChars,
          nextStart,
        },
        MAX_RESULT_CHARS,
      );
    },
  });
}

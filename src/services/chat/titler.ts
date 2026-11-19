// src/services/chat/titler.ts

import { chat, type ChatMessage } from "../llm/nvidiaClient.js";
import { SUMMARY_MODEL } from "../../config/env.js";
import { mapReasoning } from "../llm/reasoningMap.js";
import { SessionModel } from "../../models/Session.js";
import { logger } from "../../config/logger.js";

const TITLE_PROMPT = `Buat judul percakapan yang sangat singkat (maksimal 60 karakter, tanpa tanda kutip, tanpa titik di akhir, bahasa sama dengan user). Balas HANYA judulnya.

Percakapan:
`;

// Reasoning model (MODEL_SUMMARY default = lightning) butuh budget token
// untuk reasoning dulu sebelum menulis content. 200 terlalu kecil — sudah
// terbukti contentLen=0 finishReason="length". 3000 cukup untuk
// reasoning ~1500-2000 token + judul singkat.
const TITLE_MAX_TOKENS = 4096;
const TITLE_TIMEOUT_MS = 90_000;

export async function generateTitle(
  sessionId: string,
  recentMessages: ChatMessage[],
): Promise<string | null> {
  const body =
    TITLE_PROMPT +
    recentMessages
      .map((m) => `${m.role}: ${String(m.content).slice(0, 400)}`)
      .join("\n");

  try {
    const extra = mapReasoning("nvidia", SUMMARY_MODEL, "off");
    const res = await chat(
      {
        model: SUMMARY_MODEL,
        messages: [{ role: "user", content: body }],
        max_tokens: TITLE_MAX_TOKENS,
        temperature: 0.3,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      },
      undefined,
      TITLE_TIMEOUT_MS,
    );
    const msg = res.choices[0]?.message;
    const raw = (msg?.content ?? "").trim();
    if (!raw) {
      const finishReason = res.choices[0]?.finish_reason ?? null;
      const reasoningLen = (msg?.reasoning_content ?? "").length;
      logger.warn(
        { sessionId, model: SUMMARY_MODEL, finishReason, reasoningLen },
        "title generation returned empty content; using extractive fallback",
      );

      // Extractive fallback: pakai 60 char pertama dari user message.
      // Lebih baik dari "New Chat" selama-lamanya.
      const firstUser = recentMessages.find((m) => m.role === "user");
      const userText = String(firstUser?.content ?? "").trim();
      const fallbackTitle = userText.slice(0, 60).replace(/\s+/g, " ").trim();
      if (fallbackTitle) {
        await SessionModel.updateOne(
          { _id: sessionId, titleAuto: true },
          { $set: { title: fallbackTitle, titleAuto: false } },
        );
        return fallbackTitle;
      }
      return null;
    }
    const title = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!title || title.length > 100) return null;

    await SessionModel.updateOne(
      { _id: sessionId, titleAuto: true },
      { $set: { title, titleAuto: false } },
    );
    return title;
  } catch (err) {
    logger.warn({ err }, "title generation failed");
    return null;
  }
}

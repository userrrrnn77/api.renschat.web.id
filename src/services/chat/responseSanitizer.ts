// src/services/chat/responseSanitizer.ts

interface SuppressBlock {
  open: string;
  close: string;
}

/** Blok yang seluruh isinya dibuang (open..close). */
const SUPPRESS_BLOCKS: SuppressBlock[] = [
  { open: "<tool_call>", close: "</tool_call>" },
  { open: "<tool_calls>", close: "</tool_calls>" },
  { open: "<function=", close: "</function>" },
  { open: "<parameter=", close: "</parameter>" },
  { open: "<|", close: "|>" },
];

/** Tag penutup/orphan yang dibuang begitu saja. */
const DROP_TAGS: string[] = [
  "</tool_call>",
  "</tool_calls>",
  "</function>",
  "</parameter>",
];

const ALL_PREFIX_CANDIDATES: string[] = [
  ...SUPPRESS_BLOCKS.map((b) => b.open),
  ...DROP_TAGS,
];

/** Berapa karakter ekor yang ditahan saat menunggu awal tag. */
const TAIL_HOLD = 24;

/**
 * Sanitizer streaming untuk output model.
 *
 * Tujuan: memastikan raw tool-call XML (`<tool_call>`, `<function=`,
 * `<parameter=`, special token `<|...|>`) tidak pernah lolos ke SSE,
 * sehingga tidak pernah masuk ke TextBlock di frontend.
 *
 * Karakter yang berpotensi menjadi awal tag ditahan sebentar sampai
 * dipastikan bukan tag, agar tidak ada potongan tag yang ter-emit
 * sebagai delta terpisah.
 */
export class StreamingResponseSanitizer {
  private buf = "";
  private suppressUntil: string | null = null;

  push(chunk: string): string {
    if (chunk) this.buf += chunk;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = "";

    for (;;) {
      if (this.suppressUntil !== null) {
        const lower = this.buf.toLowerCase();
        const idx = lower.indexOf(this.suppressUntil);
        if (idx === -1) {
          if (final) {
            this.buf = "";
            this.suppressUntil = null;
            return out;
          }
          const keep = this.suppressUntil.length + TAIL_HOLD;
          if (this.buf.length > keep) this.buf = this.buf.slice(-keep);
          return out;
        }
        this.buf = this.buf.slice(idx + this.suppressUntil.length);
        this.suppressUntil = null;
        continue;
      }

      const lt = this.buf.indexOf("<");

      if (lt === -1) {
        if (final) {
          out += this.buf;
          this.buf = "";
          return out;
        }
        if (this.buf.length <= TAIL_HOLD) return out;
        out += this.buf.slice(0, this.buf.length - TAIL_HOLD);
        this.buf = this.buf.slice(-TAIL_HOLD);
        return out;
      }

      if (lt > 0) {
        out += this.buf.slice(0, lt);
        this.buf = this.buf.slice(lt);
      }

      const lower = this.buf.toLowerCase();

      let dropped = false;
      for (const tag of DROP_TAGS) {
        if (lower.startsWith(tag)) {
          this.buf = this.buf.slice(tag.length);
          dropped = true;
          break;
        }
      }
      if (dropped) continue;

      let suppressed = false;
      for (const block of SUPPRESS_BLOCKS) {
        if (lower.startsWith(block.open)) {
          this.buf = this.buf.slice(block.open.length);
          this.suppressUntil = block.close;
          suppressed = true;
          break;
        }
      }
      if (suppressed) continue;

      const isPrefix = ALL_PREFIX_CANDIDATES.some(
        (cand) => cand.startsWith(lower) && lower.length < cand.length,
      );
      if (isPrefix && !final) return out;

      out += "<";
      this.buf = this.buf.slice(1);
    }
  }
}

/**
 * Sanitizer non-streaming untuk teks final (safety net di akhir blok).
 */
export function sanitizeFinalText(input: string): string {
  let s = input;
  for (const block of SUPPRESS_BLOCKS) {
    const open = block.open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const close = block.close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (block.open === "<|") {
      s = s.replace(new RegExp(`${open}[^]*?${close}`, "g"), " ");
    } else {
      s = s.replace(new RegExp(`${open}[^]*?${close}`, "gi"), " ");
    }
  }
  for (const tag of DROP_TAGS) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(esc, "gi"), " ");
  }
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

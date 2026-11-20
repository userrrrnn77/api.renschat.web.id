import type { Block } from "../blocks/schemas.js";
import type { ClarificationQuestion } from "../orchestrator/clarification.js";

type MediaKind = "image" | "video";
type Aspect = "1:1" | "16:9" | "9:16";
type Ask = (question: ClarificationQuestion) => Promise<string[]>;
type HistoryMessage = { role: string; blocks: Block[] };

const OPTIONS: Record<MediaKind, Aspect[]> = {
  image: ["1:1", "16:9", "9:16"],
  video: ["16:9", "9:16"],
};

const LABELS: Record<Aspect, string> = {
  "1:1": "1:1 · Persegi · Feed",
  "16:9": "16:9 · Lebar · Layar laptop",
  "9:16": "9:16 · Vertikal · Story atau Reels",
};

function readAspect(text: string): string | undefined {
  const explicit = new Set<string>();

  for (const match of text.matchAll(/\b(\d{1,5})\s*[:：x×]\s*(\d{1,5})\b/gi)) {
    const width = Number(match[1]);
    const height = Number(match[2]);

    if (width > 0 && width === height) {
      explicit.add("1:1");
    } else if (width > 0 && width * 9 === height * 16) {
      explicit.add("16:9");
    } else if (height > 0 && width * 16 === height * 9) {
      explicit.add("9:16");
    } else {
      explicit.add(`${width}:${height}`);
    }
  }

  if (explicit.size > 1) return "ambiguous";
  if (explicit.size === 1) return [...explicit][0];

  const formats = [
    {
      aspect: "9:16",
      pattern:
        /\b(?:vertikal|vertical|portrait|reels?|tiktok|shorts|(?:ig|instagram|wa)\s+stor(?:y|ies)|stor(?:y|ies)\s+(?:ig|instagram|wa))\b/i,
    },
    {
      aspect: "16:9",
      pattern: /\b(?:horizontal|landscape|widescreen|mendatar)\b/i,
    },
    {
      aspect: "1:1",
      pattern: /\b(?:persegi|square|format kotak)\b/i,
    },
  ];

  const matches = formats.filter(({ pattern }) => pattern.test(text));
  if (matches.length > 1) return "ambiguous";
  return matches[0]?.aspect;
}

function previousAspect(
  history: HistoryMessage[],
  kind: MediaKind,
): Aspect | undefined {
  for (const message of [...history].reverse()) {
    if (message.role !== "assistant") continue;

    for (const block of [...message.blocks].reverse()) {
      if (kind === "video" && block.type === "video") {
        return block.aspect;
      }

      if (
        kind === "image" &&
        block.type === "image" &&
        block.width &&
        block.height
      ) {
        if (block.width === block.height) return "1:1";
        return block.width > block.height ? "16:9" : "9:16";
      }
    }
  }
}

export function createAspectResolver(
  text: string,
  toolbarAspect: Aspect | undefined,
  history: HistoryMessage[],
  ask: Ask,
) {
  const resolved = new Map<MediaKind, Aspect>();

  return async (kind: MediaKind): Promise<Aspect> => {
    const existing = resolved.get(kind);
    if (existing) return existing;

    const options = OPTIONS[kind];
    const medium = kind === "image" ? "gambar" : "video";
    const isRevision =
      /\b(?:revisi|ubah|ganti|edit|tadi|sebelumnya|change|revise)\b/i.test(
        text,
      );

    let candidate =
      readAspect(text) ??
      (kind === "video" ? toolbarAspect : undefined) ??
      (isRevision ? previousAspect(history, kind) : undefined);

    for (;;) {
      const selected = options.find((option) => option === candidate);

      if (selected) {
        resolved.set(kind, selected);
        return selected;
      }

      const answer = await ask({
        question: candidate
          ? `Pilih satu rasio yang tersedia untuk ${medium} ini.`
          : `Mau pakai rasio berapa untuk ${medium} ini?`,
        multi: false,
        options: options.map((value) => ({
          value,
          label: LABELS[value],
        })),
      });

      candidate = readAspect(answer.join(" ")) ?? "unknown";
    }
  };
}

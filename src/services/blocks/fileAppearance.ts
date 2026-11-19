import { z } from "zod";

export const FILE_ICONS = [
  "file",
  "package",
  "gauge",
  "pyramid",
  "code",
  "braces",
  "database",
  "terminal",
  "settings",
  "archive",
  "image",
  "document",
] as const;

const Icon = z.enum(FILE_ICONS);
const Accent = z.string().regex(/^#[0-9a-f]{6}$/i);

export const FileAppearanceSchema = z.object({
  icon: Icon.optional(),
  accent: Accent.optional(),
});

export type FileAppearance = z.infer<typeof FileAppearanceSchema>;

export function normalizeFileAppearance(
  value: unknown,
): FileAppearance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const icon = Icon.safeParse(input.icon);
  const accent = Accent.safeParse(input.accent);

  if (!icon.success && !accent.success) return undefined;

  return {
    ...(icon.success ? { icon: icon.data } : {}),
    ...(accent.success ? { accent: accent.data } : {}),
  };
}

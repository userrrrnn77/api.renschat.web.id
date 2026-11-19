// Berlaku untuk prosa assistant. Isi blok kode dan isi file tidak lewat sini.
export function makePublicLineFilter(toolNames: readonly string[]) {
  const escapedNames = toolNames
    .filter((name) => name.includes("_"))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  const toolPattern = escapedNames.length
    ? new RegExp(`\\b(?:${escapedNames.join("|")})\\b`, "i")
    : null;

  // Bentuk lama yang dibuat blocksToText, termasuk variasi size dari model.
  const fileMarker =
    /\[file:\s*[^\]\n]*?\(\s*id\s*=\s*[a-f0-9]{24}\b[^\]\n]*\)\s*\]/gi;

  // Metadata operasional seperti "FileId-nya: `6aff...`".
  const internalId =
    /\b(?:file[\s_-]*id|call[\s_-]*id)(?:-?nya)?\s*[:=]\s*[`"']?[\w-]+/i;

  const pendingId =
    /\b(?:id|fileid)\s+(?:akan|bakal)\s+(?:muncul|tersedia|diberikan)\b/i;

  return function publicLine(line: string): string {
    const cleaned = line.replace(fileMarker, "");

    if (
      toolPattern?.test(cleaned) ||
      internalId.test(cleaned) ||
      pendingId.test(cleaned)
    ) {
      return "";
    }

    return cleaned;
  };
}

export type FileAction = "create_file" | "present_files";

export function detectFileAction(rawText: string): FileAction | undefined {
  // Format dari encoder paste/reply RensChat. Hanya baca instruksi user,
  // supaya kata "create_file" di dalam kode yang ditempel tidak memicu tool.
  let instruction = rawText;

  if (rawText.startsWith("Konteks pesan RensChat:\n")) {
    const marker = "\nPesan pengguna:\n";
    const index = rawText.indexOf(marker);
    if (index !== -1) instruction = rawText.slice(index + marker.length);
  }

  const text = instruction.trim();

  // Batasi ke perintah langsung. Pertanyaan seperti
  // "kenapa app.tsx gagal dibuat?" tetap masuk chat biasa.
  const command = text.replace(
    /^(?:(?:oke|ok|nah|bre|please|tolong|coba|lu|kamu|bisa|bantu|gw minta)[\s,]+)+/i,
    "",
  );

  const wantsCreate =
    /^(?:bikin(?:kan|in)?|buat(?:kan|in)?|create|generate)\b/i.test(command);

  const wantsPresent =
    /^(?:present(?:asikan)?|tampil(?:kan|in)|tunjuk(?:kan|in)|kirim\s+(?:ulang|lagi)|show|resend)\b/i.test(
      command,
    );

  const hasFilename = /[\w-]+\.[a-z][a-z0-9]{0,9}\b/i.test(command);
  const mentionsFile = /\b(?:files?(?:nya)?|berkas(?:nya)?)\b/i.test(command);

  // PDF/media punya jalur generator sendiri.
  if (wantsCreate && /\.(?:pdf|png|jpe?g|webp|mp4|webm)\b/i.test(command)) {
    return undefined;
  }

  // Urutan penting: "bikin app.tsx dan present filesnya" harus MEMBUAT
  // file dulu, bukan mencari file lama dengan nama yang sama.
  if (wantsCreate && hasFilename) return "create_file";
  if (wantsPresent && (mentionsFile || hasFilename)) return "present_files";

  return undefined;
}

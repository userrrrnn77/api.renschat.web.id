# GenUI Chat Backend

Backend chat AI generative UI — Bun + Express 5 + Mongoose + TypeScript, dengan kemampuan generate gambar (`flux.2-klein-4b` gratis, `flux.3-image-klein` untuk donatur) dan video (`nvidia/cosmos3-nano` untuk donatur, jalur gratis via Python + ffmpeg). Donasi Ko-fi bersifat **opsional**; semua fitur inti tetap gratis.

## Prasyarat

- **Bun** `>= 1.1` (`curl -fsSL https://bun.sh/install | bash`)
- **MongoDB Atlas** (atau instance replica set; fitur donasi memakai transaksi)
- **Cloudflare R2** bucket (media generated + lampiran)
- **Redis** (rate limit distributed; opsional di dev)
- **Docker** di host untuk sandbox Python (Fase 5, opsional kalau tidak pakai `generate_video_python`)
- **ffmpeg** di container backend untuk transcode H.264 (Cosmos) — dibundel dalam image Docker sandbox, tidak perlu di host

## Setup cepat

```bash
bun install
cp .env.example .env   # atau isi manual, lihat tabel di bawah
bun run dev            # dev:watch
bun run start          # prod
bun run typecheck
bun run test           # bun:test
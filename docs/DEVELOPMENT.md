# 🛠️ SIKRIT — Development Guide

> Panduan developer (toolchain ter-pin, build, test, catatan build). Ringkasan untuk juri ada di `README.md`.

## Struktur

```
programs/sikrit/src/lib.rs   Program Anchor (state machine + verifier Schnorr + unit test Rust)
sdk/liveness.ts              Prover ZK proof-of-liveness (dipakai test & frontend)
sdk/hpke.ts                  HPKE RFC 9180 base mode (enkripsi share ke kunci inbox X25519)
sdk/shamir.ts                Shamir's Secret Sharing GF(2^8) (wrapper library teraudit Cure53 + Zellic)
sdk/kit.ts                   Capsule kit: enkripsi rahasia, split kunci, seal share ke heir/guardian, release, recovery
tests/sikrit.ts              Test lifecycle kapsul di LiteSVM (time-travel clock)
tests/sdk.ts                 Test SDK: known-answer vector RFC 9180 & FIPS-197, serangan pada kit
sdk/client.ts                Client program ringan (instruksi, decoder akun, discovery) — diverifikasi byte-per-byte vs Anchor
app/                         Frontend demo (Vite + React + Tailwind + wallet adapter), memakai sdk/* langsung
app/e2e/demo-flow.mjs        E2E Chrome: owner → heartbeat → klaim → guardian 2-of-3 → heir memulihkan seed
docs/                        Pitch, spesifikasi teknis, security review
```

## Toolchain (ter-pin, mengikuti CI resmi Anchor v0.30.2)

| Tool | Versi | Catatan |
|---|---|---|
| Solana CLI | 1.18.17 | `cargo build-sbf` + platform-tools v1.41 |
| Rust (rustup) | 1.79.0 + `nightly-2024-01-30` | nightly dipakai Anchor 0.30.x untuk build IDL (di-install otomatis) |
| Anchor CLI | 0.30.2 (`@anchor-lang/cli`, devDependency) | crate `anchor-lang` tetap 0.30.1 — 0.30.2 tidak pernah dipublish ke crates.io, jadi warning versi mismatch saat build itu normal |
| Node.js | **24 LTS** (`.nvmrc`) | Node 22 membuat LiteSVM crash (`std::bad_alloc`, [litesvm#171](https://github.com/LiteSVM/litesvm/issues/171)); test suite menolak jalan di Node 22 dengan pesan jelas |

```bash
# sekali saja (tanpa mengubah .zshrc)
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
nvm install 24 && nvm use 24
npm install

npm run build         # anchor build (CLI 0.30.2 dari devDependency)
npm run test:rust     # unit test verifier Schnorr (host)
npm test              # lifecycle test di LiteSVM + test SDK
npm run typecheck
```

## Demo app (localnet)

```bash
npm run build                 # sekali: binary program untuk validator lokal
cd app && npm install
npm run localnet              # solana-test-validator + program SIKRIT + app di http://localhost:5173
npm run e2e                   # (opsional) jalankan seluruh cerita demo otomatis di Chrome, ~2,5 menit
```

Mode demo memakai lima persona (Pak Arif, Sari, Budi, Dewi, Rizal) dengan keypair di localStorage browser dan
relayer sebagai fee payer — semua peran bisa dimainkan di satu tab. Wallet asli (Phantom/Solflare/Backpack via
Wallet Standard) juga bisa dipakai untuk setiap peran. Build produksi (`npm run build` di `app/`) default ke devnet
dan memasang Content-Security-Policy ketat.

Catatan build:
- Pesan `Error: Function ... NafLookupTable8 ... Stack offset ... exceeded` saat `anchor build` **wajar dan tidak berbahaya**: itu kode curve25519-dalek yang tidak dipakai (operasi titik lewat syscall) dan dieliminasi dari binary final.
- `.cargo/config.toml` memaksa backend `serial` curve25519-dalek untuk build host, karena backend AVX-512 tidak bisa di-compile dengan nightly 2024-01-30 yang dipakai IDL build Anchor 0.30.x.
- Simpan `target/deploy/sikrit-keypair.json` (keypair program ID `FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F`) — dibutuhkan untuk deploy pertama ke devnet.

## Devnet

Program ter-deploy di devnet sejak 1 Okt 2026, di-upgrade ke protokol v2 pada 2 Okt 2026 (slot 506354888; byte on-chain =
`target/deploy/sikrit.so`, sha256 `aa574a1d…`; IDL on-chain = `target/idl/sikrit.json`):
[`FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F`](https://explorer.solana.com/address/FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F?cluster=devnet)
(ProgramData `9W3hXq1MCz8ZKL7D9o3Do6xWb5aYUa3kNsK6TzUs42Jp`, ruang 480.000 byte untuk upgrade, upgrade authority
`FNNYNGG688Y2wp2Nnb7K37ZsBTBF2HAFVFSxUh8iVd5N` — lihat R4 di security review). `solana config` global di mesin dev
menunjuk mainnet-beta, jadi **selalu tulis `-u devnet`**.

```bash
# upgrade setelah `npm run build` (keypair program ID di target/deploy/, gitignored)
solana program deploy -u devnet --use-rpc --keypair ~/.config/solana/id.json \
  --program-id target/deploy/sikrit-keypair.json target/deploy/sikrit.so

# bukti byte on-chain == build lokal (sisa ProgramData adalah padding nol)
solana program dump -u devnet FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F /tmp/onchain.so
head -c "$(stat -c%s target/deploy/sikrit.so)" /tmp/onchain.so | sha256sum; sha256sum target/deploy/sikrit.so

# IDL Anchor on-chain (akun GbTdbmEG2ufQD2AL23uC62CxJQR5pZYzaoUBzWj22ie5): explorer mendekode instruksi SIKRIT.
# Setelah IDL berubah: `idl upgrade` (bukan `idl init`, yang hanya bisa sekali)
npx anchor idl upgrade -f target/idl/sikrit.json FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F --provider.cluster devnet
npx anchor idl fetch FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F --provider.cluster devnet   # cek

# seluruh cerita demo lewat bundle produksi (CSP ketat) melawan devnet, ~4 menit, ~0,004 SOL
cd app && npm run e2e:devnet
```

`npm run e2e:devnet` mendanai relayer run itu 0,1 SOL dari `FUND_RELAYER_FROM` (default `~/.config/solana/id.json`)
karena faucet publik devnet menolak top-up dari browser, lalu mengembalikan sisanya. Sejak protokol v2 app tidak
memakai `getProgramAccounts` sama sekali (heir/guardian mengenal kapsulnya dari kit; satu `getMultipleAccounts` per
polling 15 s, berhenti saat tab tersembunyi), tapi RPC publik devnet tetap membatasi laju: untuk demo publik yang ramai,
build dengan `VITE_RPC_URL=<RPC khusus>`.

**Kalau upgrade gagal `Max retries exceeded`** (2 Okt 2026: RPC publik menjawab HTTP 429 "Too many requests from your
IP"; `--use-rpc` menembakkan ~400 transaksi tulis sekaligus dan hanya 15 chunk masuk dalam 12 menit), tulis buffer
dengan laju terkendali lalu upgrade dari buffer itu (~6 menit, ~0,002 SOL fee; rent buffer kembali saat upgrade):

```bash
solana-keygen new --no-bip39-passphrase --silent -o .keys/upgrade-buffer.json   # gitignored
# buat buffer (kalau belum ada), isi chunk yang belum ada ±3 tx/detik, ulang sampai buffer = file byte per byte;
# aman dijalankan ulang (atau beri alamat buffer yatim untuk melanjutkannya):
(cd app && node scripts/write-buffer.mjs ../target/deploy/sikrit.so ../.keys/upgrade-buffer.json)
solana program deploy -u devnet --keypair ~/.config/solana/id.json \
  --program-id FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F --buffer .keys/upgrade-buffer.json
# buffer yatim dari percobaan gagal (rent ~2 SOL masing-masing):
solana program show -u devnet --buffers --keypair ~/.config/solana/id.json
solana program close -u devnet --buffers --keypair ~/.config/solana/id.json
```

Jangan `pkill -f <pola>` untuk menghentikan proses ini: pola itu juga cocok dengan command line shell yang menjalankan
`pkill` dan ikut membunuhnya. Pakai PID (`pgrep -f …` lalu `kill <pid>`).

## Relayer service (`app/api/relay.ts`)

Semua fee (dan rent kapsul baru) dibayar relayer, bukan wallet pemilik. App mencari relayer service di `api/relay`
(relatif terhadap halaman) satu kali per load; kalau tidak ada yang menjawab JSON, app memakai relayer in-browser
(kunci demo di localStorage, top-up dari faucet), misalnya di GitHub Pages.

| Tempat | Relayer |
|---|---|
| `npm run localnet` / `npm run e2e` (`vite dev`) | service, kunci baru tiap start, otomatis diisi faucet localnet |
| `npm run e2e:devnet` (`vite preview`) | service, kunci baru didanai 0,1 SOL dari wallet loop lalu di-sweep; `RELAYER=browser` → in-browser |
| Vercel (Root Directory `app`) | service: function `api/relay.ts`, kunci dari env `RELAYER_SECRET_KEY` |
| GitHub Pages | in-browser (tidak ada function) — pengunjung butuh SOL devnet dari faucet |

Kebijakan tanda tangan (tepat satu instruksi SIKRIT, relayer hanya fee payer + payer rent `create_capsule`, semua
tanda tangan lain diverifikasi, preflight aktif, batas per IP) dan risikonya ada di security review §7. Env server:
`RELAYER_SECRET_KEY` (array JSON seperti keluaran `solana-keygen`, **jangan** diberi prefiks `VITE_`), `RPC_URL`
(opsional; default RPC publik devnet — RPC privat aman di sini karena tidak pernah sampai ke browser).

Catatan: `vite.config.ts` mengimpor `api/relay.ts`, jadi mengedit file itu me-restart dev server (dan me-reload
halaman). Jangan mengeditnya saat E2E berjalan.

## Biaya compute (LiteSVM, binary SBF asli)

| Instruksi | Compute units |
|---|---|
| `create_capsule` | ~68–72k (bergantung pencarian bump PDA) |
| `heartbeat` | ~41,4k (verifikasi Schnorr + cek masa berlaku) |
| `trigger_claim` / `guardian_veto` | ~7,6k |
| `guardian_confirm` / `claim` | ~8–8,3k (membuka komitmen anggota: SHA-256 syscall) |

Semua di bawah budget default 200k CU. Verifikasi yang sama dengan curve25519-dalek murni di SBF gagal (melebihi batas 1,4 jt CU / stack access violation) — detail di SIK-03.

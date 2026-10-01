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

## Biaya compute (LiteSVM, binary SBF asli)

| Instruksi | Compute units |
|---|---|
| `create_capsule` | ~68–74k (bergantung pencarian bump PDA) |
| `heartbeat` | ~41k |
| `trigger_claim` / `guardian_confirm` / `guardian_veto` / `claim` | ~7k |

Semua di bawah budget default 200k CU. Verifikasi yang sama dengan curve25519-dalek murni di SBF gagal (melebihi batas 1,4 jt CU / stack access violation) — detail di SIK-03.

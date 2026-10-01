# 🪦 SIKRIT — Privacy-Preserving Dead Man's Switch on Solana

> **"Jangan bawa rahasiamu ke liang kubur — tapi jangan biarkan dunia tahu kamu masih di sini."**

SIKRIT adalah protokol warisan digital pertama di mana **liveness si pemilik tidak bisa ditautkan ke identitasnya**. Pemilik membuktikan "masih hidup" lewat **Zero-Knowledge Proof** (Schnorr proof-of-knowledge) — tanpa membocorkan siapa pemiliknya atau wallet mana yang dipakai. Ketika pemilik tiada, kapsul rahasia (seed phrase / key / dokumen) dilepaskan ke ahli waris secara trustless.

**Solana Radar Hackathon 2026 — Track: Public Goods / Consumer Apps**

---

## Ringkasan Singkat

| Aspek | Detail |
|---|---|
| **Masalah** | >$100 miliar aset kripto mati permanen karena pemilik wafat tanpa menyerahkan akses |
| **Tegangan** | Ahli waris harus bisa akses kalau kamu tiada — tapi JANGAN PERNAH bisa akses selama kamu hidup |
| **Solusi** | Privacy-preserving dead man's switch di Solana (Shamir SSS + ZK proof-of-liveness + guardian network) |
| **Differentiator** | Satu-satunya protokol di mana **heartbeat tidak bocor** (semua pesaing bocor liveness di-chain) |
| **Ekonomi** | Heartbeat mingguan ~$0.0001; tanpa token spekulatif; fee dari release saja |

---

## Dokumen

- 📄 **[docs/PITCH.md](docs/PITCH.md)** — Narasi lengkap, competitive landscape, positioning, strategi menang.
- 🔧 **[docs/TECHNICAL-SPEC.md](docs/TECHNICAL-SPEC.md)** — Arsitektur, instruksi Anchor, threat model, milestone.
- 🛡️ **[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)** — Self-audit program: 11 temuan, perbaikan, protokol Fiat–Shamir final, risiko residual.

---

## Status

- [x] Gap research & competitive analysis (Sarcophagus, Serenity, Deadhand, BitLegacy, Kaspa Safe)
- [x] Positioning & differentiator final (ZK proof-of-liveness)
- [x] Anchor program + security review (anti-replay, guardian N-of-M, veto terbatas, PDA tanpa identitas)
- [x] Schnorr PoK: verifier on-chain via syscall curve25519 + prover TypeScript (`sdk/liveness.ts`)
- [x] Test suite lifecycle lengkap (35 test LiteSVM + 10 unit test Rust)
- [x] SDK kriptografi client: HPKE RFC 9180 (X25519 + ChaCha20-Poly1305), Shamir GF(2^8) teraudit, capsule kit dengan inbox certificate + release share oleh guardian setelah `Claimed` (23 test, known-answer vector RFC 9180 & FIPS-197)
- [x] Frontend demo (`app/`, Vite + React + wallet adapter): Create Capsule → Owner Dashboard (ZK heartbeat + inspector "what the chain sees") → Heir Claim Portal → Guardian console, mode demo interval 1 menit
- [x] E2E browser test (`npm run e2e` di `app/`): seluruh cerita warisan di Chrome melawan validator lokal + cek on-chain bahwa wallet pemilik tidak muncul di transaksi kapsul mana pun
- [ ] Deploy devnet (menunggu SOL devnet, faucet publik rate-limited)
- [ ] Pitch deck + video

**Deadline submit:** 12 Oktober 2026

---

## Development

### Struktur

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

### Toolchain (ter-pin, mengikuti CI resmi Anchor v0.30.2)

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

### Demo app (localnet)

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

### Biaya compute (LiteSVM, binary SBF asli)

| Instruksi | Compute units |
|---|---|
| `create_capsule` | ~68–74k (bergantung pencarian bump PDA) |
| `heartbeat` | ~41k |
| `trigger_claim` / `guardian_confirm` / `guardian_veto` / `claim` | ~7k |

Semua di bawah budget default 200k CU. Verifikasi yang sama dengan curve25519-dalek murni di SBF gagal (melebihi batas 1,4 jt CU / stack access violation) — detail di SIK-03.

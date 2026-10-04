# SIKRIT Developer & AI Context (CLAUDE.md)

Ini adalah panduan utama saat bekerja di repository **SIKRIT** menggunakan Claude Code / Cursor / CLI agents.

## 🚨 Hackathon Mission
- **Event:** Colosseum **Crypto World's Fair** 2026 (bukan "Radar", itu 2024; lihat `docs/RESEARCH.md` §1)
- **Deadline:** 12 Oktober 2026 23.59 PT (= 13 Okt 13.59 WIB)
- **Target:** Solana track (10 × $10k) + **University Award ($5k)** + Public Goods Award ($5k) + top-20 ($15k)
- **Author Profile:** Muhammad Ghani Nurramdhan (Mahasiswa Tk 4 Poltek SSN - Kriptografi & Cyber Security)
- **Key Reference:** Baca `docs/RESEARCH.md` (fakta event & kompetitor terverifikasi), `docs/PITCH.md`, `docs/TECHNICAL-SPEC.md` sebelum mulai menulis kode. `docs/HACKATHON-CONTEXT.md` berisi konteks awal — kotak "fakta terverifikasi" di atasnya menang bila bertentangan.

---

## 🎯 Core Architecture & Differentiator
SIKRIT adalah **Privacy-Preserving Dead Man's Switch on Solana**.
1. **Shamir's Secret Sharing (SSS) + ECIES:** Client-side split & encryption of seed phrases / credentials.
2. **ZK Proof-of-Liveness (Schnorr Identification Protocol):** Mengirim heartbeat on-chain TANPA menautkan wallet/identitas pemilik (waktu heartbeat tetap publik, R1). Tidak ada dari 11 kompetitor yang diperiksa (`docs/RESEARCH.md` §2, termasuk DeathClock yang juga pakai ZK) yang menyembunyikan identitas pemilik.
3. **Anchor Framework on Solana:** Biaya murah (5.000 lamport ≈ $0,001 per heartbeat, ~41k CU), non-custodial, zero token dependency.
4. **Protokol v2 — roster tersegel + bukti berumur pendek:** ahli waris & guardian on-chain hanya komitmen bergaram `SHA-256("SIKRIT:member:v1" ‖ P ‖ role ‖ wallet ‖ salt)` (salt di kit), terbuka saat anggota itu sendiri bertindak (SIK-19); bukti heartbeat terikat `expires_at` ≤ 1 jam (SIK-20).
5. **Protokol v2.1 — `update_capsule`:** pemilik mengganti ahli waris, guardian, kuorum & timer (kit baru) dengan bukti Schnorr domain `SIKRIT:update:v1` atas `nonce ‖ expires_at ‖ Borsh(config)`, tanpa signer; ditolak setelah `Claimed`. Share yang sudah dibagikan tidak bisa ditarik (R19).

---

## 🛠️ Tech Stack
- **Smart Contract:** Solana Rust + Anchor Framework (`0.30.1`; CLI `0.30.2` via npm `@anchor-lang/cli`, Solana CLI `1.18.17`)
- **Crypto Libs:** syscall curve25519 Solana (operasi titik on-chain), `curve25519-dalek` (aritmetika skalar + backend unit test), `sha2`
- **Frontend / Client:** Next.js / Vite React + Tailwind CSS + `@solana/web3.js` + `@solana/wallet-adapter-react`

---

## 📋 Project Directory Structure
```
SIKRIT/
├── CLAUDE.md                 <-- (File ini: instruksi developer & AI)
├── README.md                 <-- Overview singkat proyek
├── Anchor.toml               <-- Konfigurasi Anchor
├── Cargo.toml / Cargo.lock   <-- Workspace + lockfile ter-pin (kompatibel toolchain Solana 1.18)
├── .cargo/config.toml        <-- Paksa backend serial curve25519-dalek untuk build host (IDL)
├── docs/
│   ├── HACKATHON-CONTEXT.md  <-- Profil juri, hadiah, kriteria penilaian
│   ├── PITCH.md              <-- Narasi pitch, competitive table, selling point
│   ├── TECHNICAL-SPEC.md     <-- Detail instruksi smart contract & state machine
│   ├── SECURITY-REVIEW.md    <-- Self-audit: temuan, perbaikan, protokol Fiat–Shamir, risiko residual
│   └── SECURITY-REVIEW.en.md <-- Edisi Inggris untuk juri (ringkas, setia ke versi Indonesia — ubah keduanya bersamaan)
├── programs/
│   └── sikrit/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs        <-- Core Anchor Program logic + unit test Rust
├── sdk/
│   ├── README.md             <-- Panduan integrasi (wallet, relayer, watcher); snippet di-typecheck terhadap SDK
│   ├── liveness.ts           <-- Prover Schnorr (TS), identik byte-per-byte dengan verifier on-chain
│   ├── hpke.ts               <-- HPKE RFC 9180 (X25519/HKDF-SHA256/ChaCha20-Poly1305)
│   ├── shamir.ts             <-- Wrapper Shamir GF(2^8) (library teraudit)
│   ├── kit.ts                <-- Capsule kit: DEK + Shamir + HPKE ke inbox heir/guardian, release, recovery
│   └── client.ts             <-- Client program ringan (instruksi, decoder, discovery), cocok byte-per-byte dgn Anchor
├── app/                      <-- Frontend demo Vite + React + Tailwind v4 + wallet adapter (import @sdk/*)
│   ├── src/pages/            <-- Home, Owner (create + dashboard), Heir, Guardian, Capsule (public view)
│   ├── api/relay.ts          <-- Relayer service (Vercel function; di-mount vite dev/preview): fee hanya untuk 1 instruksi SIKRIT
│   ├── scripts/localnet.mjs  <-- `npm run localnet`: validator + program + dev server
│   ├── scripts/devnet-e2e.mjs <-- `npm run e2e:devnet`: bundle produksi + relayer service melawan program di devnet
│   └── e2e/demo-flow.mjs     <-- `npm run e2e`: seluruh cerita demo di Chrome + cek privasi on-chain
└── tests/
    ├── sikrit.ts             <-- Test lifecycle kapsul di LiteSVM (time-travel)
    └── sdk.ts                <-- Test SDK (vector RFC 9180, FIPS-197, serangan pada kit)
```

---

## 🧰 Dev Commands & Gotchas
- PATH: `export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"` (rustup & Solana CLI terpasang user-local, `.zshrc` tidak diubah).
- `npm run build` (anchor build) → `npm run test:rust` → `npm test` → `npm run typecheck`.
- **Test wajib Node 24** (`.nvmrc`): LiteSVM crash `std::bad_alloc` di Node 22 (litesvm#171).
- Pesan `Stack offset ... exceeded` dari `NafLookupTable8` saat build itu wajar (kode dalek tak terpakai, dieliminasi LTO). Jangan pindahkan operasi titik ke curve25519-dalek on-chain: terbukti melebihi 1,4 jt CU / stack access violation.
- Format transkrip Fiat–Shamir (`SIKRIT:liveness:v2`, context `nonce ‖ expires_at`; `SIKRIT:update:v1`, context `nonce ‖ expires_at ‖ Borsh(config)`) dan komitmen anggota (`SIKRIT:member:v1`) dikunci oleh known-answer vector di `tests/sikrit.ts` dan unit test Rust — ubah keduanya bersamaan.
- Format kit (domain `SIKRIT:*:v1`, derivasi inbox key, hash share) dikunci vector di `tests/sdk.ts`; ubah = naikkan versi kit.
- Kustodi share: share 0 → heir, share 1+g → guardian g, k − 1 = kuorum guardian. Guardian hanya release setelah `Claimed` ke inbox yang disertifikasi ahli waris yang dikomit (wallet + salt di kit membuka `heir_commitment`, dan sama dengan `heir` yang tercatat saat claim; lihat SIK-11/12/19). Tidak ada discovery kapsul by wallet: heir/guardian mengenal kapsulnya dari kit.
- Relayer: `app/api/relay.ts` (ESM, dimuat Node 24 secara native di test; ts-node mengabaikan `app/api/`). `vite.config.ts` mengimpornya, jadi mengedit file itu me-restart dev server + reload halaman — jangan saat E2E berjalan.
- App: `cd app && npm run localnet` lalu `npm run e2e` (butuh Chrome di `CHROME_PATH`, default `/usr/bin/google-chrome`; ~2,5 menit karena timer minimum program 60 s). Komponen per-kapsul di halaman Guardian/Heir WAJIB di-key per actor (beberapa guardian berbagi kapsul — state bocor antar persona pernah jadi bug).

---

## ⚡ Next Priorities for Claude Code
1. ~~Buat dan lengkapi `programs/sikrit/src/lib.rs` sesuai spesifikasi~~ ✅ (lihat `docs/SECURITY-REVIEW.md`)
2. ~~Pastikan logika verifikasi ZK Schnorr proof bekerja di Rust~~ ✅ (syscall curve25519, ~41k CU)
3. ~~Siapkan unit tests~~ ✅ (79 test TS: LiteSVM + SDK + client + relayer; 14 unit test Rust; E2E browser localnet + devnet)
4. ~~Inisialisasi frontend dashboard untuk demo flow~~ ✅ (`app/`, E2E Chrome hijau; heartbeat dikirim relayer, bukan wallet pemilik)
5. ~~M2: enkripsi share + custody share lewat guardian (SIK-11)~~ ✅ (`sdk/kit.ts`)
6. ~~Deploy devnet~~ ✅ 1 Okt 2026 (`FJKqf…Tc45F`, byte on-chain = build lokal; `cd app && npm run e2e:devnet` hijau). Upgrade: lihat `docs/DEVELOPMENT.md` §Devnet (RPC publik 429 → `app/scripts/write-buffer.mjs`).
7. ~~Protokol v2 (roster tersegel + bukti berumur pendek, SIK-19/20)~~ ✅ di devnet sejak 2 Okt 2026 (slot 506354888, IDL on-chain ikut di-upgrade).
8. ~~Protokol v2.1 (`update_capsule`, pemilik mengganti ahli waris/guardian/aturan)~~ ✅ di devnet sejak 4 Okt 2026 (slot 507248087, sha256 `f79790ae…`, IDL ikut di-upgrade).

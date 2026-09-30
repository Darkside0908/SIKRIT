# SIKRIT Developer & AI Context (CLAUDE.md)

Ini adalah panduan utama saat bekerja di repository **SIKRIT** menggunakan Claude Code / Cursor / CLI agents.

## 🚨 Hackathon Mission
- **Event:** Colosseum Solana Radar Hackathon 2026
- **Deadline:** 12 Oktober 2026 (~12 hari)
- **Target Category:** Consumer Apps / Public Goods + **University Award ($10,000 USDC)**
- **Author Profile:** Muhammad Ghani Nurramdhan (Mahasiswa Tk 4 Poltek SSN - Kriptografi & Cyber Security)
- **Key Reference:** Baca `docs/HACKATHON-CONTEXT.md`, `docs/PITCH.md`, dan `docs/TECHNICAL-SPEC.md` sebelum mulai menulis kode.

---

## 🎯 Core Architecture & Differentiator
SIKRIT adalah **Privacy-Preserving Dead Man's Switch on Solana**.
1. **Shamir's Secret Sharing (SSS) + ECIES:** Client-side split & encryption of seed phrases / credentials.
2. **ZK Proof-of-Liveness (Schnorr Identification Protocol):** Mengirim heartbeat on-chain TANPA membocorkan metadata/identitas pemilik. Ini celah fatal dari kompetitor (Sarcophagus, Serenity, Deadhand).
3. **Anchor Framework on Solana:** Biaya murah (~$0.0001 per heartbeat), non-custodial, zero token dependency.

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
│   └── SECURITY-REVIEW.md    <-- Self-audit: temuan, perbaikan, protokol Fiat–Shamir, risiko residual
├── programs/
│   └── sikrit/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs        <-- Core Anchor Program logic + unit test Rust
├── sdk/liveness.ts           <-- Prover Schnorr (TS), identik byte-per-byte dengan verifier on-chain
└── tests/sikrit.ts           <-- Test lifecycle kapsul di LiteSVM (time-travel)
```

---

## 🧰 Dev Commands & Gotchas
- PATH: `export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"` (rustup & Solana CLI terpasang user-local, `.zshrc` tidak diubah).
- `npm run build` (anchor build) → `npm run test:rust` → `npm test` → `npm run typecheck`.
- **Test wajib Node 24** (`.nvmrc`): LiteSVM crash `std::bad_alloc` di Node 22 (litesvm#171).
- Pesan `Stack offset ... exceeded` dari `NafLookupTable8` saat build itu wajar (kode dalek tak terpakai, dieliminasi LTO). Jangan pindahkan operasi titik ke curve25519-dalek on-chain: terbukti melebihi 1,4 jt CU / stack access violation.
- Format transkrip Fiat–Shamir dikunci oleh known-answer vector di `tests/sikrit.ts` dan unit test Rust — ubah keduanya bersamaan.

---

## ⚡ Next Priorities for Claude Code
1. ~~Buat dan lengkapi `programs/sikrit/src/lib.rs` sesuai spesifikasi~~ ✅ (lihat `docs/SECURITY-REVIEW.md`)
2. ~~Pastikan logika verifikasi ZK Schnorr proof bekerja di Rust~~ ✅ (syscall curve25519, ~41k CU)
3. ~~Siapkan unit tests~~ ✅ (35 test LiteSVM + 10 unit test Rust)
4. Inisialisasi frontend dashboard untuk demo flow — pakai `sdk/liveness.ts`; heartbeat dikirim fee payer burner/relayer, bukan wallet pemilik.
5. M2: enkripsi share (ECIES) + custody share lewat guardian (SIK-11), lalu deploy devnet.

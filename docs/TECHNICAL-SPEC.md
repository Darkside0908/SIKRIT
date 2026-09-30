# SIKRIT — Technical Specification (v0.1)

> Spesifikasi teknis MVP untuk Solana Radar Hackathon. Fokus: **Privacy-Preserving Dead Man's Switch** di Solana.

---

## 1. Ringkasan Arsitektur

```
[Owner]                     [SIKRIT Program (Anchor)]              [Heir / Guardian]
   |                                 |                                    |
   |-- create_capsule (Shamir N,M) ->|                                    |
   |-- heartbeat (Schnorr PoK) ----->|  (tanpa reveal identitas/alamat)   |
   |                                 |<-- claim_window opens -------------|-- claim()
   |                                 |<-- guardian veto ------------------|-- veto()
```

- **On-chain (Solana/Anchor):** vault state, timer, claim/veto logic, verifikasi Schnorr proof.
- **Off-chain (client-side):** Shamir Secret Sharing, enkripsi share ke pubkey heir, generate Schnorr proof.
- **Storage:** share terenkripsi di Arweave/IPFS (off-chain); on-chain hanya simpan hash & commitment.

---

## 2. Komponen On-Chain (Anchor Program)

### 2.1 State: `Capsule`

```rust
// PDA = ["capsule", commitment] — tidak ada field owner / wallet pemilik.
pub struct Capsule {
    pub commitment: [u8; 32],    // kunci publik liveness P = x·G (juga seed PDA)
    pub heir: Pubkey,            // ahli waris
    pub guardians: Vec<Pubkey>,  // daftar guardian (maks 5)
    pub guardian_threshold: u8,  // threshold guardian (N-of-M)
    pub approvals: u8,           // bitmap persetujuan guardian (1 suara per guardian)
    pub vetoes: u8,              // bitmap veto terpakai sejak heartbeat terakhir
    pub heartbeat_interval: i64, // interval heartbeat (detik)
    pub grace_period: i64,       // window veto/pembatalan setelah trigger
    pub last_heartbeat: i64,     // timestamp heartbeat terakhir
    pub claim_triggered_at: i64,
    pub heartbeat_nonce: u64,    // counter anti-replay yang diikat ke setiap bukti
    pub share_hashes: Vec<[u8; 32]>, // hash dari share terenkripsi (verifikasi integritas)
    pub status: CapsuleStatus,   // Active | ClaimPending | Claimed
    pub bump: u8,
}
```

### 2.2 Instructions

| Instruction | Deskripsi | Keamanan |
|---|---|---|
| `create_capsule` | Inisialisasi vault + register heir + guardian + parameter timer | proof-of-possession Schnorr atas seluruh config; `payer` bebas (tidak disimpan); commitment wajib titik berorde prima |
| `heartbeat` | Submit Schnorr proof-of-knowledge → reset `last_heartbeat`, `heartbeat_nonce + 1`; saat `ClaimPending` membatalkan klaim | verifikasi proof terikat nonce; TANPA signer (bisa di-relay siapa pun) |
| `trigger_claim` | Siapa pun memanggil setelah timeout → `ClaimPending` | cek `clock.unix_timestamp - last_heartbeat >= heartbeat_interval` |
| `claim` | Heir menarik kapsul (share) setelah grace period | heir signer + grace lewat + approvals ≥ threshold |
| `guardian_confirm` | Guardian mem-vouch pelepasan | guardian signer, satu suara per guardian (bitmap) |
| `guardian_veto` | Guardian membatalkan klaim (anti-false-trigger), pemilik dapat satu interval penuh | guardian signer, hanya dalam grace period, satu veto per guardian sampai pemilik heartbeat lagi |

### 2.3 ZK Proof-of-Liveness (Schnorr)

- **Tujuan:** buktikan pemilik masih memegang kunci privat, **tanpa** reveal identitas/wallet (waktu heartbeat tetap terlihat publik).
- **Skema:** Schnorr identification protocol (Σ-protocol) → non-interaktif via Fiat-Shamir.
  - Prover (owner) membuktikan pengetahuan atas `x` (secret) di mana `P = x·G` (commitment publik tersimpan di kapsul).
  - Challenge: `e = SHA-512(domain ‖ program_id ‖ capsule ‖ P ‖ R ‖ context) mod ℓ`, dengan `domain = "SIKRIT:liveness:v1"` dan `context = heartbeat_nonce` (anti-replay), atau `"SIKRIT:register:v1"` + `Borsh(CapsuleConfig)` untuk proof-of-possession saat `create_capsule`.
  - Verifier (program) cek `s·G − e·P == R` memakai syscall curve25519 Solana (~41k CU per heartbeat).
  - Detail & alasan desain: `docs/SECURITY-REVIEW.md`.
- **Mengapa Schnorr, bukan Groth16:** ringan, implementable on-chain dalam waktu 12 hari, tetap ZK secara kriptografis (tidak bocor `x`).
- **Upgrade path (v2):** Groth16 / PLONK untuk full ZK-SNARK liveness + privasi penuh timestamp.

---

## 3. Komponen Off-Chain (Client-Side)

### 3.1 Shamir Secret Sharing (SSS)

- **Threshold:** `(k, n)` — misal `(2, 3)`.
- **Distribusi share:**
  - **Share A:** disimpan owner (device).
  - **Share B:** dienkripsi ke pubkey heir → dikirim ke heir.
  - **Share C:** dienkripsi → disimpan di Arweave/IPFS (inert tanpa share lain).
- **Rekonstruksi:** heir butuh `k` share (B + C) untuk recover seed.

### 3.2 Enkripsi Share

- **Algoritma:** ECIES (Elliptic Curve Integrated Encryption Scheme) atau X25519 + AES-256-GCM.
- **Kunci:** public key ahli waris (dan/atau guardian) — hanya holder private key terkait yang bisa decrypt.

### 3.3 Generate Schnorr Proof (WASM)

- Modul Rust di-compile ke WASM, jalan di browser.
- Owner menandatangani challenge non-interaktif dengan private key; output `(R, s)` di-submit ke `heartbeat`.

---

## 4. Data Flow Lengkap (Lifecycle)

1. **Setup:** Owner split seed → SSS → enkripsi share → publish `create_capsule` (commitment + hash).
2. **Alive:** Owner `heartbeat` tiap interval (Schnorr PoK) → timer reset, **tanpa bocor metadata**.
3. **Timeout:** owner berhenti heartbeat → siapa pun `trigger_claim` → `claim_window` terbuka.
4. **Guardian:** N-of-M `guardian_confirm` (atau `veto` kalau false-trigger).
5. **Claim:** Heir `claim` → ambil share terenkripsi dari Arweave → decrypt → gabung SSS → recover.

---

## 5. Threat Model & Mitigasi

| Ancaman | Mitigasi |
|---|---|
| Drainer / phishing transaksi | Tidak ada nilai tersimpan on-chain; hanya hash/commitment. Share di Arweave terenkripsi. |
| Stalker lacak "kapan terakhir check-in" | Schnorr PoK — heartbeat tidak reveal identitas/alamat/timestamp. |
| False-trigger (owner masih hidup) | Guardian veto + grace period. |
| Server mati (single point of failure) | Tidak ada server kritis; Arweave permanen + program on-chain. |
| Share bocor | Enkripsi ECIES; satu share bocor = zero information (SSS). |
| Double-claim | State `Claimed` + PDA map mencegah klaim ganda. |

---

## 6. Stack & Dependensi

- **Program:** Rust + Anchor (Solana)
- **Kriptografi:** `sha2`, `curve25519-dalek` (Schnorr), `shamir` / custom SSS, `aes-gcm`
- **Frontend:** Next.js (React) + `@solana/web3.js` / `@solana/wallet-adapter`
- **Storage:** Arweave (via Bundlr/Irys) atau IPFS
- **ZK WASM:** Rust → `wasm-bindgen` / `wasm-pack`

---

## 7. Milestone Teknis (MVP)

1. **M1 — Program Core:** `create_capsule`, `heartbeat`, `trigger_claim`, `claim` di devnet + unit test.
2. **M2 — Kriptografi:** SSS + ECIES + Schnorr PoK (WASM) + integrasi ke program.
3. **M3 — Frontend:** flow setup → heartbeat dashboard → claim flow.
4. **M4 — E2E:** deploy devnet, simulasi "kematian" (stop heartbeat) → klaim sukses.
5. **M5 — Pitch:** deck + video 3 menit + demo live.

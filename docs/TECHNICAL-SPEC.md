# SIKRIT — Technical Specification (protokol v2)

> Spesifikasi teknis MVP untuk Colosseum Crypto World's Fair 2026. Fokus: **Privacy-Preserving Dead Man's Switch** di Solana.

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
- **Off-chain (client-side):** Shamir Secret Sharing, enkripsi share (HPKE) ke kunci inbox heir & guardian, generate Schnorr proof.
- **Storage:** kit terenkripsi dipegang para pihak (off-chain); on-chain hanya menyimpan hash share & commitment, termasuk komitmen bergaram atas ahli waris dan guardian (tidak ada wallet keluarga sampai anggota itu sendiri bertindak).

---

## 2. Komponen On-Chain (Anchor Program)

### 2.1 State: `Capsule`

```rust
// PDA = ["capsule", commitment] — tidak ada field owner / wallet pemilik, dan tidak ada wallet keluarga.
pub struct Capsule {
    pub commitment: [u8; 32],    // kunci publik liveness P = x·G (juga seed PDA)
    pub heir_commitment: [u8; 32],             // komitmen bergaram atas wallet ahli waris (§2.4)
    pub heir: Pubkey,                          // default sampai `claim` membuka komitmen; lalu wallet ahli waris
    pub guardian_commitments: Vec<[u8; 32]>,   // satu komitmen bergaram per slot guardian (maks 5)
    pub guardian_threshold: u8,  // threshold guardian (N-of-M)
    pub approvals: u8,           // bitmap persetujuan guardian per slot (1 suara per guardian)
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
| `create_capsule(commitment, config, proof)` | Inisialisasi kapsul: komitmen ahli waris & guardian, parameter timer, hash share | proof-of-possession Schnorr atas seluruh config; `payer` bebas (tidak disimpan); commitment wajib titik berorde prima |
| `heartbeat(proof, expires_at)` | Submit Schnorr proof-of-knowledge → reset `last_heartbeat`, `heartbeat_nonce + 1`; saat `ClaimPending` membatalkan klaim | verifikasi proof terikat nonce & masa berlaku (`now ≤ expires_at ≤ now + 3600`); TANPA signer (bisa di-relay siapa pun) |
| `trigger_claim` | Siapa pun memanggil setelah timeout → `ClaimPending` | cek `clock.unix_timestamp - last_heartbeat >= heartbeat_interval` |
| `claim(salt)` | Heir menarik kapsul setelah grace period; wallet-nya tercatat di `heir` | signer + salt membuka `heir_commitment`, grace lewat, approvals ≥ threshold |
| `guardian_confirm(slot, salt)` | Guardian mem-vouch pelepasan | signer + salt membuka komitmen di `slot`; satu suara per guardian (bitmap) |
| `guardian_veto(slot, salt)` | Guardian membatalkan klaim (anti-false-trigger), pemilik dapat satu interval penuh | seperti confirm, hanya dalam grace period, satu veto per guardian sampai pemilik heartbeat lagi |

### 2.3 ZK Proof-of-Liveness (Schnorr)

- **Tujuan:** buktikan pemilik masih memegang kunci privat, **tanpa** reveal identitas/wallet (waktu heartbeat tetap terlihat publik).
- **Skema:** Schnorr identification protocol (Σ-protocol) → non-interaktif via Fiat-Shamir.
  - Prover (owner) membuktikan pengetahuan atas `x` (secret) di mana `P = x·G` (commitment publik tersimpan di kapsul).
  - Challenge: `e = SHA-512(domain ‖ program_id ‖ capsule ‖ P ‖ R ‖ context) mod ℓ`, dengan `domain = "SIKRIT:liveness:v2"` dan `context = heartbeat_nonce (u64 LE) ‖ expires_at (i64 LE)` (anti-replay + bukti berumur pendek), atau `"SIKRIT:register:v2"` + `Borsh(CapsuleConfig)` untuk proof-of-possession saat `create_capsule`.
  - Verifier (program) cek `now ≤ expires_at ≤ now + 3600`, lalu `s·G − e·P == R` memakai syscall curve25519 Solana (~41k CU per heartbeat). App memberi masa berlaku 10 menit dari jam cluster, jadi relayer yang menahan bukti tidak bisa memakainya belakangan.
  - Detail & alasan desain: `docs/SECURITY-REVIEW.md` (SIK-01, SIK-20).
- **Mengapa Schnorr, bukan Groth16:** ringan, implementable on-chain dalam waktu 12 hari, tetap ZK secara kriptografis (tidak bocor `x`).
- **Upgrade path:** heartbeat di dalam anonymity set (bukti keanggotaan, Groth16/PLONK) agar waktu heartbeat tidak menunjuk satu kapsul (R1).

### 2.4 Roster tersegel (komitmen anggota)

```
c = SHA-256("SIKRIT:member:v1" ‖ P ‖ role ‖ wallet ‖ salt)      role 0 = ahli waris, 1 = guardian
salt ← 32 byte acak per anggota, dibuat pemilik saat sealing dan dibawa di kit (kit v2)
```

- Chain hanya menyimpan `heir_commitment` dan `guardian_commitments`. Salt 256 bit membuat komitmen tidak bisa ditebak
  dengan mencoba semua wallet Solana; `P` + salt per kapsul membuat orang yang sama tidak tertaut antar kapsul.
- Anggota membuka komitmennya sendiri saat bertindak: `guardian_confirm/veto(slot, salt)` dan `claim(salt)`, dengan
  wallet = signer transaksi. Salt yang terlihat di transaksi seorang guardian tidak berguna bagi orang lain.
- `claim` menyimpan wallet ahli waris di `heir`, tempat guardian mencocokkan tujuan release (harus sama dengan ahli
  waris yang dikomit di kit).
- Karena program tidak melihat wallet, aturan identitas (ahli waris bukan guardian, wallet berbeda) ditegakkan client
  saat sealing; program memeriksa bentuk komitmen (bukan nol, tidak ganda, komitmen ahli waris tidak dipakai guardian).
- Tidak ada pencarian kapsul berdasarkan wallet: ahli waris dan guardian mengenal kapsulnya dari kit.

---

## 3. Komponen Off-Chain (Client-Side) — `sdk/`

Semua kriptografi client ditulis dalam TypeScript murni di atas primitive teraudit (`@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `shamir-secret-sharing`), sehingga kode yang sama jalan di browser dan di test tanpa WASM. Setiap primitive dikunci known-answer vector eksternal di `tests/sdk.ts`.

### 3.1 Kunci yang dipakai

| Kunci | Pemilik | Diturunkan dari | Dipakai untuk |
|---|---|---|---|
| Liveness `x`, `P = x·G` | Pemilik | tanda tangan wallet atas `KEYGEN_MESSAGE` (`sdk/liveness.ts`) | heartbeat & proof-of-possession; `P` = seed PDA |
| Inbox X25519 | Ahli waris & tiap guardian | tanda tangan wallet atas `INBOX_MESSAGE` → HPKE `DeriveKeyPair` (`sdk/kit.ts`) | menerima share terenkripsi |
| Data key (DEK) 32 byte | — (acak, sekali pakai) | CSPRNG | mengenkripsi rahasia; yang di-split Shamir adalah DEK |

Tanda tangan Ed25519 deterministik (RFC 8032), jadi kunci bisa diturunkan ulang bertahun-tahun kemudian dari wallet yang sama tanpa backup. Onboarding (`createInbox`) meminta tanda tangan dua kali dan menolak wallet yang tanda tangannya tidak deterministik (sebagian wallet MPC).

### 3.2 Inbox certificate (anti key-substitution)

Ahli waris/guardian mengirim ke pemilik sebuah **invite** `sikrit-invite:v1:<hex(wallet ‖ inbox ‖ sig)>`, dengan `sig` = tanda tangan wallet atas `"SIKRIT inbox certificate v1: <hex inbox>"`. Pemilik memverifikasinya sebelum menyegel apa pun, dan wallet yang sama di-commit on-chain (komitmen bergaram, §2.4). Guardian memverifikasi sertifikat ahli waris terhadap wallet ahli waris yang dikomit (dan, setelah klaim, sama dengan `capsule.heir`) sebelum me-release share. Tanpa ini, penyerang yang menukar kunci inbox di jalur komunikasi (atau di file kit) bisa menerima share.

### 3.3 Capsule kit (`sdk/kit.ts`)

```
dek      ← 32 byte acak
payload  = nonce ‖ XChaCha20-Poly1305(dek, nonce, aad = "SIKRIT:payload:v1" ‖ P ‖ k ‖ n)(rahasia)
share_i  = Shamir k-of-n atas dek, GF(2^8)                      (33 byte: y ‖ x)
sealed_i = HPKE.Seal(inbox_i, info = "SIKRIT:share:v1" ‖ P, aad = i)(share_i)
hash_i   = SHA-256("SIKRIT:share-hash:v1" ‖ P ‖ share_i)  →  CapsuleConfig.share_hashes[i]
salt_i   ← 32 byte acak                                    →  komitmen anggota i (§2.4), CapsuleConfig.*_commitment(s)
```

- **HPKE** (RFC 9180, base mode): DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305 — bentuk terstandar dari "ECIES X25519". Diverifikasi byte-per-byte terhadap RFC 9180 Appendix A.2.1.
- **Shamir**: library `shamir-secret-sharing` (Privy; diaudit Cure53 & Zellic), polinomial AES `x⁸+x⁴+x³+x+1`. Yang di-split hanya DEK acak (rekomendasi library itu sendiri), sehingga share berukuran tetap dan tag AEAD payload mengautentikasi hasil rekonstruksi.
- **Hash share on-chain** ikut ditandatangani proof-of-possession `create_capsule` (bagian dari `Borsh(CapsuleConfig)`), jadi rantai autentikasinya: `x` → config → hash → share.

**Kustodi share (menjawab SIK-11):**

| Share | Pemegang | Keterangan |
|---|---|---|
| `share_0` | Ahli waris | sendirian < k → nol informasi (perfect secrecy) |
| `share_1..n−1` | Satu per guardian | `k − 1` = kuorum guardian (idealnya = `guardian_threshold` on-chain) |

Contoh: 3 guardian, `guardian_threshold = 2` → `k = 3`, `n = 4`. Ahli waris butuh share-nya sendiri + 2 share guardian. Tiga guardian bersama-sama juga bisa merekonstruksi (jalan pemulihan kalau ahli waris kehilangan wallet).

Kit v2 (JSON ~3 KB untuk seed phrase 12 kata + 3 guardian) dikirim off-chain ke semua pemegang. Kit tidak pernah ditaruh di storage publik permanen: ciphertext tidak ikut on-chain, hanya hash. Kit menyebut seluruh keluarga (wallet, sertifikat, salt), jadi hanya untuk para pemegang; kit yang bocor membuka roster, bukan rahasia.

### 3.4 Release & recovery

1. Semua pihak memverifikasi kit terhadap state on-chain (`verifyKit`): commitment, `share_hashes`, dan wallet + salt tiap pemegang membuka komitmen ahli waris/guardian on-chain, persis dan berurutan.
2. Setelah status `Claimed`, guardian membuka share-nya dan me-**re-seal** ke kunci inbox ahli waris (`releaseShare`, info `"SIKRIT:release:v1" ‖ P`). SDK menolak release jika kapsul belum `Claimed`, jika kit tidak cocok dengan chain, jika target tidak disertifikasi wallet ahli waris yang dikomit, jika chain melaporkan ahli waris lain, atau jika yang di-release bukan share guardian.
3. Ahli waris membuka tiap release (`openRelease`), mengautentikasi share terhadap hash yang ter-commit, lalu `recoverSecret` menggabungkan `k` share dan mendekripsi payload. Share palsu ditolak dengan pesan eksplisit, bukan menghasilkan rahasia yang salah diam-diam.

Urutan "release hanya setelah `Claimed`" adalah janji guardian yang dijalankan client, bukan paksaan kriptografis. Asumsi kepercayaan yang tersisa ditulis eksplisit: kuorum guardian tidak berkolusi dengan ahli waris sebelum pemilik wafat.

### 3.5 Generate Schnorr Proof

`sdk/liveness.ts` (TypeScript, `@noble/curves`) — tidak perlu WASM. Nonce di-hedge (deterministik atas `x` + transkrip + 32 byte acak). Format transkrip dikunci known-answer vector lintas bahasa (TS prover ↔ Rust verifier).

---

## 4. Data Flow Lengkap (Lifecycle)

1. **Onboarding:** ahli waris & guardian membuat inbox key dari wallet mereka dan mengirim invite bertanda tangan ke pemilik.
2. **Setup:** pemilik menurunkan kunci liveness dari wallet → `sealCapsuleKit` (rahasia → DEK → Shamir → HPKE ke tiap pemegang, salt per pemegang) → `create_capsule` (commitment + komitmen anggota + `share_hashes` + proof-of-possession), dibayar fee payer terpisah → kit dibagikan off-chain; dari kit itulah ahli waris dan guardian mengenal kapsulnya.
3. **Alive:** pemilik `heartbeat` tiap interval (Schnorr PoK berumur 10 menit, di-relay fee payer mana pun) → timer reset; tidak ada wallet/identitas pemilik maupun keluarganya di transaksi.
4. **Timeout:** pemilik berhenti heartbeat → siapa pun `trigger_claim` → grace period berjalan (pemilik masih bisa membatalkan dengan heartbeat).
5. **Guardian:** kuorum `guardian_confirm(slot, salt)` (atau `guardian_veto` kalau false-trigger); di sinilah guardian itu pertama kali terlihat on-chain.
6. **Claim:** ahli waris `claim(salt)` → status `Claimed`, wallet ahli waris tercatat.
7. **Release & recovery:** guardian melihat `Claimed` → re-seal share ke inbox ahli waris → ahli waris verifikasi hash → gabungkan → dekripsi rahasia.

---

## 5. Threat Model & Mitigasi

| Ancaman | Mitigasi |
|---|---|
| Drainer / phishing transaksi | Tidak ada nilai tersimpan on-chain; hanya hash/commitment. |
| Stalker menautkan heartbeat ke identitas | PDA dari kunci liveness khusus, tanpa field/signer wallet pemilik; heartbeat bisa di-relay. Waktu heartbeat tetap publik (R1 di security review). |
| Stalker menemukan kapsul lewat wallet keluarga (anak, notaris) | Roster tersegel: hanya komitmen bergaram on-chain, tidak tertaut antar kapsul; anggota terlihat hanya saat bertindak (SIK-19). |
| Replay bukti heartbeat | Challenge terikat `heartbeat_nonce`, kapsul, program, domain. |
| Relayer menahan bukti lalu memakainya setelah pemilik wafat | Bukti terikat `expires_at` ≤ 1 jam ke depan; app memberi 10 menit (SIK-20). |
| False-trigger (pemilik masih hidup) | Heartbeat membatalkan klaim sampai ahli waris `claim`; veto guardian terbatas dalam grace period. |
| Ahli waris membuka lebih awal | Ahli waris hanya memegang 1 share (< k); butuh kuorum guardian yang me-release setelah `Claimed`. |
| Kunci inbox ditukar penyerang (MITM) | Inbox certificate ditandatangani wallet heir/guardian yang dikomit on-chain; diverifikasi saat seal & release. |
| RPC jahat menyebut ahli waris lain | Tujuan release terikat ke ahli waris yang dikomit (wallet + salt di kit); laporan RPC yang berbeda ditolak. |
| Guardian jahat mengirim share palsu | Hash share on-chain (ditandatangani proof-of-possession pemilik) → share palsu ditolak sebelum digabung. |
| Server mati (single point of failure) | Tidak ada server: program on-chain + kit dipegang para pihak. |
| Share bocor | Share dienkripsi HPKE ke pemegangnya; < k share = nol informasi (Shamir). |
| Double-claim | State `Claimed` terminal. |

---

## 6. Stack & Dependensi

- **Program:** Rust + Anchor 0.30.1 (Solana 1.18.17); syscall curve25519 untuk operasi titik, `curve25519-dalek` untuk aritmetika skalar, `sha2`
- **SDK client:** `@noble/curves` (Ed25519/X25519), `@noble/hashes` (SHA-2, HKDF), `@noble/ciphers` (ChaCha20-Poly1305, XChaCha20-Poly1305), `shamir-secret-sharing`
- **Frontend:** React + `@solana/web3.js` / `@solana/wallet-adapter`
- **Transport kit:** file/tautan off-chain (MVP); opsional storage terenkripsi (Arweave/IPFS) di roadmap

---

## 7. Milestone Teknis (MVP)

1. **M1 — Program Core:** `create_capsule`, `heartbeat`, `trigger_claim`, `claim` di devnet + unit test. ✅
2. **M2 — Kriptografi:** SSS + HPKE + Schnorr PoK (TypeScript) + integrasi ke program. ✅
3. **M3 — Frontend:** flow setup → heartbeat dashboard → claim flow. ✅
4. **M4 — E2E:** deploy devnet, simulasi "kematian" (stop heartbeat) → klaim sukses. ✅ (browser, localnet + devnet)
5. **M5 — Pitch:** deck + 2 video (pitch + demo). Deck ✅, video oleh founder.
6. **M6 — Protokol v2:** roster tersegel + bukti heartbeat berumur pendek (SIK-19/20). ✅

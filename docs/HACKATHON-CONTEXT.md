# 🏆 HACKATHON CONTEXT — Colosseum Crypto World's Fair 2026

> ## ✅ Fakta terverifikasi (1 Okt 2026) — MENGGANTIKAN info di bawah bila bertentangan
>
> Diverifikasi dari *Official Rules* dan halaman resmi Colosseum; rincian + sumber di [`docs/RESEARCH.md`](RESEARCH.md) §1.
>
> - **Nama event:** Colosseum **Crypto World's Fair** (online, multi-chain). "Solana Radar" adalah hackathon 2024.
> - **Deadline:** **23.59 PT, 12 Okt 2026 = 13 Okt 2026 13.59 WIB.** Setiap anggota tim wajib register di colosseum.com.
> - **Hadiah:** Grand Champion $30k · 20 tim berikutnya $15k/tim · **University Award $5k** · **Public Goods Award $5k** ·
>   **Solana track $100k (10 × $10k)** · akselerator $250k pre-seed. Tidak ada track "Consumer Apps".
> - **Kriteria juri resmi (§8):** Functionality · Potential Impact (TAM) · Novelty · UX · Open-source/komposabilitas ·
>   Business Plan. Bobot 60/30/10 di bawah **tidak resmi**.
> - **Submission:** repo GitHub, **video pitch 2–3 menit** + **video demo ≤ 3 menit**, logo, latar belakang tim,
>   rencana go-to-market & validasi demand. Hanya pekerjaan 14 Sep–12 Okt 2026 yang dinilai.
> - **Juri:** tim Colosseum (Clay Robbins, Matty Taylor, Nate Levine, Max Monciardini, Michael Rinko) + 16 juri track
>   (antara lain Phantom, Solana Foundation). Daftar juri di §3 di bawah belum terverifikasi untuk event ini.
> - **Kompetitor baru:** DeathClock (Solana, entri event yang sama) memakai "ZK heartbeat" Groth16 yang **tetap
>   menautkan wallet pemilik**. Klaim "first ZK heartbeat" tidak boleh dipakai; klaim yang benar ada di PITCH.md §4.

---

*Konteks asli (ditulis sebelum verifikasi):*


Dokumen ini adalah **panduan konteks absolut** untuk AI Assistant / Claude Code yang melanjutkan pengerjaan proyek **SIKRIT**. Baca ini baik-baik sebelum menulis kode atau merancang presentasi.

---

## 1. Profil Kompetisi

- **Nama Event:** **Colosseum Solana Radar Hackathon 2026**
- **Platform:** Colosseum (Official accelerator & hackathon platform of Solana Foundation)
- **Deadline Submit:** **12 Oktober 2026** (Kritis! Sisa ~12 hari)
- **Total Prize Pool:** **$600,000+ USDC** + Peluang pendanaan **$2.5 Juta** dari Colosseum Venture Fund bagi tim yang lolos seleksi Accelerator (15 tim terpilih dapat $250k seed funding).
- **Struktur Hadiah per Kategori/Track:**
  - 🥇 Juara 1: $25,000 – $30,000 USDC
  - 🥈 Juara 2: $20,000 USDC
  - 🥉 Juara 3: $15,000 USDC
  - 🏅 Juara 4: $10,000 USDC
  - 🎖️ Juara 5: $5,000 USDC

---

## 2. Kategori Sasaran & "Unfair Advantage"

1. **Target Tracks:**
   - **Consumer Apps** (Aplikasi warisan digital / estate planning untuk retail Web3)
   - **Crypto Infrastructure / Public Goods** ($10k Public Goods Award)
2. **Special Bonus Award (SANGAT KRITIS):**
   - 🎓 **University Award — $10,000 USDC**
   - **Konteks Builder (Bang Igan):** Mahasiswa Tingkat 4 Politeknik Siber dan Sandi Negara (Poltek SSN), spesialisasi Rekayasa Perangkat Lunak Kripto (RPLK) / Cyber Security.
   - **Strategi:** Tonjolkan bahwa SIKRIT adalah karya riset mahasiswa terapan di bidang kriptografi (Shamir's Secret Sharing + Zero-Knowledge Proof of Liveness). Ini memberikan leverage sangat besar di mata juri untuk menyapu bersih University Award!

---

## 3. Dewan Juri & Profil Evaluator

Juri di Colosseum Radar berisi tokoh elit ekosistem Solana & Venture Capitalist:
- **Anatoly Yakovenko & Raj Gokal** (Co-founders Solana Labs)
- **Clay Robbins & Matty Taylor** (Co-founders Colosseum)
- **Mert Mumtaz** (Co-founder Helius)
- **Yurii Olentir** (Co-founder ITX Security Systems) & **David** (Founder Mad Shield) — *Juri spesialis cyber security & smart contract security yang sangat paham teknis kriptografi!*

---

## 4. Kriteria Penilaian (Judging Criteria)

1. **Problem Identification & Business Value (60%):**
   - Apakah masalahnya nyata? *YA: >$100 Miliar aset kripto terkunci permanen karena pemilik wafat.*
   - Seberapa defensible ide ini? *Lihat diferensiasi di bawah.*
2. **Presentation & Pitch Quality (30%):**
   - Pitch deck komprehensif, video demo jelas (maksimal 3 menit), narasi emosional ("Jangan bawa kuncimu ke liang kubur").
3. **Technical Execution & Web3 Implementation (10%):**
   - Smart contract Anchor yang aman, zero-knowledge/Schnorr verification, client-side encryption, clean code.

---

## 5. Inti Proyek: SIKRIT (*Privacy-Preserving Dead Man's Switch*)

### Apa Masalahnya?
Semua protokol warisan kripto yang ada saat ini (**Sarcophagus, Serenity Shield, Deadhand, BitLegacy, Kaspa Safe**) punya cacat fatal:
> **Heartbeat / Proof-of-Life mereka BOCOR di-chain secara publik!**  
> Setiap kali pemilik mengirim "check-in", siapapun di dunia tahu pemilik masih hidup/aktif. Ini menghancurkan privasi pemilik dan membahayakan keamanan fisik/finansialnya.

### Solusi Pembunuh SIKRIT:
1. **ZK Proof-of-Liveness (Schnorr Identification Protocol / Fiat-Shamir):**
   - Check-in pemilik dilakukan dengan membuktikan kepemilikan private key tanpa membocorkan identitas, saldo, atau metadata ke publik.
2. **Zero Custody, Zero Token Dump:**
   - Tidak butuh token spekulatif yang bisa crash (seperti SARCO di Sarcophagus).
   - Tidak ada master key tersimpan di server terpusat (lawan Deadhand).
   - Tidak butuh hardware biometrik eksklusif (lawan Serenity Shield).
3. **Shamir's Secret Sharing (SSS) + Client-side ECIES:**
   - Seed phrase dipecah menjadi *N* pecahan (shards). Pecahan dienkripsi ke public key ahli waris dan guardian.
4. **Solana-Native Economics:**
   - Biaya heartbeat mingguan hanya ~$0.0001, membuat dead man's switch on-chain pertama yang secara ekonomi masuk akal!

---

## 6. Deliverables Wajib untuk Hackathon (Submit 12 Okt 2026)

1. **Anchor Smart Contract (Devnet Deployed):**
   - `create_capsule`, `heartbeat` (verifikasi Schnorr), `trigger_claim`, `guardian_confirm`, `guardian_veto`, `claim`.
2. **Frontend Minimalist (React/Next.js):**
   - Setup capsule (input secret -> SSS split -> enkripsi).
   - Dashboard heartbeat (tombol "Send ZK Heartbeat").
   - Portal klaim ahli waris.
3. **Pitch Deck (PDF 8–10 slides).**
4. **Demo Video (Loom / YouTube, maksimal 3 menit).**
5. **Open Source GitHub Repo (Public).**

---

*Gunakan dokumen ini bersama dengan `docs/TECHNICAL-SPEC.md` dan `docs/PITCH.md` sebagai panduan mutlak pengembangan kode.*

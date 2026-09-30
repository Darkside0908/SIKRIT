# 🪦 SIKRIT — *Privacy-Preserving Dead Man's Switch*

> **Tagline:** "Jangan bawa rahasiamu ke liang kubur — tapi jangan biarkan dunia tahu kamu masih di sini."
> **One-liner:** Satu-satunya protokol warisan digital di mana **liveness si pemilik ikut terenkripsi** — dunia (termasuk guardian & ahli waris) tidak pernah tahu kamu masih hidup atau sudah tiada, sampai saatnya kapsul terbuka.

---

## 1. Masalah (Problem)

- **>$100 miliar** aset kripto mati permanen karena pemilik wafat tanpa menyerahkan akses ke keluarga. *(BitLegacy, Serenity, Deadhand semuanya mengutip angka ini sebagai motivasi — problem ter-validasi.)*
- Keluarga **MAU** mewariskan, tapi tidak ada cara **trustless**:
  - Serahkan ke custodian terpusat → *single point of failure* (bisa dicuri / dibekukan probate).
  - Tulis seed phrase di kertas → bisa hilang, bisa ketahuan orang.
- **Tegangan inti (the tension):** ahli waris harus bisa mengakses **kalau kamu sudah tiada**, tapi **JANGAN PERNAH** bisa mengakses selama kamu masih hidup.

Masalah ini emosional + finansial, bisa dicerna juri non-teknis dalam 5 detik.

---

## 2. Kenapa Semua yang Sudah Ada Gagal (Competitive Landscape)

| Proyek | Chain | Mekanisme | Kelemahan Fatal |
|---|---|---|---|
| **Sarcophagus** | Ethereum + Arweave | Archaeologist nodes + token SARCO | Butuh gas ETH + token; kalau harga SARCO crash, incentive node mati → kapsul terkunci selamanya |
| **Serenity Shield (SERSH)** | ETH/BNB/Secret Network | Shamir 3-NFT + biometrik | Butuh hardware wallet khusus + KYC + trust ke Secret Network |
| **Deadhand Protocol** | Server-assisted (bukan on-chain murni) | Shamir 2-of-3 + email heartbeat | Server pegang *master key* → masih ada titik kepercayaan; email heartbeat bisa gagal |
| **BitLegacy** | Stacks (Bitcoin L2) | Dead-man's switch + guardian 2-of-3 | Khusus sBTC; `check-in` on-chain **bocor metadata** siapa yang masih hidup |
| **Kaspa Safe** | Kaspa (PoW) | Covenant vault + checkin | `checkin` on-chain **bocor liveness**; niche chain Kaspa |

### Penyakit yang SAMA di semua pesaing 👇

> **Heartbeat / proof-of-life mereka BOCOR di-chain.**
> Setiap "check-in" on-chain secara publik menyatakan: *"alamat X masih hidup & aktif."*

Artinya semua proyek yang ada **mengorbankan privasi si pemilik** demi mekanisme warisan. Jika alamat diketahui, siapa pun bisa men-stalk kapan terakhir pemilik "check-in" → bocor info sensitif (sakit? hilang? lama tidak aktif?).

**Celah ini belum ada satu pun yang menutup.** Dan kebetulan ini persis lapangan kriptografi — lapangan di mana SIKRIT dibangun.

---

## 3. Solusi (What SIKRIT Is)

**SIKRIT** = *Privacy-Preserving Dead Man's Switch* di Solana.

### 5 Pilar Mekanisme

1. **🧊 Kapsul Rahasia** — Secret (seed phrase / key material / dokumen) dipecah dengan **Shamir's Secret Sharing** menjadi *N* share; tiap share dienkripsi ke public key ahli waris. Tidak ada satu pihak pun yang memegang utuh.
2. **💓 Heartbeat (Proof-of-Life)** — Pemilik membuktikan masih hidup secara periodik. Di Solana biayanya ~$0.0001 → heartbeat mingguan **gratis** (di Ethereum ini pembunuh yang bikin proyek sejenis mati suri).
3. **🛡️ Guardian Network (Social Recovery)** — *N-of-M* orang kepercayaan ikut mem-vouch. Kalau owner benar-benar hilang, guardian bisa konfirmasi pelepasan.
4. **⏳ Time-Lock + Claim Window + Veto** — Setelah X bulan tanpa heartbeat, ahli waris boleh klaim. Ada *grace period* agar guardian bisa *veto* (anti-false-trigger / proteksi hukum).
5. **🎨 NFT Kapsul** — "Surat wasiat digital" jadi NFT yang bisa dipindah / diwariskan sebagai bagian estate planning, sekaligus objek demo yang kece buat juri.

---

## 4. Differentiator Pembeda (Kenapa SIKRIT Menang)

> **Jangan pitch sebagai "crypto inheritance app" — itu crowded.** Pitch sebagai *Privacy-Preserving Dead Man's Switch*.

### 🧠 1. ZK Proof-of-Liveness (JURUS PEMBUNUH — tidak ada yang punya)

- Check-in jadi **Zero-Knowledge Proof**: buktikan "aku masih pegang kunci" **tanpa reveal** siapa, kapan, di address mana.
- MVP pakai **Schnorr proof-of-knowledge** (jujur-jujur ZK, ringan, bisa dikejar dalam 12 hari).
- Hasil on-chain: hanya terlihat "ada bukti valid" — **tanpa metadata identitas**. Inilah momen yang bikin juri terkesima: *"oh, ini yang bikin beda."*

### 🚀 2. Solana-Native Economics (bunuh failure mode Sarcophagus & Ethereum)

- Fee heartbeat mingguan ~$0.0001; time-lock & vault murah. Model yang di Ethereum/Stacks/Kaspa **tidak ekonomis**.
- **Tanpa token**: tidak ada incentive crash seperti SARCO. Pendapatan dari *release fee*, bukan token spekulatif.

### 🔒 3. Zero Server Custody & Zero Hardware (bunuh Deadhand & Serenity)

- **Tidak ada master key di server** (lawan: Deadhand).
- **Tidak butuh hardware biometrik / KYC** (lawan: Serenity Shield).
- Shamir SSS + enkripsi ke pubkey ahli waris, semua client-side & trustless.

---

## 5. Positioning Jujur (Anti-ketangkep-juri di Q&A)

Jangan klaim *"kami satu-satunya crypto inheritance"* — itu salah dan akan ketangkep juri. Klaim yang benar & tajam:

> *"Inheritance protocols exist — but none of them protect the owner's privacy. SIKRIT is the first privacy-preserving liveness protocol."*

Posisi ini **jujur + beda + defensible**.

---

## 6. Kenapa Ramainya Pesaing Justru Kabar Baik

1. **Problem sudah ter-validasi** → tidak perlu meyakinkan juri bahwa masalahnya nyata. Cukup bilang: *"5 proyek sudah coba, semuanya gagal menutup privasi liveness — kami menutup celah itu."*
2. **Semua pesaing punya cacat yang bisa disebut satu-satu** di pitch deck (tabel di §2 jadi slide "Competitive Landscape").
3. **Judges kripto** (Yurii Olentir — ITX Security, David — Mad Shield) langsung menangkap nuansa ZK-nya — dan sebagai mahasiswa kriptografi Poltek SSN, SIKRIT nendang di lapangan yang mereka hormati.

---

## 7. Strategi Menang (Beyond Teknis)

- **Demo Story 30 detik yang menghantui:** *"Bapak A bikin kapsul → 6 bulan no heartbeat → ahli waris klaim → dana cair."* Emosional + mudah dicerna. Simulasi "kematian" jadi momen klimaks video pitch.
- **University Award $10k:** Bungkus sebagai **riset kriptografi terapan** (Shamir SSS + ZK + time-lock). Juri yang kelas pekerja tidak bisa klaim ini.
- **Business model:** Free basic capsule → fee kecil saat *release* + premium guardian network + B2B ke wallet/exchange untuk fitur warisan.
- **Nama "SIKRIT"** (slang "rahasia") + tagline jenazah → *rememberable*, juri tidak akan lupa.

---

## 8. Roadmap 12 Hari (Realistis Solo)

| Hari | Target |
|---|---|
| 1–2 | Scaffold Anchor program (`create_capsule`, `heartbeat`, `claim`, `guardian_veto`) + test |
| 3–4 | Shamir SSS + encryption lib + Schnorr proof-of-liveness |
| 5–7 | Frontend (flow bikin kapsul → dashboard heartbeat → flow klaim) |
| 8–9 | Deploy devnet + test E2E + script demo |
| 10–11 | Pitch deck + video 3 menit |
| 12 | Submit di Colosseum |

---

## 9. Metrik Sukses (untuk slide "Traction / Impact")

- **Zero metadata leakage** pada heartbeat (bukti konsep ZK tervalidasi di devnet).
- **<$0.001** total biaya heartbeat bulanan (vs. gas ETH Sarcophagus yang bisa >$1/check-in).
- **3 jalur recovery** tanpa satu pun titik kepercayaan (owner / heir / guardian).
- **Waktu setup < 2 menit**, tanpa KYC, tanpa hardware.

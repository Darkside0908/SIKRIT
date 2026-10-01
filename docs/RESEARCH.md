# 🔎 Riset Lanskap & Hackathon — SIKRIT

> Diverifikasi **1 Oktober 2026** (web search + rules resmi). Semua klaim di pitch, deck, video, dan form submission
> harus konsisten dengan dokumen ini. Kalau ada yang berubah, perbarui di sini dulu.

---

## 1. Hackathon yang sebenarnya: Colosseum **Crypto World's Fair**

`docs/HACKATHON-CONTEXT.md` menyebut "Solana Radar Hackathon 2026". **Radar adalah hackathon Colosseum tahun 2024.**
Hackathon Colosseum dengan deadline 12 Oktober 2026 adalah **Crypto World's Fair** — online, multi-chain, dengan
track per ekosistem. Fakta dari *Official Rules* (PDF) dan halaman resmi:

| Hal | Fakta | Sumber |
|---|---|---|
| Periode | **06.00 PT 14 Sep 2026 → 23.59 PT 12 Okt 2026** (= **Selasa 13 Okt 2026, 13.59 WIB**). Pemenang diumumkan paling lambat 5 Des 2026 | Rules §5 |
| Registrasi | **Setiap anggota tim** wajib register di colosseum.com sebelum deadline; team leader meng-upload submission | Rules §6 |
| Kriteria juri | (a) **Functionality** — seberapa baik bekerja, kualitas kode · (b) **Potential Impact** — TAM & dampak ke ekosistem kripto · (c) **Novelty** · (d) **UX** — seberapa baik blockchain dipakai untuk UX yang bagus · (e) **Open-source** — dan komposabilitas dengan primitive lain · (f) **Business Plan** — bisnis yang viable + kemampuan tim mengeksekusi | Rules §8 |
| FAQ juri | founder–market fit, insight, product + execution, ukuran pasar, komunikasi founder, viability, traction | colosseum.com/hackathon |
| Hadiah | Grand Champion **$30.000** · 20 tim berikutnya **$15.000** per tim · **Public Goods Award $5.000** · **University Award $5.000** · **Solana track $100.000** (10 produk × $10.000) · track lain: Tempo, Hyperliquid, Zcash ($100k), Ethereum L1, Base, Arbitrum, Robinhood Chain ($25k) | Rules §14 |
| Akselerator | Pemenang diwawancara untuk akselerator Colosseum: **$250.000 pre-seed**, total $2,5 jt | colosseum.com/worldsfair |
| Isi submission | nama + deskripsi produk; chain & tools yang dipakai; latar belakang semua anggota + lokasi; logo; **link repo GitHub** (open-source dianjurkan); **video presentasi/pitch 2–3 menit** (dilihat juri pertama kali); **video demo produk ≤ 3 menit**; rencana go-to-market, validasi demand, distribusi | colosseum.com/hackathon |
| Batasan | satu orang hanya di satu tim; satu submission per tim; **hanya pekerjaan 14 Sep–12 Okt yang dinilai** | Rules §7, FAQ |
| Juri | tim Colosseum (Clay Robbins, Matty Taylor, Nate Levine, Max Monciardini, Michael Rinko) + 16 juri track (antara lain Phantom, Solana Foundation, Base, Arbitrum) | colosseum.com/worldsfair |

**Implikasi untuk SIKRIT**
- Kejar: **Solana track** (10 × $10k), **University Award** ($5k), **Public Goods Award** ($5k), dan top-20 ($15k).
  Bukan "Consumer Apps track" — track per-kategori tidak ada di event ini.
- Butuh **dua video**: pitch (2–3 menit, founder bicara) + demo produk (≤ 3 menit). Lihat `docs/VIDEO-SCRIPT.md`.
- Bobot 60/30/10 di HACKATHON-CONTEXT tidak resmi. Enam kriteria resmi di atas yang dipakai untuk menyusun deck.
- Commit pertama repo ini 30 Sep 2026 → seluruh pekerjaan berada di dalam periode lomba (tidak ada prior code).

---

## 2. Kompetitor (terverifikasi)

Pertanyaan kunci: **apakah heartbeat/check-in pemilik bisa ditautkan ke wallet atau identitasnya?**

| Proyek | Chain | Yang diwariskan | Mekanisme liveness | Heartbeat tertaut ke pemilik? |
|---|---|---|---|---|
| **DeathClock** (entri Crypto World's Fair) | Solana devnet | SOL di vault PDA | Bukti RISC Zero **Groth16** atas `SHA-256(owner ‖ timestamp ‖ nonce)`, ~183k CU, challenge 48 jam | **Ya** — PDA `["vault", owner]`, wallet pemilik menandatangani, pubkey pemilik di event. "ZK" di sini = komputasi terverifikasi, bukan privasi |
| **Dead Man's Vault (DMV)** (Monolith, Feb–Mar 2026) | Solana (Seeker) | SOL, SPL, NFT, RWA | Agent key di Android Keystore menandatangani heartbeat on-chain | **Ya** — PDA `["vault", owner]` |
| **dead-man-switch** (Anemiaaaa) | Solana | SOL/SPL | Check-in pemilik | **Ya** |
| **Ethernal** (3rd-Web-Hack) | EVM | dana, NFT, surat terenkripsi | "Setiap aksi pemilik = proof of life" (`ping()`) | **Ya**. Catatan: *sealed heirs* (komitmen ber-salt) menyembunyikan **ahli waris**, bukan pemilik |
| **Sarcophagus** | Base + Arweave (dulu Ethereum) | data terenkripsi | Pemilik *re-wrap* berkala; node "archaeologist" + token SARCO | **Ya** (transaksi dari wallet pemilik) |
| **Serenity Shield** (StrongBox) | Secret Network (+ multi-chain) | seed phrase via 3 NFT non-transferable (Shamir) | *Activation conditions* di kontrak Secret Network | Bergantung pada privasi TEE Secret Network; bukan Solana |
| **Deadhand** | off-chain (server) | seed phrase, Shamir 2-of-3 | Check-in email/API tiap 30 hari; server mengirim shard C ke ahli waris setelah 90 hari diam | Server melihat setiap check-in (pihak tepercaya) |
| **LastSats**, **Heirloom** | Stacks | sBTC / STX | Check-in pemilik; LastSats: guardian bisa *pause* | **Ya** |
| **Kaspa Safe** | Kaspa (covenant) | KAS | Check-in berkala on-chain | **Ya** |
| **Casa** | Bitcoin multisig | BTC | Proses inheritance dibantu Casa (KYC, ~$250+/thn) | Off-chain, kustodian sebagian |

**Kesimpulan jujur**
- Dari 11 proyek yang kami periksa, **tidak ada satu pun yang membuat heartbeat tidak bisa ditautkan ke wallet pemilik.**
  Klaim yang boleh dipakai: *"Sejauh riset kami, SIKRIT adalah dead man's switch pertama yang bukti hidupnya tidak
  bisa ditautkan ke wallet atau identitas pemilik."*
- **Jangan** klaim "ZK heartbeat pertama di Solana" — DeathClock sudah memakai bukti Groth16 untuk heartbeat.
  Bedanya: bukti mereka *menyertakan* identitas pemilik; bukti SIKRIT justru tidak.
- **Jangan** pakai "BitLegacy" (versi lama PITCH.md) — tidak bisa diverifikasi. Pakai LastSats/Heirloom untuk Stacks.
- Pembeda terukur vs DeathClock (kompetitor langsung di event yang sama): heartbeat **41k CU vs ~183k CU**; tidak ada
  wallet pemilik di transaksi apa pun (diverifikasi otomatis oleh E2E); yang diwariskan **rahasia apa pun**
  (seed phrase lintas chain), bukan hanya SOL; ada guardian N-of-M + veto terbatas; heartbeat bisa di-relay siapa saja.

---

## 3. Pola pemenang Colosseum

| Hackathon | Grand Champion | University Award | Public Goods Award | Privasi/kriptografi di daftar pemenang |
|---|---|---|---|---|
| Cypherpunk (2025) | **Unruggable** — hardware wallet + app untuk Solana | Pythia | Samui Wallet (wallet open-source) | Cloak (private payments), Humanship ID (identitas privacy-first) |
| Frontier (Apr–Mei 2026, diumumkan 26 Jun 2026) | CrowdBrain — robotics DePIN | IOChain | Zoneless (open-source) | — |

- **Tidak ada proyek warisan/dead man's switch** di daftar pemenang dua hackathon terakhir: jalurnya kosong.
- Grand Champion 2025 adalah produk **keamanan self-custody**. SIKRIT berada di tema yang sama: self-custody
  belum lengkap tanpa rencana pewarisan.
- Pemenang punya cerita bisnis yang jelas. Deck SIKRIT wajib menunjukkan siapa yang membayar dan bagaimana
  produk ini didistribusikan (lihat PITCH.md §6).

---

## 4. Angka pasar (untuk *Potential Impact*)

- **2,3–3,7 juta BTC (11–18% suplai maksimum) diperkirakan hilang permanen**; Ledger & Unchained (2025) ~3,8 juta.
  Penyebabnya termasuk lupa kunci, perangkat dibuang, dan **pemegang yang meninggal**. Pakai angka ini sebagai
  "aset yang terkunci selamanya", **bukan** sebagai "hilang karena kematian" (tidak ada sumber yang memisahkannya).
- **Indonesia: 22,93 juta investor aset kripto** (OJK, Juli 2026), naik dari 20,19 juta di Januari 2026.
- Setiap pengguna self-custody adalah calon pengguna: masalahnya tumbuh seiring adopsi self-custody.

---

## 5. Sumber

- Colosseum — Crypto World's Fair Official Rules (PDF): https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf
- Colosseum — Crypto World's Fair: https://colosseum.com/worldsfair · Hackathon FAQ & submission: https://colosseum.com/hackathon
- Colosseum — How to Win a Colosseum Hackathon: https://blog.colosseum.com/how-to-win-a-colosseum-hackathon/
- Crypto Briefing — Colosseum launches Crypto World's Fair: https://cryptobriefing.com/colosseum-crypto-worlds-fair-hackathon/
- Winners Cypherpunk: https://blog.colosseum.com/announcing-the-winners-of-the-solana-cypherpunk-hackathon/
- Winners Frontier: https://solanacompass.com/news/colosseum-announces-26-winners-of-the-solana-frontier-hackathon-the-largest-crypto-hackathon-ever
- DeathClock: https://github.com/HusseinAdeiza/deathclock
- Dead Man's Vault: https://github.com/Romulus-Sol/DMV
- dead-man-switch (Solana): https://github.com/Anemiaaaa/dead-man-switch
- Ethernal: https://github.com/Georgefifth/ethernal
- Sarcophagus: https://github.com/sarcophagus-org/sarcophagus-contracts
- Serenity Shield: https://www.bitdegree.org/crypto/serenity-shield-review
- Deadhand: https://www.deadhandprotocol.com/ · https://github.com/pyoneerC/deadhand
- LastSats: https://github.com/Sendi0011/LastSats · Heirloom: https://github.com/Dydex/heirloom
- Kaspa Safe: https://kaspaforge.org/safe.html
- Casa & ikhtisar protokol warisan: https://dev.to/duzf8mjxkvea/i-audited-every-crypto-inheritance-protocol-so-you-dont-have-to-58c8
- Lost BTC: https://www.bitgo.com/resources/blog/bitcoins-invisible-burn-lost-coins-outpace-new-supply/
- Investor kripto Indonesia (OJK, Juli 2026): https://www.suara.com/bisnis/2026/09/30/131557/2293-juta-investor-sudah-masuk-kripto-industri-kini-pecut-literasi

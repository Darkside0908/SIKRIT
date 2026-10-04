# 🪦 SIKRIT — *Privacy-Preserving Dead Man's Switch on Solana*

> **Tagline:** *"Don't take your keys to the grave."* — *"Jangan bawa kuncimu ke liang kubur."*
>
> **One-liner (EN):** SIKRIT is a dead man's switch on Solana where proving you're alive doesn't reveal who you are.
>
> **One-liner (ID):** Dead man's switch di Solana yang bukti hidupnya tidak membocorkan siapa kamu.

Event: **Colosseum Crypto World's Fair** (deadline 12 Okt 2026, 23.59 PT = 13 Okt 13.59 WIB). Target: **Solana track**,
**University Award**, **Public Goods Award**, top-20. Fakta event, kompetitor, dan angka pasar beserta sumbernya ada di
[`docs/RESEARCH.md`](RESEARCH.md) — **semua klaim di dokumen ini harus konsisten dengan file itu.**

---

## 1. Masalah

**Self-custody tidak punya tombol "lupa password", dan tidak punya ahli waris.**

- Diperkirakan **2,3–3,7 juta BTC (11–18% suplai) terkunci permanen**: lupa kunci, perangkat hilang, dan pemegang
  yang meninggal tanpa mewariskan akses. Setiap kenaikan adopsi self-custody memperbesar angka ini.
- Di Indonesia saja ada **22,93 juta investor kripto** (OJK, Juli 2026). Sebagian besar keluarga mereka tidak tahu
  harus berbuat apa kalau pemegangnya meninggal.
- **Tegangan inti:** keluarga harus bisa membuka wallet-mu **saat kamu sudah tiada**, dan **tidak boleh pernah** bisa
  selama kamu masih hidup.

Pilihan hari ini semuanya mengorbankan sesuatu:

| Cara | Masalah |
|---|---|
| Seed di kertas / brankas / notaris | Bisa dibaca kapan saja oleh siapa pun yang memegangnya, jadi ahli waris bisa membukanya sebelum waktunya |
| Layanan kustodian (multisig berbayar, server) | KYC, biaya tahunan, pihak tepercaya yang bisa tutup atau bocor |
| Dead man's switch on-chain | Setiap check-in adalah **siaran publik yang ditandatangani wallet-mu**: *"alamat ini masih hidup dan aktif, hari ini"* |

## 2. Insight

Semua dead man's switch on-chain yang kami periksa (11 proyek, lihat RESEARCH.md §2) **menautkan bukti hidup ke wallet
pemilik**: vault-nya diturunkan dari alamat pemilik, dan check-in-nya ditandatangani wallet itu. Hasilnya feed publik
tentang kapan seorang pemegang aset aktif, kapan ia berhenti aktif, dan berapa nilai yang menunggu ahli warisnya.
Untuk pemegang aset besar, itu peta bagi penjahat.

Bukti hidup tidak perlu identitas. Cukup bukti bahwa **seseorang yang memegang kunci rahasia tertentu masih ada**.
Itu masalah kriptografi klasik, *proof of knowledge*, dan di Solana bisa diverifikasi murah lewat syscall curve25519.

**Founder–market fit:** dibangun oleh mahasiswa tingkat 4 **Politeknik Siber dan Sandi Negara** (Rekayasa Perangkat
Lunak Kripto) yang belajar kriptografi terapan untuk negara, dan ingin keluarganya sendiri bisa mewarisi aset kriptonya.

## 3. Solusi: cara kerja SIKRIT

1. **Seal.** Rahasia (seed phrase, password, pesan) dienkripsi di browser dengan kunci acak sekali pakai. Kunci itu
   dipecah dengan **Shamir's Secret Sharing**: satu share untuk ahli waris, satu per guardian. Tiap share dienkripsi
   (**HPKE, RFC 9180**) ke kunci inbox yang **ditandatangani wallet pemegangnya**, sehingga tidak ada kunci yang bisa
   diselundupkan di tengah jalan. On-chain hanya disimpan **hash** tiap share dan, untuk ahli waris serta tiap
   guardian, **komitmen bergaram** `SHA-256(domain ‖ P ‖ peran ‖ wallet ‖ salt)`: chain tidak tahu siapa keluarganya.
2. **Prove you're alive.** Pemilik mengirim **bukti Schnorr zero-knowledge** bahwa ia masih memegang kunci liveness
   `x` (yang diturunkan dari tanda tangan wallet, tapi bukan kunci wallet). Bukti diverifikasi on-chain (~41k CU),
   terikat ke counter (setiap bukti hanya berlaku sekali) dan ke masa berlaku 10 menit (relayer yang menahannya tidak
   bisa memakainya belakangan), dan **dikirim oleh relayer**: **tidak ada wallet pemilik di transaksi mana pun**.
3. **Release on silence.** Kalau pemilik diam melewati interval, siapa pun boleh membuka klaim. Heartbeat tetap bisa
   membatalkannya; guardian bisa veto alarm palsu (terbatas, anti-DoS). Guardian mengonfirmasi dengan membuka
   komitmennya (salt dari kit + tanda tangan wallet-nya); setelah grace period dan kuorum, ahli waris klaim dengan cara
   yang sama. **Baru setelah itu** guardian me-release share-nya ke inbox ahli waris yang dikomit, dan rahasia tersusun
   kembali **di browser ahli waris**.

Ahli waris sendirian memegang share yang secara statistik independen dari rahasia: ia tidak bisa membuka apa pun
sebelum waktunya. Dan karena keluarga hanya ada sebagai komitmen, penjahat yang tahu wallet anak pemilik tidak bisa
memakainya untuk menemukan kapsul si pemilik: tiap anggota baru terlihat on-chain saat **ia sendiri** bertindak.

## 4. Kompetitor

| Proyek | Chain | Yang diwariskan | Heartbeat tertaut ke wallet pemilik? |
|---|---|---|---|
| DeathClock *(entri event ini)* | Solana | SOL | **Ya**: bukti Groth16 (~183k CU) memuat pubkey pemilik; PDA `["vault", owner]` |
| Dead Man's Vault | Solana Seeker | token, NFT | **Ya**: PDA `["vault", owner]` |
| dead-man-switch | Solana | SOL/SPL | **Ya** |
| Ethernal | EVM | dana, NFT, surat | **Ya**: setiap aksi pemilik = proof of life (ahli waris disamarkan, pemilik tidak) |
| Sarcophagus | Base + Arweave | data | **Ya**: re-wrap dari wallet pemilik; bergantung token SARCO |
| LastSats / Heirloom | Stacks | sBTC / STX | **Ya** |
| Kaspa Safe | Kaspa | KAS | **Ya** |
| Serenity Shield | Secret Network | seed (3 NFT) | bergantung TEE Secret Network |
| Deadhand | server | seed (Shamir 2-of-3) | server melihat setiap check-in (pihak tepercaya) |
| **SIKRIT** | **Solana** | **rahasia apa pun** (seed lintas chain) | **Tidak**: bukti tanpa identitas, dikirim relayer |

**Klaim yang boleh dipakai:** *"Of the 11 inheritance protocols we reviewed, none hides who is checking in. SIKRIT is,
to our knowledge, the first dead man's switch whose proof of life cannot be linked to the owner's wallet."* Ditambah
(properti SIKRIT sendiri, tanpa perbandingan): *"While you're alive, the chain holds no wallet of your family either:
heir and guardians are salted commitments until they act."*

**Jangan klaim:** "ZK heartbeat pertama di Solana" (DeathClock sudah memakai Groth16), "satu-satunya aplikasi warisan
kripto", atau bahwa waktu heartbeat tersembunyi (tidak).

## 5. Bukti, bukan klaim

| Klaim | Bukti di repo |
|---|---|
| Heartbeat tanpa wallet pemilik | E2E Chrome (`app/e2e/demo-flow.mjs`) membaca ulang **semua 7 transaksi kapsul** di chain (termasuk penggantian roster): wallet pemilik muncul di **0** |
| Keluarga tidak on-chain sebelum bertindak | E2E yang sama: Sari (ahli waris) hanya muncul di transaksi klaimnya, Budi & Dewi hanya di konfirmasi masing-masing, Rizal (guardian yang dikeluarkan lewat update) di **0**; akun kapsul hanya memuat komitmen sampai klaim |
| Murah | Verifikasi heartbeat **41.417 CU** (diukur di devnet 4 Okt, termasuk cek masa berlaku); fee 5.000 lamport. Heartbeat mingguan 30 tahun ≈ **0,0078 SOL** |
| Kriptografi benar | Transkrip Fiat–Shamir dikunci *known-answer vector* lintas bahasa (TS ↔ Rust); HPKE lolos vektor resmi RFC 9180; Shamir pakai library teraudit (Cure53 + Zellic) |
| Aman | Self-audit 22 temuan (`docs/SECURITY-REVIEW.md`, program + SDK + app + relayer): replay, double-vote guardian, veto DoS, swap kunci inbox, roster keluarga yang menunjuk ke pemilik, bukti heartbeat tanpa masa berlaku, dst. — semua High/Critical sudah diperbaiki dan dites |
| Bekerja end-to-end | 79 test (LiteSVM + SDK + client + relayer) + 14 unit test Rust + E2E browser 13 langkah, di validator lokal **dan di devnet**: seed phrase pulih identik di browser ahli waris |

## 6. Bisnis & go-to-market *(rencana; belum ada pendapatan)*

**Model: open core, tanpa token.** Program dan SDK open-source (public good) dan gratis; uang datang dari layanan di
sekitarnya, bukan dari spekulasi.

1. **Integrasi wallet (B2B2C).** Tab "Warisan" di wallet Solana (Phantom, Solflare, Backpack) memakai SDK
   `sdk/client.ts` + `sdk/kit.ts`, yang dependensinya ringan dan tidak butuh Anchor di browser. Wallet mendapat fitur
   retensi; SIKRIT mendapat distribusi + biaya integrasi/dukungan.
2. **Watcher & relayer premium** (~$2–5/bulan). Pengingat heartbeat, **alarm saat klaim dibuka** (agar pemilik sempat
   membatalkan, R8), relayer dengan SLA. Heartbeat tetap bisa dikirim siapa pun, jadi tidak ada lock-in.
3. **Guardian profesional.** Notaris dan perencana waris sebagai guardian. Cocok dengan praktik **akta wasiat** di
   Indonesia: notaris bisa ikut mengonfirmasi klaim tanpa pernah bisa membuka rahasia sendirian.
4. **Biaya release opsional** di program (versi berikutnya), dibayar sekali saat warisan benar-benar terjadi.

**Go-to-market:** mulai dari Indonesia (22,93 juta investor, budaya waris keluarga yang kuat, komunitas Solana lokal),
lewat komunitas kripto, kampus, dan notaris/perencana keuangan. Setelah itu pengguna self-custody global lewat wallet.

**Validasi demand:** wawancara singkat calon pengguna dan notaris (formulir di `docs/SUBMISSION.md`) sebelum submit.

## 7. Peta ke kriteria juri resmi

| Kriteria (Rules §8) | Jawaban SIKRIT |
|---|---|
| **Functionality** | Program Anchor live di devnet + SDK + app berjalan end-to-end; 79 test + 14 unit test Rust + E2E browser (localnet & devnet); kode diaudit sendiri dengan temuan terdokumentasi |
| **Potential Impact** | Jutaan BTC terkunci permanen; setiap pengguna self-custody butuh rencana waris; primitive privasi yang bisa dipakai ulang (*proof of liveness* tanpa identitas) |
| **Novelty** | Heartbeat tanpa identitas: tidak ada di 11 proyek yang kami periksa. Bukti Schnorr diverifikasi dengan syscall curve25519 dalam 41k CU. Roster tersegel melengkapinya (Ethernal juga menyegel ahli waris, tapi pemiliknya tetap terlihat): pemilik **dan** keluarganya tidak terlihat sampai bertindak |
| **UX** | Tanpa token, tanpa KYC, tanpa hardware khusus. Pemilik tidak perlu SOL dan tidak perlu backup kunci baru (diturunkan ulang dari wallet). Setup ±2 menit |
| **Open-source** | Seluruh repo terbuka; SDK tanpa Anchor di browser dengan panduan integrasi (`sdk/README.md`: wallet, relayer, watcher); heartbeat signer-less sehingga siapa pun bisa membangun relayer/watcher; format kit berversi |
| **Business Plan** | Open core: integrasi wallet, watcher/relayer premium, guardian profesional (notaris) |

## 8. Persiapan Q&A (jawaban jujur)

- **"Is a Schnorr proof really zero-knowledge?"** Ya, dalam arti standar: Schnorr adalah *honest-verifier* ZK proof of
  knowledge, dibuat non-interaktif dengan Fiat–Shamir (random oracle). Secara matematis setara tanda tangan Schnorr
  dengan kunci khusus. Kekuatannya ada pada **unlinkability + anti-replay + domain separation**, bukan pada SNARK.
- **"Is the heartbeat time hidden?"** Tidak. *Siapa* yang tersembunyi, *kapan* tetap publik (R1). Roadmap v3: himpunan
  anonim (ring signature / bukti keanggotaan) supaya heartbeat tidak menunjuk kapsul tertentu.
- **"Can guardians collude early?"** Ya, kalau cukup banyak: rahasia terbuka dengan **k = kuorum + 1** share, yaitu
  ahli waris + kuorum guardian, **atau** k guardian tanpa ahli waris (kalau jumlah guardian ≥ k). Ini asumsi
  kepercayaan yang sama dengan social recovery mana pun, dan sengaja dipertahankan sebagai jalur pemulihan kalau
  ahli waris kehilangan wallet (R13, R15). Ahli waris sendirian, atau kuorum guardian tanpa ahli waris, tidak bisa
  membuka apa pun. Release hanya setelah `Claimed` adalah janji guardian yang ditegakkan app (SIK-11), bukan paksaan
  kriptografis; wizard memperingatkan pemilik soal ini saat memilih kuorum.
- **"What if the owner loses their wallet?"** Kunci liveness tidak bisa diturunkan lagi, heartbeat berhenti, dan kapsul
  terbuka ke ahli waris setelah interval + grace. Gagalnya ke arah yang aman untuk keluarga; pemilik bisa membuat
  kapsul baru.
- **"Can I change my heir or guardians later?"** Ya, sejak protokol v2.1 (`update_capsule`): pemilik menyegel ulang
  rahasianya untuk ahli waris, guardian, kuorum dan timer baru, dan mengirim satu bukti Schnorr atas seluruh config
  baru. Tanpa wallet, dan relayer tidak bisa mengubah atau memutar ulang buktinya. Komitmen dan hash share lama hilang
  dari chain, jadi guardian menolak me-release dari kit lama. Batas jujurnya: share yang sudah dibagikan tidak bisa
  ditarik; cukup banyak pemegang lama yang berkolusi tetap bisa membuka kit lama (R19). Kalau yang dikeluarkan orang
  yang tidak lagi dipercaya, pindahkan juga dananya.
- **"Isn't the relayer a central point?"** Heartbeat tidak butuh signer: siapa pun bisa me-relay, relayer tidak bisa
  memalsukan bukti, dan pemilik bisa memakai fee payer mana pun (asal bukan wallet-nya sendiri). Relayer yang menahan
  bukti juga tidak bisa menyimpannya untuk nanti: bukti kedaluwarsa dalam 10 menit (batas program 1 jam, SIK-20).
- **"Can someone find my capsule through my children's wallets?"** Tidak sejak protokol v2 (SIK-19). Chain hanya
  menyimpan komitmen bergaram atas ahli waris dan guardian; salt 256 bit ada di kit, jadi komitmen tidak bisa ditebak
  dengan mencoba wallet, dan orang yang sama tidak tertaut antar kapsul. Anggota terlihat hanya saat bertindak
  (guardian konfirmasi/veto, ahli waris klaim). Yang tetap publik: jumlah guardian, kuorum, timer (R3). File kit
  menyebut seluruh keluarga, jadi kit hanya untuk para pemegangnya.
- **"Upgrade authority?"** Untuk produksi dipindah ke multisig atau dibuat immutable setelah audit (R4).
- **"Why Solana?"** Syscall curve25519 membuat verifikasi Schnorr murah (41k CU), fee per heartbeat 5.000 lamport, dan
  PDA bisa diturunkan dari kunci publik `P`, bukan dari wallet. Di chain dengan gas mahal, heartbeat mingguan
  selama puluhan tahun tidak masuk akal.

## 9. Roadmap

- **Sudah (protokol v2, live di devnet sejak 2 Okt):** heir/guardian sebagai komitmen bergaram (SIK-19), bukti
  heartbeat berumur pendek (SIK-20).
- **Sudah (protokol v2.1, live di devnet sejak 4 Okt):** `update_capsule`, pemilik mengganti ahli waris, guardian,
  kuorum dan timer dengan satu bukti, tanpa wallet (R13 ikut teratasi selama pemilik hidup).
- **v2.2 (pasca-hackathon):** watcher notifikasi, pengikatan origin pada pesan derivasi kunci (R9), dukungan Ledger
  (R12), instruksi `close` (R7), deploy mainnet setelah audit eksternal.
- **v3:** heartbeat dalam himpunan anonim (R1), kit "buta" yang menyimpan identitas keluarga di dalam amplop HPKE
  tiap pemegang (R3), KEM hibrida post-quantum X-Wing (R10), migrasi Anchor 1.x / SBPF v3 (R6), opsional NFT "surat
  wasiat" yang bisa dipindah.

## 10. Demo story (30 detik)

> *Pak Arif menyegel seed phrase-nya untuk putrinya, Sari. Adiknya Budi, notaris keluarga Dewi, dan sahabatnya Rizal
> menjadi guardian. Setiap minggu Pak Arif membuktikan dirinya masih hidup, dan tidak ada satu pun transaksi yang
> menyebut namanya. Suatu hari ia berhenti. Klaim dibuka, dua guardian mengonfirmasi, masa tenggang lewat, dan seed
> phrase itu tersusun kembali di browser Sari. Bukan di server. Bukan di chain.*

Naskah video pitch & demo: `docs/VIDEO-SCRIPT.md`. Form submission: `docs/SUBMISSION.md`.

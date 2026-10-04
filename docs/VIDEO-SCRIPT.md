# 🎬 SIKRIT — Video Scripts

Colosseum asks for **two** videos (see `docs/RESEARCH.md` §1):

1. **Pitch / presentation video, 2–3 minutes** — the first thing judges watch. Founder on camera or voice over the
   deck: team, product, motivation, market, go-to-market/traction, a glimpse of the demo.
2. **Product demo video, ≤ 3 minutes** — the working product, end to end.

Both are in English (international judges). Production notes for Bang Igan are in Indonesian at the end.

---

## 1. Pitch video — "Don't take your keys to the grave" (target 2:40)

Visuals: `docs/deck/index.html` in present mode (press **F**, step with →), founder in a corner bubble or full-frame for
the opening and closing lines. Slide numbers refer to the deck. ~370 words ≈ 2:30 at a calm pace.

| Time | Slide | Voice-over |
|---|---|---|
| 0:00 | 1 · Title (founder on camera) | "If I died tonight, my family couldn't touch a single coin I own. Not because they have no right to it — because self-custody has no next of kin. I'm Ghani, a fourth-year cryptography student at Indonesia's state polytechnic for cyber security and cryptography. This is SIKRIT." |
| 0:17 | 2 · Problem | "Between 2.3 and 3.7 million bitcoin are already locked forever. Some of it belonged to people who died without passing on access. Indonesia alone has almost 23 million crypto investors, and their families face the same tension: they must be able to open the wallet when you're gone, and must never be able to while you're alive." |
| 0:42 | 3 · Insight | "Dead man's switches solve this with a check-in. We reviewed eleven of them. Every one ties the check-in to your wallet. Every week you publish: *this address is alive, and active, today*. When you stop, the chain says that too. For anyone holding real value, that's a map for attackers." |
| 1:05 | 4 · How it works | "SIKRIT proves you're alive without saying who you are. You seal your seed phrase in the browser. Its key is split with Shamir's scheme: one share for your heir, one for each guardian. To check in, your browser makes a Schnorr zero-knowledge proof with a key that is not your wallet, and a relayer sends it. Your family isn't on-chain either: only sealed commitments, until they act." |
| 1:28 | 5 · Proof | "This is what the chain sees: a relayer, a capsule address, and a proof. Your wallet isn't there. Our end-to-end test plays a whole inheritance and re-reads every transaction: the owner's wallet appears in zero of them, and each family member only where they act. Verifying a heartbeat costs 41 thousand compute units. Thirty years of weekly check-ins cost less than a hundredth of a SOL." |
| 1:55 | 6 · Product (cut to 4 s of demo footage) | "If you go silent, a claim opens. Two of three guardians confirm, the grace period passes, and only then do guardians release their shares. The seed phrase comes back together in your heir's browser." |
| 2:10 | 9 · Business | "The protocol stays open source and has no token. We earn around it: an inheritance tab for Solana wallets built on our SDK, a watcher that warns you the moment a claim opens, and notaries as professional guardians, which is how wills already work in Indonesia. We start at home and grow through wallets." |
| 2:30 | 10 · Close (founder on camera) | "I study how secrets fail, so I built one that fails safely. Prove you're alive. Reveal nothing else." |

**Must-say facts (keep the numbers exact):** 11 protocols reviewed · 0 of 7 transactions · 41,417 CU (say "41
thousand") · 0.0078 SOL for 30 years · 22.93 M investors (say "almost 23 million") · no token.

**Do not say:** "first ZK heartbeat on Solana" (DeathClock already uses Groth16), "nobody can see when you check in"
(the time is public), "the only inheritance app". See `docs/PITCH.md` §4 and §8.

---

## 2. Product demo — "One family, five wallets, one browser" (target 2:50)

Setup (pick one): **localnet**, the most predictable: `npm run build` once in the repo root, then
`cd app && npm run localnet` (validator + program + app at http://localhost:5173); or **devnet**: the hosted app on
Vercel once it is deployed (program `FJKqf…Tc45F`, fees paid by the relayer service). Chrome window at 1440 × 900, zoom
100 %, bookmarks bar hidden. Click **Reset demo** in the footer before recording. The program enforces 60-second
minimum timers, so the two waits are jump cuts with an on-screen "+60 s" title (on devnet, pick **1 minute** in the
form: its default is 3).

| Time | Screen | Action | Voice-over |
|---|---|---|---|
| 0:00 | Home | Slow scroll over the hero | "This is SIKRIT running against a local Solana validator with the real program" (devnet: "This is SIKRIT live on Solana devnet"). "Five demo wallets play one family: Pak Arif, his daughter Sari, and three guardians." |
| 0:12 | Owner | **Derive my liveness key** | "Pak Arif's wallet signs a fixed message. SIKRIT hashes that signature into a separate secret, x. Only its public key goes on-chain, and he can re-derive it from his wallet any time." |
| 0:28 | Owner · step 1 | **Invite the demo family** | "Sari and the guardians send invites: encryption keys signed by their own wallets. Every signature is checked, so nobody in the middle can swap in a key." |
| 0:40 | Owner · steps 2–3 | **Use a sample seed phrase**; show 1 min / 1 min / quorum 2 | "He pastes his seed phrase. It's encrypted here, in the browser. The key is split three-of-four: Sari's share alone reveals nothing." |
| 0:55 | Owner | **Seal the capsule** → inspector `create_capsule` | "One transaction, paid by a relayer: the public key, the rules, a hash per share, and a sealed commitment per family member. No wallet of his, or of his family, is in it." |
| 1:08 | Owner | **Send ZK heartbeat** → inspector `heartbeat` | "Now a heartbeat: a zero-knowledge proof made in the browser. Three accounts: relayer, capsule, program. Eighty bytes: R, s, and an expiry ten minutes out, so a relayer can't hold it back for later. His wallet: not present. Nor is his family's." (optional: click the tx link: Solana Explorer shows the same accounts and, on devnet, decodes the SIKRIT `heartbeat` instruction from the on-chain IDL) |
| 1:30 | — | Title card **+60 s · Pak Arif falls silent** | — |
| 1:33 | Heir (Sari) | **Open the claim** | "He misses his interval. Anyone may now open a claim — here, Sari." |
| 1:42 | Guardian (Budi → Dewi) | **Confirm the claim** twice; hover **Veto** | "Two of three guardians confirm, each opening their sealed commitment with the salt from their kit: the chain sees them for the first time. If he were alive, a guardian could veto, or one more heartbeat would cancel the claim." |
| 2:00 | — | Title card **+60 s · grace period over** | — |
| 2:03 | Heir | **Claim the capsule** → "Sealed no more." | "The grace period is over and the quorum is met. Sari opens the heir's commitment and claims on-chain." |
| 2:12 | Guardian (Budi, Dewi) | **Release my share to the heir** | "Only now do the guardians release their shares, and only to the inbox key certified by the heir the capsule committed to." |
| 2:27 | Heir | **Unseal the secret** → hold **Hold to reveal** | "Sari's browser checks every share against the hashes on-chain and rebuilds the seed phrase. It was never on a server, and never on the chain." |
| 2:40 | Public capsule page | Scroll the public record | "Everything the world can learn about this capsule. No owner, and no Rizal, the guardian who never acted. Prove you're alive — reveal nothing else." |
| 2:50 | End card | Logo + repo URL | — |

**Optional beat, "families change" (+12 s; only if the cut stays ≤ 2:55, e.g. by trimming the 1:08 line).** Right after
the heartbeat: **Change heir, guardians or rules** → clear Rizal's invite → quorum **2** → **Use a sample seed phrase** →
**Re-seal and update** → inspector `update_capsule`. Voice-over: *"Families change. Rizal moved abroad, so Pak Arif
re-seals for Budi and Dewi alone: new shares, a new kit, one more proof. Still no wallet, and the chain never learns who left."*
With this beat, at 1:42 say "Both guardians confirm" (2 of 2), and at 2:40 "No owner, and no Rizal: removed without
ever appearing on-chain." The automatic B-roll below plays this beat too.

**Automatic B-roll (backup):** `RECORD_DIR=/tmp/rec SLOWMO=450 npm run e2e` (in `app/`, needs `ffmpeg` on PATH; or
`npm run e2e:devnet` with the same variables for footage on devnet through the relayer service, ~0.004 SOL)
plays the whole story by itself and writes `/tmp/rec/demo-flow.mp4`: 1440 × 900, ~71 s, the two 60-second waits already
cut out, key screens held for a few seconds. There is no mouse cursor, so use it under a voice-over or as cut-aways. A
copy from 4 Oct, with the re-seal beat, is in `app/e2e/out/demo-flow-broll.mp4` (gitignored, regenerate any time).

---

## 3. Catatan produksi (untuk Bang Igan)

- **Batas keras 3:00 per video.** Pitch idealnya 2:30–2:45; demo 2:45–2:55. Latih naskah dengan timer sebelum rekam.
- **Wajah founder** di pembuka & penutup video pitch memperkuat *founder–market fit* (FAQ juri Colosseum).
- **Audio > video:** mic headset/earphone di ruangan sunyi lebih baik daripada mic laptop. Bicara pelan; jeda kecil
  setelah angka penting.
- **Rekam:** OBS Studio (1080p, 30 fps), atau screen recorder bawaan. Deck: buka `docs/deck/index.html` di Chrome,
  tekan **F**, pindah slide dengan →.
- **Subtitle bahasa Inggris** (YouTube auto-caption lalu koreksi) membantu juri yang menonton tanpa suara.
- **Upload:** YouTube *unlisted* (atau Loom). Tempel link di `docs/SUBMISSION.md` dan form Colosseum.
- **Cek sebelum upload:** tidak ada private key, seed phrase asli, isi `~/.config/solana/id.json`, atau token di layar.
  Seed demo (`abandon ability able …`) adalah contoh publik, bukan dompet sungguhan.

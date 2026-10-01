# 📮 SIKRIT — Colosseum Submission Kit

> Event: **Colosseum Crypto World's Fair** · deadline **12 Oct 2026, 23:59 PT = 13 Oct 2026, 13:59 WIB**.
> Fields follow the official submission list (`docs/RESEARCH.md` §1). Copy the English text into the form.
> `⟨…⟩` = still to fill in by Bang Igan. **Do not invent numbers**: demand-validation results must come from real
> conversations (§8).

---

## 1. Product name

**SIKRIT**

## 2. Tagline (short)

> A dead man's switch on Solana where proving you're alive doesn't reveal who you are.

Alternative (≤ 60 chars): *Private proof-of-life inheritance for self-custody.*

## 3. Brief description (≈ 60 words)

> SIKRIT lets self-custody users pass on a seed phrase or any secret to their family without trusting a custodian and
> without broadcasting their life signs. The owner checks in with a Schnorr zero-knowledge proof from a key that is not
> their wallet, sent by a relayer. If they fall silent, guardians confirm the claim and the secret reassembles only in
> the heir's browser.

## 4. Full description (≈ 300 words)

> **Problem.** Self-custody has no next of kin. An estimated 2.3–3.7 million BTC are already locked forever, partly
> because holders died without passing on access. Families need a way to open a wallet when its owner is gone, and no
> way to open it while the owner is alive.
>
> **Insight.** Dead man's switches exist, but every one we reviewed (11 protocols, including one that already uses a
> zero-knowledge proof) ties the check-in to the owner's wallet. Each heartbeat publishes "this address is alive and
> active", and silence is public too: a map for attackers.
>
> **Solution.** SIKRIT separates *proof of life* from *identity*:
> 1. **Seal.** The secret is encrypted in the browser under a random key. The key is split with Shamir's scheme: one
>    share for the heir, one per guardian, each sealed with HPKE (RFC 9180) to an inbox key its holder's wallet
>    signed. Only share hashes go on-chain.
> 2. **Prove.** The owner proves knowledge of a dedicated liveness key with a Schnorr proof (Fiat–Shamir, domain-
>    separated, bound to a counter so each proof works once). The Anchor program verifies it with Solana's curve25519
>    syscalls in ~41k CU. The capsule address derives from the proof key, not a wallet, and any relayer can submit
>    the proof. Our end-to-end test replays a full inheritance on Solana devnet and finds the owner's wallet in 0 of 6
>    transactions.
> 3. **Release.** After a missed interval anyone can open a claim; a heartbeat cancels it and guardians can veto a
>    false alarm. After the grace period and a guardian quorum, the heir claims, guardians release their shares to
>    the heir's certified inbox, and the secret reassembles in the heir's browser.
>
> **Why Solana.** Cheap curve25519 syscalls and PDAs keyed by a public key make a private heartbeat practical: 30 years
> of weekly check-ins cost about 0.0078 SOL. No token.
>
> **Honest limits.** Heartbeat times and heir/guardian addresses are public; enough colluding guardians could open a
> kit early; not post-quantum yet. All documented in our security review with a roadmap.

## 5. Blockchains & tools integrated

- **Solana** — Anchor 0.30.1 program (`programs/sikrit`), curve25519 syscalls (`sol_curve_validate_point`,
  `sol_curve_group_op`, `sol_curve_multiscalar_mul`), PDAs. Program ID `FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F`
  — **live on devnet** ([explorer](https://explorer.solana.com/address/FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F?cluster=devnet);
  deployed bytes identical to the `anchor build` output).
- **Client crypto** — `@noble/curves` (Ed25519/X25519), `@noble/hashes`, `@noble/ciphers` (XChaCha20-Poly1305),
  HPKE RFC 9180 implemented on noble (`sdk/hpke.ts`), `shamir-secret-sharing` (Privy; audited by Cure53 and Zellic).
- **App** — `@solana/web3.js`, Solana Wallet Adapter / Wallet Standard (Phantom, Solflare, Backpack), Vite, React 19,
  Tailwind CSS 4.
- **Relayer service** — `app/api/relay.ts`, a Vercel serverless function (also mounted by the dev server): pays the fee
  of single SIKRIT instructions, so the owner's wallet never signs or pays and visitors need no test SOL.
- **Testing** — LiteSVM (time-travel lifecycle tests on the real SBF binary), Mocha/Chai, Rust unit tests,
  Playwright-driven Chrome end-to-end test against `solana-test-validator` and, through the production bundle, against
  the devnet deployment (`cd app && npm run e2e:devnet`).

## 6. Team

| Name | Role | Background |
|---|---|---|
| **Muhammad Ghani Nurramdhan** | Founder · protocol, cryptography, full stack | 4th-year student in Cryptographic Software Engineering (Rekayasa Perangkat Lunak Kripto) at **Politeknik Siber dan Sandi Negara (Poltek SSN)**, Indonesia's state polytechnic for cyber security and cryptography. ⟨prior experience: projects, competitions, CTFs, internships⟩ |

**Location:** ⟨city⟩, Indonesia
**University Award:** team member is a currently enrolled university student → ⟨attach/confirm proof of enrollment if
the form asks⟩.

## 7. Links & assets

| Item | Value |
|---|---|
| GitHub repository | ⟨`https://github.com/⟨username⟩/SIKRIT`⟩ — public, MIT |
| Live demo | ⟨Vercel URL⟩ — devnet; fees paid by the relayer service, so visitors need no wallet and no test SOL · local demo: `cd app && npm run localnet` |
| Program (devnet) | [`FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F`](https://explorer.solana.com/address/FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F?cluster=devnet) |
| A full inheritance on devnet | capsule [`5RR3sGRBZwdXAV6SMLFUzzGksMzuigmaLMEMNVCxjX9i`](https://explorer.solana.com/address/5RR3sGRBZwdXAV6SMLFUzzGksMzuigmaLMEMNVCxjX9i?cluster=devnet): 6 transactions (create → heartbeat → trigger → 2 confirms → claim); its owner's wallet `BvmZmRgnuy6y8tWdTbRPdPDC5jsFfhEm3cMsEnkxTBSW` has never been on-chain |
| Presentation video (2–3 min) | ⟨YouTube/Loom link⟩ — script: `docs/VIDEO-SCRIPT.md` §1 |
| Product demo video (≤ 3 min) | ⟨YouTube/Loom link⟩ — script: `docs/VIDEO-SCRIPT.md` §2 |
| Pitch deck (PDF) | `docs/deck/SIKRIT-deck.pdf` (source `docs/deck/index.html`) |
| Logo | `docs/brand/sikrit-logo-1024.png` · cover image `docs/brand/sikrit-cover.png` |
| Screenshots | `docs/screenshots/*.webp` |
| Security review | `docs/SECURITY-REVIEW.en.md` (English) · full Indonesian edition `docs/SECURITY-REVIEW.md` |

## 8. Go-to-market, demand validation, distribution

**Go-to-market (paste).**
> Indonesia first: 22.93 million registered crypto investors (OJK, July 2026), a strong culture of family inheritance,
> and notaries who already handle wills (*akta wasiat*). We reach users through local crypto communities, university
> blockchain clubs, and notaries and financial planners who can act as professional guardians. Then we go global
> through wallets: SIKRIT's SDK is dependency-light (no Anchor client in the browser), so a Solana wallet can ship an
> "Inheritance" tab on top of it.

**Business model (paste).**
> Open core with no token. The program and SDK stay open source. Revenue: (1) wallet integrations (integration and
> support fees), (2) a watcher and relayer subscription (~$2–5/month: heartbeat reminders, an alarm the moment a claim
> opens, relaying with an SLA; no lock-in, since anyone can relay), (3) professional guardian services with notaries,
> (4) an optional one-time release fee charged only when an inheritance actually happens.

**Distribution plan (paste).**
> 1) Open-source launch + write-up of the protocol for the Solana and cryptography communities. 2) Pilot with a
> handful of Indonesian families and two notaries (guardian role). 3) Conversations with Solana wallets about an
> embedded inheritance tab. 4) External audit, then mainnet.

**Demand validation — do this before submitting (5–10 conversations, 15 min each).**

Questions for crypto holders:
1. Do you hold crypto in self-custody? Roughly how much, as a share of your savings (bracket only)?
2. If something happened to you tomorrow, could your family access it? How?
3. Have you written your seed phrase down anywhere? Who knows where?
4. Would you use a tool that releases it to one person only if you stop checking in for N months, with 2–3 trusted
   guardians who must confirm?
5. Does it matter to you that your check-ins are not publicly linked to your wallet? Why?
6. What would you pay per month for reminders + an alarm if someone opens a claim? (0 / $1 / $3 / $5+)

Questions for notaries / financial planners:
1. Have clients asked about crypto in their wills? How do you handle it today?
2. Would you act as a guardian who confirms a claim but can never open the secret alone?
3. What would you need (legal, procedural) to offer this as a service?

Results — fill in with real answers only:

| # | Who (role, no names) | Self-custody? | Family could access today? | Would use? | Cares about private check-ins? | Would pay |
|---|---|---|---|---|---|---|
| 1 | ⟨…⟩ | | | | | |
| 2 | ⟨…⟩ | | | | | |
| 3 | ⟨…⟩ | | | | | |
| 4 | ⟨…⟩ | | | | | |
| 5 | ⟨…⟩ | | | | | |

**Demand validation (paste after filling).**
> We interviewed ⟨n⟩ self-custody holders and ⟨m⟩ notaries/planners. ⟨k⟩ of ⟨n⟩ said their family could not access
> their crypto today; ⟨…⟩ would use SIKRIT; ⟨…⟩ said private check-ins matter because ⟨quote⟩.

## 9. Prior work & third-party code (Rules §9)

> All SIKRIT code was written during the contest period (first commit 30 Sep 2026). Third-party open-source
> dependencies, used unmodified under their licenses: Anchor (Apache-2.0), curve25519-dalek (BSD-3-Clause), RustCrypto
> `sha2` (MIT/Apache-2.0), `@solana/web3.js` (MIT), Solana Wallet Adapter (Apache-2.0), noble-curves/hashes/ciphers
> (MIT), `shamir-secret-sharing` by Privy (Apache-2.0), React (MIT), Vite (MIT), Tailwind CSS (MIT), LiteSVM
> (MIT), Playwright (Apache-2.0); fonts Gloock, Schibsted Grotesk and Fragment Mono (SIL OFL 1.1). SIKRIT itself is
> MIT-licensed.

## 10. Final checklist (Bang Igan)

- [ ] Registered on colosseum.com for **Crypto World's Fair** (every team member)
- [ ] Repo pushed and **public**; README renders; `LICENSE` present
- [x] Program deployed to devnet; program ID + explorer link in README (`docs/` mentions updated) — done 1 Oct by the loop
- [ ] Live demo URL works (Vercel, with `RELAYER_SECRET_KEY` set — see PROGRESS.md "BUTUH BANG IGAN"): create a capsule as Pak Arif without any wallet
- [ ] Pitch video (≤ 3:00) and demo video (≤ 3:00) uploaded (unlisted is fine); links pasted above and in the form
- [ ] Deck PDF regenerated if anything changed (`cd app && npm run deck`)
- [ ] Demand validation filled with real interviews (§8)
- [ ] Team background + location filled (§6)
- [ ] Submitted before **13 Oct 2026, 13:59 WIB** (aim for 12 Oct, to leave margin)

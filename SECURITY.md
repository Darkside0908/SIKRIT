# Security policy

SIKRIT is a research prototype built for the Colosseum Crypto World's Fair hackathon. It runs on **Solana devnet
only**, has been self-audited but **not externally audited**, and must not protect real secrets or funds yet.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public
issue for anything that could let someone:

- claim a capsule early, or block an heir for longer than the documented bound;
- forge, replay or extend a heartbeat proof;
- link a capsule to its owner's wallet, or to a family member's wallet before that member acts;
- obtain a share, or the sealed secret, outside the release rules;
- make the relayer pay for anything other than a single SIKRIT instruction.

Include the commit, the steps or a proof of concept (a LiteSVM test in the style of `tests/sikrit.ts` is ideal), and
what you think the impact is. We aim to answer within a few days. Fixes are credited in the security review unless
you'd rather stay anonymous. There is no bug bounty.

## Before you report

Read the self-audit first: [docs/SECURITY-REVIEW.en.md](docs/SECURITY-REVIEW.en.md) (full Indonesian edition:
[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)). It lists every finding so far (SIK-01 to SIK-20) and the residual
risks we accept and publish (R1 to R18): heartbeat times are public, each family member is visible when they act,
guardians trust their RPC, enough colluding guardians can open a kit, the upgrade authority on devnet is a single key,
and more. A report that shows one of those is worse than we wrote is very welcome.

## Scope

| In scope | Out of scope |
|---|---|
| `programs/sikrit` (the Anchor program), `sdk/`, `app/` and its relayer service `app/api/relay.ts` | Third-party dependencies (report upstream; tell us if SIKRIT uses them unsafely) |
| The protocol: Fiat–Shamir transcripts, member commitments, the kit format, release rules | The demo personas' keys in `localStorage` (devnet-only by design, R16) |
| | Denial of service on public devnet RPCs or faucets |

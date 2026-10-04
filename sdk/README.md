# SIKRIT SDK

TypeScript client for the SIKRIT program: the zero-knowledge heartbeat, the capsule kit (Shamir + HPKE) and a small
program client. It uses no Anchor and no WASM. It runs on `@solana/web3.js`, the audited `@noble/*` libraries and
`shamir-secret-sharing`, and the same code runs in the demo app, in Node and in the tests.

The SDK is built to be reused. A wallet can add an inheritance tab, a relayer can carry heartbeats for anyone, a
watcher can warn owners when a claim opens, and a guardian (a notary, say) can run their own tools. A heartbeat needs
no signer, so none of them needs anyone's permission.

| File | What it gives you |
|---|---|
| [`liveness.ts`](liveness.ts) | liveness key from a wallet signature, Schnorr proofs (heartbeat, registration, update), member commitments, capsule address |
| [`kit.ts`](kit.ts) | inbox keys and invites, sealing a secret for the heir and guardians, checking a kit against the chain, release, recovery, JSON encoding |
| [`client.ts`](client.ts) | instruction builders, account decoder, program error names, `timeline()` |
| [`hpke.ts`](hpke.ts), [`shamir.ts`](shamir.ts) | the primitives underneath: HPKE RFC 9180 base mode, Shamir over GF(2^8) |

The snippets below follow one capsule from setup to recovery. The same flow runs as a test, with real transactions on
the program binary: the "Bapak A" story at the end of [`tests/sikrit.ts`](../tests/sikrit.ts). `wallet` stands for
any wallet adapter (`publicKey`, `signMessage`), `relayer` for whoever pays the fees.

## A heartbeat that names no one

```ts
import { SYSVAR_CLOCK_PUBKEY, Transaction } from "@solana/web3.js";
import * as liveness from "./sdk/liveness";
import { PROGRAM_ID, fetchCapsule, heartbeatIx } from "./sdk/client";

// x comes from a wallet signature over a fixed message. The wallet signs it twice and the two signatures must match,
// so x can be re-derived years later. x is not the wallet key, and the wallet never signs a transaction.
const x = await liveness.deriveLivenessSecretFromWallet(wallet.publicKey.toBytes(), wallet.signMessage);
const P = liveness.commitmentFromSecret(x);                 // public key x·G, stored in the capsule
const [capsule] = liveness.capsulePda(PROGRAM_ID, P);       // the address comes from P, never from a wallet

// One proof per heartbeat: bound to the capsule's nonce and to an expiry on the cluster clock (at most 1 hour ahead).
const state = await fetchCapsule(connection, capsule);
const now = (await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32);
const expiresAt = now + liveness.DEFAULT_PROOF_LIFETIME;    // 10 minutes
const proof = liveness.proveLiveness(x, PROGRAM_ID, capsule, state!.heartbeatNonce, expiresAt);

// Anyone can pay for it. Never the owner's wallet: that one transaction would link wallet and capsule.
const heartbeat = new Transaction().add(heartbeatIx({ capsule, proof, expiresAt }));
heartbeat.feePayer = relayer.publicKey;
```

The program checks `now ≤ expiresAt ≤ now + 3600` and `s·G − e·P == R` with Solana's curve25519 syscalls (~41k CU).
A proof works once (the nonce moves on) and dies at its expiry, so a relayer that holds one back can't use it later.

## Owner: seal the secret, register the capsule

```ts
import * as kit from "./sdk/kit";
import { createCapsuleIx } from "./sdk/client";

// Every holder (the heir, then each guardian) derives an inbox key from their own wallet and sends an invite.
const { certificate } = await kit.createInbox(holder.publicKey.toBytes(), holder.signMessage);
const invite = kit.encodeInboxCertificate(certificate);     // "sikrit-invite:v1:…", fine to send over any channel

// The owner reads the invites back: a key swapped in transit fails the wallet signature check.
const heir = kit.decodeInboxCertificate(heirInvite);
const guardians = guardianInvites.map(kit.decodeInboxCertificate);
const sealed = await kit.sealCapsuleKit({
  secret: new TextEncoder().encode(seedPhrase),
  commitment: P,
  heir,
  guardians,                                                // 1 to 5
  threshold: 3,                                             // the heir's share + 2 guardian shares
});

// On-chain, the family is only salted commitments; the salts travel in the kit.
const roster = kit.rosterCommitments(sealed);
const config = {
  heirCommitment: roster.heir,
  heartbeatInterval: 30n * 86_400n,                         // seconds
  gracePeriod: 7n * 86_400n,
  guardianCommitments: roster.guardians,
  guardianThreshold: 2,                                     // = threshold − 1
  shareHashes: sealed.shareHashes,
};
const registration = liveness.proveRegistration(x, PROGRAM_ID, capsule, config);
const create = createCapsuleIx({ payer: relayer.publicKey, commitment: P, config, proof: registration });

const file = kit.encodeKit(sealed);                         // JSON for the heir and each guardian, nobody else
```

`proveRegistration` signs the whole configuration, share hashes included, so nobody can register a capsule under
someone else's P or change its rules. Share 0 goes to the heir and share 1 + g to guardian g. The heir alone holds
less than the threshold and learns nothing until guardians release their shares.

## Owner: change the heir, guardians or rules

```ts
import { updateCapsuleIx } from "./sdk/client";

// Same P, same address. Re-seal for whoever should hold a share now: a fresh key, fresh shares, fresh salts.
const resealed = await kit.sealCapsuleKit({
  secret: new TextEncoder().encode(seedPhrase),
  commitment: P,
  heir: newHeir,
  guardians: newGuardians,
  threshold: 2,
});
const next = kit.rosterCommitments(resealed);
const newConfig = {
  ...config,
  heirCommitment: next.heir,
  guardianCommitments: next.guardians,
  guardianThreshold: 1,                                     // = threshold − 1
  shareHashes: resealed.shareHashes,
};

// Proven like a heartbeat, over the whole new config: no signer, and a relayer can neither alter nor replay it.
const current = await fetchCapsule(connection, capsule);
const updateProof = liveness.proveUpdate(x, PROGRAM_ID, capsule, current!.heartbeatNonce, expiresAt, newConfig);
const update = updateCapsuleIx({ capsule, config: newConfig, proof: updateProof, expiresAt });
```

An update counts as a heartbeat (it also cancels a pending claim) and is refused once the capsule is claimed. The old
kit no longer matches the chain, so `verifyKit` and `releaseShare` reject it: send the new file to everyone who holds a
share. Shares already handed out cannot be taken back, though. If you remove someone you no longer trust, move the
funds behind the secret as well (R19).

## Guardian: confirm, then release

```ts
import { guardianConfirmIx } from "./sdk/client";

const myKit = kit.decodeKit(file);
const me = kit.membership(myKit, guardian.publicKey.toBytes())!;   // index, role, slot, salt
const onChain = await fetchCapsule(connection, capsule);
const chain = {
  ...onChain!,
  claimed: onChain!.status === "claimed",
  heir: onChain!.heir?.toBytes() ?? null,                   // revealed by the claim, null before
};
kit.verifyKit(myKit, chain);                                // this kit belongs to this capsule and opens its roster

// While a claim is pending: confirm it (or veto it with guardianVetoIx if the owner is alive).
// The salt opens your commitment: this transaction is the first time the chain sees your wallet.
const confirm = guardianConfirmIx({ capsule, guardian: guardian.publicKey, slot: me.slot, salt: me.salt });

// Once the heir has claimed: open your share and re-seal it to the committed heir's inbox.
const inbox = await kit.createInbox(guardian.publicKey.toBytes(), guardian.signMessage);
const share = kit.openShare(myKit, me.index, inbox.keyPair.secretKey);
const release = kit.releaseShare(myKit, share, chain);     // refuses unless Claimed, by the committed heir
```

`releaseShare` re-checks the kit against the chain and refuses if the capsule is not `Claimed`, if the chain names a
heir other than the committed one, or if the target inbox is not certified by that heir.

## Heir: claim and recover

```ts
import { claimIx } from "./sdk/client";

const mine = kit.membership(myKit, heirWallet.publicKey.toBytes())!;
const claim = claimIx({ capsule, heir: heirWallet.publicKey, salt: mine.salt });  // after the grace period + quorum

const heirInbox = await kit.createInbox(heirWallet.publicKey.toBytes(), heirWallet.signMessage);
const own = kit.openShare(myKit, 0, heirInbox.keyPair.secretKey);
const released = releases.map((r) => kit.openRelease(myKit, r, heirInbox.keyPair.secretKey));
const secret = await kit.recoverSecret(myKit, [own, ...released]);
```

Every share is checked against the hashes the owner committed on-chain before it is combined, and the payload's AEAD
tag authenticates the result. A wrong share fails with a clear error instead of producing a wrong secret.

## Relayers and watchers

- **Relayer.** `heartbeat`, `update_capsule` and `trigger_claim` take no signer, so any fee payer can submit them. The relayer in the demo
  ([`app/api/relay.ts`](../app/api/relay.ts), about 200 lines) adds a policy around that: exactly one SIKRIT
  instruction per transaction, with exactly that instruction's accounts, and the relayer only as fee payer or as the
  rent payer of `create_capsule`. That policy leaves it nothing to sign except SIKRIT fees, at most two signatures'
  worth per transaction (the program ignores extra accounts, so a relayer that accepted them would pay for padding).
- **Watcher.** `fetchCapsule` + `timeline(capsule, now)` give `canTrigger`, `canVeto`, `canClaim` and the deadlines.
  An owner's watcher that sees a pending claim should alert them while a heartbeat can still cancel it. The program
  also emits Anchor events: `CapsuleCreated`, `HeartbeatVerified`, `CapsuleUpdated`, `ClaimTriggered`,
  `GuardianConfirmed`, `ClaimVetoed`, `CapsuleClaimed`.
- **Errors.** `explainError(e)` maps program error codes to names and messages (`PROGRAM_ERRORS`).

## Formats are pinned

| Format | Pinned by |
|---|---|
| Heartbeat challenge: `SHA-512("SIKRIT:liveness:v2" ‖ program ‖ capsule ‖ P ‖ R ‖ nonce u64 LE ‖ expires_at i64 LE) mod ℓ` | known-answer vector shared by `tests/sikrit.ts` and the Rust unit tests |
| Registration challenge: `"SIKRIT:register:v2"`, context = Borsh(`CapsuleConfig`) | same |
| Update challenge: `"SIKRIT:update:v1"`, context = nonce u64 LE ‖ expires_at i64 LE ‖ Borsh(`CapsuleConfig`) | a second known-answer vector, same tests |
| Member commitment: `SHA-256("SIKRIT:member:v1" ‖ P ‖ role ‖ wallet ‖ salt)`, role 0 heir, 1 guardian | vector recomputed with Python `hashlib`, in TS and Rust tests |
| Kit v2: payload, share, release, share-hash and inbox domains (`SIKRIT:*:v1`) | vectors in `tests/sdk.ts`; HPKE also against RFC 9180 A.2.1 |

A change to any of these is a new version: the program rejects old proofs and the SDK refuses older kits and capsule
layouts with an explicit message.

## Rules for integrators

1. Never let the owner's wallet pay for, or sign, a capsule transaction (R2 in the
   [security review](../docs/SECURITY-REVIEW.en.md)).
2. The kit names the whole family (wallets and salts): send it only to the holders (R3).
3. Derive keys only from wallets that sign deterministically (`deriveLivenessSecretFromWallet` and `createInbox` check
   this), and only ask for those signatures on your own origin (R9, R12).
4. A guardian should check the `claim` transaction on an explorer, or on a second RPC, before releasing (R17).
5. This is a research prototype: self-audited, not externally audited, devnet only.

Program ID (devnet): `FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F`. MIT licensed.

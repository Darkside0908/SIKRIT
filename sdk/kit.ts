/**
 * SIKRIT — capsule kit: how the owner's secret is sealed for the heir and the guardians.
 *
 *   dek      ← 32 random bytes
 *   payload  = nonce ‖ XChaCha20-Poly1305(dek, nonce, aad = "SIKRIT:payload:v1" ‖ P ‖ k ‖ n)(secret)
 *   share_i  = Shamir k-of-n share of dek (33 bytes)                                 sdk/shamir.ts
 *   sealed_i = HPKE.Seal(inbox_i, info = "SIKRIT:share:v1" ‖ P, aad = i)(share_i)    sdk/hpke.ts
 *   hash_i   = SHA-256("SIKRIT:share-hash:v1" ‖ P ‖ share_i)  →  on-chain `share_hashes[i]`
 *
 * P is the capsule's liveness commitment, so every ciphertext and hash is bound to one capsule,
 * and the owner's proof-of-possession in `create_capsule` signs the hashes along with the rest of
 * the config. Only a random key is ever split (the Shamir library's own recommendation), which
 * keeps shares fixed-size and lets the payload AEAD tag authenticate the reconstruction.
 *
 * Custody (SIK-11): share 0 → heir, share 1 + g → guardians[g], and k − 1 = the guardian quorum.
 * The heir alone holds fewer than k shares and learns nothing until guardians release theirs after
 * the on-chain claim: `releaseShare` re-seals a guardian's share to the heir's inbox key (info
 * "SIKRIT:release:v1"). Every share is checked against the committed hashes before combining, so
 * a wrong share is rejected by name instead of silently corrupting the result.
 *
 * Inbox keys are X25519 keys derived from a wallet signature (`deriveInboxKeyPair`), so holders can
 * re-derive them years later from the same wallet. Each one travels inside an inbox certificate —
 * signed by that same wallet, i.e. the heir or guardian address registered on-chain — so neither
 * the owner (when sealing) nor a guardian (when releasing) can be tricked into encrypting a share
 * to a key an attacker swapped in.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";

import * as hpke from "./hpke";
import { combineShares, splitSecret } from "./shamir";

export const KIT_VERSION = 1;
/** Random data-encryption key that is actually split. */
export const DEK_LENGTH = 32;
export const SHARE_LENGTH = DEK_LENGTH + 1;
export const SEALED_SHARE_LENGTH = SHARE_LENGTH + hpke.SEAL_OVERHEAD;
/** One on-chain hash per share: heir + up to 5 guardians (program: MAX_GUARDIANS = 5, MAX_SHARES = 10). */
export const MAX_KIT_SHARES = 6;
/** Seed phrases, passwords and short notes; the kit is off-chain but meant to be shareable. */
export const MAX_SECRET_LENGTH = 4096;

const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

const PAYLOAD_DOMAIN = utf8ToBytes("SIKRIT:payload:v1");
const SHARE_DOMAIN = utf8ToBytes("SIKRIT:share:v1");
const RELEASE_DOMAIN = utf8ToBytes("SIKRIT:release:v1");
const SHARE_HASH_DOMAIN = utf8ToBytes("SIKRIT:share-hash:v1");
const INBOX_DOMAIN = utf8ToBytes("SIKRIT:inbox:v1");

/** Message a heir's or guardian's wallet signs to (re)derive its inbox key; see `deriveInboxKeyPair`. */
export const INBOX_MESSAGE = utf8ToBytes(
  "SIKRIT inbox key v1. Only sign this message on the SIKRIT app.",
);

/** An inbox key vouched for by the wallet that will be registered on-chain as heir or guardian. */
export interface InboxCertificate {
  /** Holder's Solana wallet (Ed25519 public key). */
  wallet: Uint8Array;
  /** X25519 inbox public key derived from that wallet. */
  inbox: Uint8Array;
  /** Wallet signature over `inboxCertificateMessage(inbox)`. */
  signature: Uint8Array;
}

export interface SealedShare {
  holder: InboxCertificate;
  /** HPKE box (enc ‖ ciphertext ‖ tag) only the holder's inbox secret key opens. */
  sealed: Uint8Array;
}

export interface CapsuleKit {
  version: number;
  /** Liveness commitment P of the capsule this kit belongs to. */
  commitment: Uint8Array;
  /** Shares needed to reconstruct (Shamir k). */
  threshold: number;
  /** nonce ‖ XChaCha20-Poly1305 ciphertext ‖ tag of the secret. */
  payload: Uint8Array;
  /** shares[0] belongs to the heir, shares[1 + g] to guardians[g]; same order as `shareHashes`. */
  shares: SealedShare[];
  /** Share commitments, passed to `create_capsule` as `CapsuleConfig.share_hashes`. */
  shareHashes: Uint8Array[];
}

export interface SealParams {
  secret: Uint8Array;
  commitment: Uint8Array;
  heir: InboxCertificate;
  guardians: InboxCertificate[];
  /** Shares needed to reconstruct: the heir's share plus `threshold − 1` guardian shares. */
  threshold: number;
}

/** What a kit is checked against: the capsule account as read from the chain. */
export interface CapsuleState {
  commitment: Uint8Array;
  heir: Uint8Array;
  guardians: Uint8Array[];
  shareHashes: Uint8Array[];
  claimed: boolean;
}

const u8 = (n: number): Uint8Array => Uint8Array.of(n);

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const payloadAad = (commitment: Uint8Array, threshold: number, shares: number): Uint8Array =>
  concatBytes(PAYLOAD_DOMAIN, commitment, u8(threshold), u8(shares));

const shareInfo = (commitment: Uint8Array): Uint8Array => concatBytes(SHARE_DOMAIN, commitment);

const releaseInfo = (commitment: Uint8Array): Uint8Array => concatBytes(RELEASE_DOMAIN, commitment);

/** On-chain commitment to one plaintext share, bound to its capsule. */
export function shareHash(commitment: Uint8Array, share: Uint8Array): Uint8Array {
  return sha256(concatBytes(SHARE_HASH_DOMAIN, commitment, share));
}

// -----------------------------------------------------------------------------
// Inbox keys & certificates
// -----------------------------------------------------------------------------

/** Deterministic inbox key pair from a wallet's Ed25519 signature over `INBOX_MESSAGE`. */
export function deriveInboxKeyPair(walletSignature: Uint8Array): hpke.KeyPair {
  if (walletSignature.length !== SIGNATURE_LENGTH) throw new Error("kit: expected a 64-byte Ed25519 signature");
  return hpke.deriveKeyPair(concatBytes(INBOX_DOMAIN, walletSignature));
}

/** Human-readable text the holder's wallet signs to vouch for its inbox key. */
export function inboxCertificateMessage(inbox: Uint8Array): Uint8Array {
  return utf8ToBytes(`SIKRIT inbox certificate v1: ${bytesToHex(inbox)}`);
}

export function verifyInboxCertificate(certificate: InboxCertificate): boolean {
  const { wallet, inbox, signature } = certificate;
  if (wallet.length !== KEY_LENGTH || inbox.length !== KEY_LENGTH || signature.length !== SIGNATURE_LENGTH) return false;
  try {
    return ed25519.verify(signature, inboxCertificateMessage(inbox), wallet);
  } catch {
    return false;
  }
}

/**
 * Holder onboarding with any wallet that exposes `signMessage` (wallet adapters do). Signs
 * `INBOX_MESSAGE` twice and refuses to continue unless both signatures are identical and valid:
 * a wallet with randomized signatures (some MPC/threshold wallets) could never re-derive the key.
 */
export async function createInbox(
  wallet: Uint8Array,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<{ keyPair: hpke.KeyPair; certificate: InboxCertificate }> {
  const first = await signMessage(INBOX_MESSAGE);
  const second = await signMessage(INBOX_MESSAGE);
  if (!ed25519.verify(first, INBOX_MESSAGE, wallet)) throw new Error("kit: signature does not match the wallet");
  if (!equalBytes(first, second)) {
    throw new Error("kit: this wallet does not sign deterministically, so its inbox key could not be recovered later");
  }
  const keyPair = deriveInboxKeyPair(first);
  const certificate = {
    wallet: Uint8Array.from(wallet),
    inbox: keyPair.publicKey,
    signature: await signMessage(inboxCertificateMessage(keyPair.publicKey)),
  };
  if (!verifyInboxCertificate(certificate)) throw new Error("kit: certificate signature does not match the wallet");
  return { keyPair, certificate };
}

const INVITE_PREFIX = "sikrit-invite:v1:";

/** Single-line token a holder sends the owner: wallet ‖ inbox ‖ signature, hex. */
export function encodeInboxCertificate(certificate: InboxCertificate): string {
  return INVITE_PREFIX + bytesToHex(concatBytes(certificate.wallet, certificate.inbox, certificate.signature));
}

/** Parses and verifies an invite token; throws unless the wallet really signed the inbox key. */
export function decodeInboxCertificate(text: string): InboxCertificate {
  const token = text.trim();
  if (!token.startsWith(INVITE_PREFIX)) throw new Error("kit: not a SIKRIT invite");
  const bytes = hexField(token.slice(INVITE_PREFIX.length), "invite", 2 * KEY_LENGTH + SIGNATURE_LENGTH);
  const certificate = {
    wallet: bytes.slice(0, KEY_LENGTH),
    inbox: bytes.slice(KEY_LENGTH, 2 * KEY_LENGTH),
    signature: bytes.slice(2 * KEY_LENGTH),
  };
  if (!verifyInboxCertificate(certificate)) throw new Error("kit: invite signature is invalid");
  return certificate;
}

// -----------------------------------------------------------------------------
// Sealing, verification, release and recovery
// -----------------------------------------------------------------------------

/** Owner side: encrypts `secret`, splits its key and seals one share to each certified holder. */
export async function sealCapsuleKit({ secret, commitment, heir, guardians, threshold }: SealParams): Promise<CapsuleKit> {
  const holders = [heir, ...guardians];
  if (commitment.length !== KEY_LENGTH) throw new Error("kit: commitment must be 32 bytes");
  if (secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
    throw new Error(`kit: secret must be 1..${MAX_SECRET_LENGTH} bytes`);
  }
  if (guardians.length === 0 || holders.length > MAX_KIT_SHARES) {
    throw new Error(`kit: need 1..${MAX_KIT_SHARES - 1} guardians`);
  }
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > holders.length) {
    throw new Error("kit: threshold must be between 2 and the number of holders");
  }
  holders.forEach((holder, i) => {
    if (!verifyInboxCertificate(holder)) throw new Error("kit: invalid inbox certificate");
    // One wallet or one inbox holding two shares would let a single holder cross the threshold alone.
    for (const other of holders.slice(0, i)) {
      if (equalBytes(other.wallet, holder.wallet)) throw new Error("kit: duplicate holder wallet");
      if (equalBytes(other.inbox, holder.inbox)) throw new Error("kit: duplicate holder inbox key");
    }
  });

  const dek = randomBytes(DEK_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const payload = concatBytes(
    nonce,
    xchacha20poly1305(dek, nonce, payloadAad(commitment, threshold, holders.length)).encrypt(secret),
  );
  const shares = await splitSecret(dek, holders.length, threshold);
  dek.fill(0);

  const kit: CapsuleKit = {
    version: KIT_VERSION,
    commitment: Uint8Array.from(commitment),
    threshold,
    payload,
    shares: holders.map((holder, i) => ({
      holder: copyCertificate(holder),
      sealed: hpke.seal(holder.inbox, shareInfo(commitment), shares[i], u8(i)),
    })),
    shareHashes: shares.map((share) => shareHash(commitment, share)),
  };
  shares.forEach((share) => share.fill(0));
  return kit;
}

/**
 * Rejects a kit that does not belong to the on-chain capsule: commitment, share hashes, and
 * holders certified by exactly the heir and guardian wallets registered on-chain, in order.
 */
export function verifyKit(kit: CapsuleKit, state: Omit<CapsuleState, "claimed">): void {
  if (!equalBytes(kit.commitment, state.commitment)) throw new Error("kit: belongs to a different capsule");
  const hashesMatch =
    kit.shareHashes.length === state.shareHashes.length &&
    kit.shareHashes.every((hash, i) => equalBytes(hash, state.shareHashes[i]));
  if (!hashesMatch) throw new Error("kit: share hashes do not match the capsule on-chain");

  const wallets = [state.heir, ...state.guardians];
  const holdersMatch =
    kit.shares.length === wallets.length && kit.shares.every((entry, i) => equalBytes(entry.holder.wallet, wallets[i]));
  if (!holdersMatch) throw new Error("kit: holders are not the capsule's heir and guardians");
  if (!kit.shares.every((entry) => verifyInboxCertificate(entry.holder))) {
    throw new Error("kit: invalid inbox certificate");
  }
}

/** Position of the share sealed to `inboxPublicKey`, or −1. */
export function findShareIndex(kit: CapsuleKit, inboxPublicKey: Uint8Array): number {
  return kit.shares.findIndex((entry) => equalBytes(entry.holder.inbox, inboxPublicKey));
}

/** Position of the committed hash `share` matches, or −1. */
export function shareIndexOf(kit: CapsuleKit, share: Uint8Array): number {
  const hash = shareHash(kit.commitment, share);
  return kit.shareHashes.findIndex((committed) => equalBytes(committed, hash));
}

/** Holder side: opens share `index` with the holder's inbox secret key and checks its hash. */
export function openShare(kit: CapsuleKit, index: number, inboxSecretKey: Uint8Array): Uint8Array {
  const entry = kit.shares[index];
  if (!entry) throw new Error("kit: no share at this index");
  const share = hpke.open(inboxSecretKey, shareInfo(kit.commitment), entry.sealed, u8(index));
  if (shareIndexOf(kit, share) !== index) throw new Error("kit: share does not match its committed hash");
  return share;
}

/**
 * Guardian side: re-seals an opened share to the heir — only for a kit that matches the chain,
 * only once the capsule is `Claimed`, and only to an inbox key certified by the on-chain heir
 * wallet (the kit's own heir certificate by default, or a fresh one if the heir rotated keys).
 * Checking the chain first is the guardian's promise, not something the cryptography can force
 * (see SIK-11 in docs/SECURITY-REVIEW.md).
 */
export function releaseShare(
  kit: CapsuleKit,
  share: Uint8Array,
  state: CapsuleState,
  heirCertificate: InboxCertificate = kit.shares[0].holder,
): Uint8Array {
  verifyKit(kit, state);
  if (!state.claimed) throw new Error("kit: the capsule has not been claimed on-chain");
  if (!equalBytes(heirCertificate.wallet, state.heir) || !verifyInboxCertificate(heirCertificate)) {
    throw new Error("kit: release target is not certified by the on-chain heir");
  }
  if (shareIndexOf(kit, share) < 1) throw new Error("kit: refusing to release a share that is not a guardian share of this kit");
  return hpke.seal(heirCertificate.inbox, releaseInfo(kit.commitment), share);
}

/** Heir side: opens a guardian's release and authenticates the share against the committed hashes. */
export function openRelease(kit: CapsuleKit, release: Uint8Array, heirInboxSecretKey: Uint8Array): Uint8Array {
  const share = hpke.open(heirInboxSecretKey, releaseInfo(kit.commitment), release);
  if (shareIndexOf(kit, share) < 0) throw new Error("kit: released share does not match any committed hash");
  return share;
}

/** Heir side: combines ≥ threshold authenticated shares and decrypts the payload. */
export async function recoverSecret(kit: CapsuleKit, shares: Uint8Array[]): Promise<Uint8Array> {
  const byIndex = new Map<number, Uint8Array>();
  for (const share of shares) {
    const index = shareIndexOf(kit, share);
    if (index < 0) throw new Error("kit: share does not match any committed hash");
    byIndex.set(index, share);
  }
  if (byIndex.size < kit.threshold) {
    throw new Error(`kit: need ${kit.threshold} distinct shares, have ${byIndex.size}`);
  }

  const dek = await combineShares([...byIndex.values()].slice(0, kit.threshold));
  try {
    const nonce = kit.payload.subarray(0, NONCE_LENGTH);
    const aad = payloadAad(kit.commitment, kit.threshold, kit.shares.length);
    return xchacha20poly1305(dek, nonce, aad).decrypt(kit.payload.subarray(NONCE_LENGTH));
  } catch {
    throw new Error("kit: payload authentication failed");
  } finally {
    dek.fill(0);
  }
}

// -----------------------------------------------------------------------------
// Portable encoding (JSON; wallets base58, everything else hex)
// -----------------------------------------------------------------------------

const KIT_TAG = "sikrit-capsule-kit";

const copyCertificate = (certificate: InboxCertificate): InboxCertificate => ({
  wallet: Uint8Array.from(certificate.wallet),
  inbox: Uint8Array.from(certificate.inbox),
  signature: Uint8Array.from(certificate.signature),
});

export function encodeKit(kit: CapsuleKit): string {
  return JSON.stringify({
    sikrit: KIT_TAG,
    v: kit.version,
    commitment: bytesToHex(kit.commitment),
    threshold: kit.threshold,
    payload: bytesToHex(kit.payload),
    shares: kit.shares.map(({ holder, sealed }) => ({
      wallet: new PublicKey(holder.wallet).toBase58(),
      inbox: bytesToHex(holder.inbox),
      signature: bytesToHex(holder.signature),
      sealed: bytesToHex(sealed),
    })),
    shareHashes: kit.shareHashes.map(bytesToHex),
  });
}

function hexField(value: unknown, name: string, length?: number): Uint8Array {
  if (typeof value !== "string" || !/^([0-9a-f]{2})*$/.test(value)) throw new Error(`kit: ${name} must be lowercase hex`);
  const bytes = hexToBytes(value);
  if (length !== undefined && bytes.length !== length) throw new Error(`kit: ${name} must be ${length} bytes`);
  return bytes;
}

function walletField(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Error("kit: wallet must be a base58 address");
  try {
    return new PublicKey(value).toBytes();
  } catch {
    throw new Error("kit: wallet must be a base58 address");
  }
}

/** Strict parser: anything that is not a well-formed v1 kit is rejected. */
export function decodeKit(text: string): CapsuleKit {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("kit: not valid JSON");
  }
  if (json?.sikrit !== KIT_TAG) throw new Error("kit: not a SIKRIT capsule kit");
  if (json.v !== KIT_VERSION) throw new Error(`kit: unsupported version ${json.v}`);
  if (!Array.isArray(json.shares) || !Array.isArray(json.shareHashes)) throw new Error("kit: malformed share list");

  const n = json.shares.length;
  if (n < 2 || n > MAX_KIT_SHARES || json.shareHashes.length !== n) throw new Error("kit: malformed share list");
  if (!Number.isInteger(json.threshold) || json.threshold < 2 || json.threshold > n) {
    throw new Error("kit: invalid threshold");
  }
  const payload = hexField(json.payload, "payload");
  if (payload.length < NONCE_LENGTH + TAG_LENGTH + 1) throw new Error("kit: payload too short");

  return {
    version: json.v,
    commitment: hexField(json.commitment, "commitment", KEY_LENGTH),
    threshold: json.threshold,
    payload,
    shares: json.shares.map((entry: Record<string, unknown> | null) => ({
      holder: {
        wallet: walletField(entry?.wallet),
        inbox: hexField(entry?.inbox, "inbox", KEY_LENGTH),
        signature: hexField(entry?.signature, "signature", SIGNATURE_LENGTH),
      },
      sealed: hexField(entry?.sealed, "sealed share", SEALED_SHARE_LENGTH),
    })),
    shareHashes: json.shareHashes.map((hash: unknown) => hexField(hash, "share hash", KEY_LENGTH)),
  };
}

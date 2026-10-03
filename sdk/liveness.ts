/**
 * SIKRIT — ZK Proof-of-Liveness (client-side prover).
 *
 * Schnorr proof-of-knowledge of x (P = x·G) over the Ed25519 prime-order subgroup, made
 * non-interactive with Fiat–Shamir. Mirrors the `schnorr` module in programs/sikrit/src/lib.rs
 * byte-for-byte:
 *
 *   e     = SHA-512(domain ‖ program_id ‖ capsule ‖ P ‖ R ‖ context) mod ℓ
 *   proof = (R = k·G, s = k + e·x mod ℓ)          verifier: s·G − e·P == R
 *
 * `context` is the capsule's `heartbeat_nonce` (u64 LE) ‖ `expires_at` (i64 LE) for liveness proofs, the Borsh
 * encoding of `CapsuleConfig` for the proof-of-possession sent with `create_capsule`, and nonce ‖ expires_at ‖
 * Borsh(CapsuleConfig) for `update_capsule`.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";

const Point = ed25519.Point;

/** Order ℓ of the Ed25519 prime-order subgroup. */
export const L = ed25519.CURVE.n;

export const CAPSULE_SEED = utf8ToBytes("capsule");
export const REGISTER_DOMAIN = utf8ToBytes("SIKRIT:register:v2");
export const LIVENESS_DOMAIN = utf8ToBytes("SIKRIT:liveness:v2");
export const UPDATE_DOMAIN = utf8ToBytes("SIKRIT:update:v1");
export const MEMBER_DOMAIN = utf8ToBytes("SIKRIT:member:v1");

/** The program refuses liveness proofs that expire more than this far ahead (seconds). */
export const MAX_PROOF_LIFETIME = 3600n;
/** Lifetime the app gives a heartbeat proof: ample for a relayer, useless to anyone who holds it back. */
export const DEFAULT_PROOF_LIFETIME = 600n;

/** Role byte of a member commitment (`ROLE_HEIR` / `ROLE_GUARDIAN` on-chain). */
export const MemberRole = { heir: 0, guardian: 1 } as const;
export type MemberRole = (typeof MemberRole)[keyof typeof MemberRole];
const NONCE_DOMAIN = utf8ToBytes("SIKRIT:nonce:v1");
const KEYGEN_DOMAIN = utf8ToBytes("SIKRIT:keygen:v1");

/** Message the owner's wallet signs to (re)derive the liveness secret; see `deriveLivenessSecret`. */
export const KEYGEN_MESSAGE = utf8ToBytes(
  "SIKRIT liveness key v1. Only sign this message on the SIKRIT app.",
);

/** Matches the Anchor `SchnorrProof` argument type. */
export interface SchnorrProof {
  r: number[];
  s: number[];
}

/**
 * Matches the Anchor `CapsuleConfig` argument type (numbers are i64 seconds). Heir and guardians appear only as
 * member commitments (`memberCommitment`), never as wallets.
 */
export interface CapsuleConfigInput {
  heirCommitment: Uint8Array;
  heartbeatInterval: bigint;
  gracePeriod: bigint;
  guardianCommitments: Uint8Array[];
  guardianThreshold: number;
  shareHashes: Uint8Array[];
}

const mod = (a: bigint): bigint => ((a % L) + L) % L;

/** Little-endian bytes → integer (curve25519-dalek scalar encoding). */
export function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** Integer → little-endian bytes of fixed length. */
export function numberToBytesLE(n: bigint, length = 32): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Same as `Scalar::from_bytes_mod_order_wide` for a 64-byte hash. */
const wideReduce = (digest: Uint8Array): bigint => mod(bytesToNumberLE(digest));

/** Fresh, uniformly random liveness secret x ∈ [1, ℓ). */
export function generateLivenessSecret(): bigint {
  for (;;) {
    const x = wideReduce(randomBytes(64));
    if (x !== 0n) return x;
  }
}

/**
 * Deterministic liveness secret from the owner's wallet signature over `KEYGEN_MESSAGE`.
 * Ed25519 signatures are deterministic, so the owner can always re-derive x (and find the
 * capsule via P) from the same wallet without storing anything, while x itself is never the
 * wallet key and never touches the chain.
 */
export function deriveLivenessSecret(walletSignature: Uint8Array): bigint {
  const x = wideReduce(sha512(concatBytes(KEYGEN_DOMAIN, walletSignature)));
  if (x === 0n) throw new Error("degenerate liveness secret");
  return x;
}

/**
 * Owner setup with any wallet that exposes `signMessage` (wallet adapters do). Signs
 * `KEYGEN_MESSAGE` twice and refuses wallets whose signatures are not deterministic (some
 * MPC/threshold wallets): with those the owner could never re-derive x, stop proving liveness,
 * and the capsule would open while they are still alive. Later sessions sign once and compare
 * `commitmentFromSecret(x)` with the capsule's commitment.
 */
export async function deriveLivenessSecretFromWallet(
  wallet: Uint8Array,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<bigint> {
  const first = await signMessage(KEYGEN_MESSAGE);
  const second = await signMessage(KEYGEN_MESSAGE);
  if (!ed25519.verify(first, KEYGEN_MESSAGE, wallet)) throw new Error("liveness: signature does not match the wallet");
  if (first.length !== second.length || first.some((byte, i) => byte !== second[i])) {
    throw new Error("liveness: this wallet does not sign deterministically, so the liveness key could not be re-derived");
  }
  return deriveLivenessSecret(first);
}

/** Public commitment P = x·G (32-byte compressed Edwards point). */
export function commitmentFromSecret(x: bigint): Uint8Array {
  return Point.BASE.multiply(x).toBytes();
}

/** Capsule PDA = ["capsule", P]. Derived from the liveness key only — never from a wallet. */
export function capsulePda(programId: PublicKey, commitment: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CAPSULE_SEED, commitment], programId);
}

/** Fiat–Shamir challenge, identical to `schnorr::challenge` on-chain. */
export function challenge(
  programId: PublicKey,
  domain: Uint8Array,
  capsule: PublicKey,
  commitment: Uint8Array,
  r: Uint8Array,
  context: Uint8Array,
): bigint {
  return wideReduce(
    sha512(concatBytes(domain, programId.toBytes(), capsule.toBytes(), commitment, r, context)),
  );
}

const i64 = (n: bigint): Uint8Array => numberToBytesLE(BigInt.asUintN(64, n), 8);

/** `heartbeat_nonce` (u64 LE) ‖ `expires_at` (i64 LE) — the liveness proof context. */
export function livenessContext(nonce: bigint | number, expiresAt: bigint | number): Uint8Array {
  return concatBytes(numberToBytesLE(BigInt(nonce), 8), i64(BigInt(expiresAt)));
}

/**
 * Salted commitment to a capsule member, identical to `member_commitment` on-chain:
 * SHA-256("SIKRIT:member:v1" ‖ P ‖ role ‖ wallet ‖ salt). With a fresh random 32-byte salt per member it hides
 * the wallet (no guessing through every Solana address) and does not link the same person across capsules.
 */
export function memberCommitment(
  commitment: Uint8Array,
  role: MemberRole,
  wallet: PublicKey | Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  const walletBytes = wallet instanceof PublicKey ? wallet.toBytes() : wallet;
  if (commitment.length !== 32 || walletBytes.length !== 32 || salt.length !== 32) {
    throw new Error("liveness: member commitment inputs must be 32 bytes each");
  }
  return sha256(concatBytes(MEMBER_DOMAIN, commitment, Uint8Array.of(role), walletBytes, salt));
}

/** Borsh encoding of `CapsuleConfig` — the proof-of-possession context. */
export function encodeCapsuleConfig(config: CapsuleConfigInput): Uint8Array {
  const u32 = (n: number) => numberToBytesLE(BigInt(n), 4);
  return concatBytes(
    config.heirCommitment,
    i64(config.heartbeatInterval),
    i64(config.gracePeriod),
    u32(config.guardianCommitments.length),
    ...config.guardianCommitments,
    Uint8Array.of(config.guardianThreshold),
    u32(config.shareHashes.length),
    ...config.shareHashes,
  );
}

/**
 * Hedged deterministic nonce (RFC 6979 / BIP-340 style): k depends on x, fresh randomness and
 * the transcript, so neither a broken RNG nor a repeated `aux` alone can cause the nonce reuse
 * that would leak x.
 */
function deriveNonce(x: bigint, aux: Uint8Array, transcript: Uint8Array): bigint {
  for (let counter = 0; ; counter++) {
    const k = wideReduce(
      sha512(concatBytes(NONCE_DOMAIN, numberToBytesLE(x), aux, transcript, Uint8Array.of(counter))),
    );
    if (k !== 0n) return k;
  }
}

/** Generic Schnorr prover. `aux` defaults to 32 fresh random bytes. */
export function prove(
  x: bigint,
  programId: PublicKey,
  domain: Uint8Array,
  capsule: PublicKey,
  context: Uint8Array,
  aux: Uint8Array = randomBytes(32),
): SchnorrProof {
  const commitment = commitmentFromSecret(x);
  const transcript = concatBytes(domain, programId.toBytes(), capsule.toBytes(), commitment, context);
  const k = deriveNonce(x, aux, transcript);
  const r = Point.BASE.multiply(k).toBytes();
  const e = challenge(programId, domain, capsule, commitment, r, context);
  const s = mod(k + e * x);
  return { r: Array.from(r), s: Array.from(numberToBytesLE(s)) };
}

/**
 * Heartbeat proof for the capsule's current `heartbeat_nonce`, valid until `expiresAt` (cluster unix time; the
 * program accepts it only while `now ≤ expiresAt ≤ now + MAX_PROOF_LIFETIME`).
 */
export function proveLiveness(
  x: bigint,
  programId: PublicKey,
  capsule: PublicKey,
  nonce: bigint | number,
  expiresAt: bigint | number,
  aux?: Uint8Array,
): SchnorrProof {
  return prove(x, programId, LIVENESS_DOMAIN, capsule, livenessContext(nonce, expiresAt), aux);
}

/** `update_capsule` context: the liveness context (fixed 16 bytes) followed by the new configuration. */
export function updateContext(nonce: bigint | number, expiresAt: bigint | number, config: CapsuleConfigInput): Uint8Array {
  return concatBytes(livenessContext(nonce, expiresAt), encodeCapsuleConfig(config));
}

/**
 * Authorizes `update_capsule` (new heir, guardians, quorum, timers and share hashes) for the capsule's current
 * `heartbeat_nonce`, valid until `expiresAt` like a heartbeat. Binding the whole config means a relayer can neither
 * alter the new roster nor replay the proof once the nonce has moved on.
 */
export function proveUpdate(
  x: bigint,
  programId: PublicKey,
  capsule: PublicKey,
  nonce: bigint | number,
  expiresAt: bigint | number,
  config: CapsuleConfigInput,
  aux?: Uint8Array,
): SchnorrProof {
  return prove(x, programId, UPDATE_DOMAIN, capsule, updateContext(nonce, expiresAt, config), aux);
}

/** Proof-of-possession for `create_capsule`, bound to the full capsule configuration. */
export function proveRegistration(
  x: bigint,
  programId: PublicKey,
  capsule: PublicKey,
  config: CapsuleConfigInput,
  aux?: Uint8Array,
): SchnorrProof {
  return prove(x, programId, REGISTER_DOMAIN, capsule, encodeCapsuleConfig(config), aux);
}

/** Off-chain verifier mirroring the program (s·G − e·P == R); handy for UI pre-flight checks. */
export function verifyProof(
  programId: PublicKey,
  domain: Uint8Array,
  capsule: PublicKey,
  commitment: Uint8Array,
  proof: SchnorrProof,
  context: Uint8Array,
): boolean {
  const r = Uint8Array.from(proof.r);
  const s = bytesToNumberLE(Uint8Array.from(proof.s));
  if (s >= L) return false;
  let P: InstanceType<typeof Point>;
  try {
    P = Point.fromBytes(commitment);
    Point.fromBytes(r);
  } catch {
    return false;
  }
  const e = challenge(programId, domain, capsule, commitment, r, context);
  const lhs = Point.BASE.multiplyUnsafe(s).subtract(P.multiplyUnsafe(e)).toBytes();
  return lhs.length === r.length && lhs.every((b, i) => b === r[i]);
}

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
 * `context` is the capsule's `heartbeat_nonce` (u64 LE) for liveness proofs, or the Borsh
 * encoding of `CapsuleConfig` for the proof-of-possession sent with `create_capsule`.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";

const Point = ed25519.Point;

/** Order ℓ of the Ed25519 prime-order subgroup. */
export const L = ed25519.CURVE.n;

export const CAPSULE_SEED = utf8ToBytes("capsule");
export const REGISTER_DOMAIN = utf8ToBytes("SIKRIT:register:v1");
export const LIVENESS_DOMAIN = utf8ToBytes("SIKRIT:liveness:v1");
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

/** Matches the Anchor `CapsuleConfig` argument type (numbers are i64 seconds). */
export interface CapsuleConfigInput {
  heir: PublicKey;
  heartbeatInterval: bigint;
  gracePeriod: bigint;
  guardians: PublicKey[];
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

/** `heartbeat_nonce` as u64 little-endian — the liveness proof context. */
export function livenessContext(nonce: bigint | number): Uint8Array {
  return numberToBytesLE(BigInt(nonce), 8);
}

/** Borsh encoding of `CapsuleConfig` — the proof-of-possession context. */
export function encodeCapsuleConfig(config: CapsuleConfigInput): Uint8Array {
  const u32 = (n: number) => numberToBytesLE(BigInt(n), 4);
  const i64 = (n: bigint) => numberToBytesLE(BigInt.asUintN(64, n), 8);
  return concatBytes(
    config.heir.toBytes(),
    i64(config.heartbeatInterval),
    i64(config.gracePeriod),
    u32(config.guardians.length),
    ...config.guardians.map((g) => g.toBytes()),
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

/** Heartbeat proof for the capsule's current `heartbeat_nonce`. */
export function proveLiveness(
  x: bigint,
  programId: PublicKey,
  capsule: PublicKey,
  nonce: bigint | number,
  aux?: Uint8Array,
): SchnorrProof {
  return prove(x, programId, LIVENESS_DOMAIN, capsule, livenessContext(nonce), aux);
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

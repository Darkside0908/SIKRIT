/**
 * SIKRIT — HPKE (RFC 9180) base mode, single-shot.
 *
 * Ciphersuite: DHKEM(X25519, HKDF-SHA256) · HKDF-SHA256 · ChaCha20-Poly1305
 * (kem_id 0x0020, kdf_id 0x0001, aead_id 0x0003). This is the standardized form of
 * "ECIES with X25519": a fresh ephemeral key per message, KDF over (dh ‖ enc ‖ pkR), and an AEAD.
 * Verified byte-for-byte against the RFC 9180 Appendix A.2.1 test vector in tests/sdk.ts.
 *
 * Wire format of a sealed box: enc (32-byte ephemeral X25519 public key) ‖ AEAD ciphertext ‖ tag.
 * Built only from audited noble primitives; no WebCrypto, so it runs unchanged in Node and browsers.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;

/** Encapsulated key length (Nenc) = X25519 public key length. */
export const ENC_LENGTH = 32;
/** AEAD authentication tag length (Nt). */
export const TAG_LENGTH = 16;
/** Bytes a sealed box adds to its plaintext. */
export const SEAL_OVERHEAD = ENC_LENGTH + TAG_LENGTH;

const MODE_BASE = 0x00;
const N_SECRET = 32;
const N_SK = 32;
const N_K = 32;
const N_N = 12;
const N_H = 32;

const EMPTY = new Uint8Array(0);
const HPKE_V1 = utf8ToBytes("HPKE-v1");

const i2osp = (n: number, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--, n = Math.floor(n / 256)) out[i] = n & 0xff;
  return out;
};

const KEM_SUITE = concatBytes(utf8ToBytes("KEM"), i2osp(KEM_ID, 2));
const HPKE_SUITE = concatBytes(utf8ToBytes("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concatBytes(HPKE_V1, suite, utf8ToBytes(label), ikm), salt);
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return expand(sha256, prk, concatBytes(i2osp(length, 2), HPKE_V1, suite, utf8ToBytes(label), info), length);
}

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** DeriveKeyPair(ikm) for DHKEM(X25519): deterministic key pair from ≥ 32 bytes of key material. */
export function deriveKeyPair(ikm: Uint8Array): KeyPair {
  if (ikm.length < N_SK) throw new Error("HPKE: ikm must be at least 32 bytes");
  const dkpPrk = labeledExtract(KEM_SUITE, EMPTY, "dkp_prk", ikm);
  const secretKey = labeledExpand(KEM_SUITE, dkpPrk, "sk", EMPTY, N_SK);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function generateKeyPair(): KeyPair {
  return deriveKeyPair(randomBytes(N_SK));
}

/** X25519 with the all-zero (non-contributory) output rejected, as RFC 9180 §7.1.4 requires. */
function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== ENC_LENGTH) throw new Error("HPKE: invalid X25519 public key length");
  return x25519.getSharedSecret(secretKey, publicKey); // noble throws on an all-zero result
}

function extractAndExpand(dhOutput: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dhOutput);
  return labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, N_SECRET);
}

export interface Context {
  enc: Uint8Array;
  sharedSecret: Uint8Array;
  key: Uint8Array;
  baseNonce: Uint8Array;
  exporterSecret: Uint8Array;
}

function keySchedule(sharedSecret: Uint8Array, info: Uint8Array, enc: Uint8Array): Context {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info);
  const context = concatBytes(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY);
  return {
    enc,
    sharedSecret,
    key: labeledExpand(HPKE_SUITE, secret, "key", context, N_K),
    baseNonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, N_N),
    exporterSecret: labeledExpand(HPKE_SUITE, secret, "exp", context, N_H),
  };
}

/**
 * SetupBaseS(pkR, info). `ephemeral` pins the sender's ephemeral key pair and exists only for
 * known-answer tests; production callers must leave it undefined.
 */
export function setupBaseS(recipientPublicKey: Uint8Array, info: Uint8Array, ephemeral?: KeyPair): Context {
  const { secretKey, publicKey: enc } = ephemeral ?? generateKeyPair();
  const kemContext = concatBytes(enc, recipientPublicKey);
  return keySchedule(extractAndExpand(dh(secretKey, recipientPublicKey), kemContext), info, enc);
}

/** SetupBaseR(enc, skR). */
export function setupBaseR(enc: Uint8Array, recipientSecretKey: Uint8Array, info: Uint8Array): Context {
  const kemContext = concatBytes(enc, x25519.getPublicKey(recipientSecretKey));
  return keySchedule(extractAndExpand(dh(recipientSecretKey, enc), kemContext), info, enc);
}

/** Nonce for message number `seq` (base_nonce XOR I2OSP(seq, Nn)). Single-shot uses seq = 0. */
export function computeNonce(baseNonce: Uint8Array, seq: number): Uint8Array {
  const seqBytes = i2osp(seq, N_N);
  return baseNonce.map((b, i) => b ^ seqBytes[i]);
}

export function contextSeal(ctx: Context, aad: Uint8Array, plaintext: Uint8Array, seq = 0): Uint8Array {
  return chacha20poly1305(ctx.key, computeNonce(ctx.baseNonce, seq), aad).encrypt(plaintext);
}

export function contextOpen(ctx: Context, aad: Uint8Array, ciphertext: Uint8Array, seq = 0): Uint8Array {
  return chacha20poly1305(ctx.key, computeNonce(ctx.baseNonce, seq), aad).decrypt(ciphertext);
}

/** Secret export interface: LabeledExpand(exporter_secret, "sec", exporterContext, L). */
export function contextExport(ctx: Context, exporterContext: Uint8Array, length: number): Uint8Array {
  return labeledExpand(HPKE_SUITE, ctx.exporterSecret, "sec", exporterContext, length);
}

/** Single-shot Seal: returns enc ‖ ciphertext (plaintext.length + 48 bytes). */
export function seal(
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = EMPTY,
): Uint8Array {
  const ctx = setupBaseS(recipientPublicKey, info);
  return concatBytes(ctx.enc, contextSeal(ctx, aad, plaintext));
}

/** Single-shot Open of `enc ‖ ciphertext`; throws if the box was not sealed to this key/info/aad. */
export function open(
  recipientSecretKey: Uint8Array,
  info: Uint8Array,
  box: Uint8Array,
  aad: Uint8Array = EMPTY,
): Uint8Array {
  if (box.length < SEAL_OVERHEAD) throw new Error("HPKE: sealed box too short");
  const ctx = setupBaseR(box.subarray(0, ENC_LENGTH), recipientSecretKey, info);
  return contextOpen(ctx, aad, box.subarray(ENC_LENGTH));
}

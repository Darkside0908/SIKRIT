/**
 * SIKRIT — Shamir's Secret Sharing over GF(2^8).
 *
 * Wraps `shamir-secret-sharing` (Privy; independently audited by Cure53 and Zellic) instead of a
 * home-grown implementation. Format, pinned by the known-answer vector in tests/sdk.ts:
 *
 *   field  GF(2^8) with the AES reduction polynomial x⁸ + x⁴ + x³ + x + 1 (0x11b)
 *   split  one independent random polynomial f_j of degree k−1 per secret byte, f_j(0) = secret[j]
 *   share  f_0(x) ‖ f_1(x) ‖ … ‖ f_{m−1}(x) ‖ x      (secret length + 1 bytes, x ∈ [1, 255] distinct)
 *
 * Any k shares reconstruct the secret by Lagrange interpolation at 0; k − 1 shares are consistent
 * with every possible secret (perfect secrecy). `combine` cannot tell a wrong or missing share from
 * a right one, so SIKRIT never splits the secret itself: it splits a random data key and relies on
 * per-share hashes plus the payload AEAD tag to authenticate what comes back (see sdk/kit.ts).
 */
import { combine, split } from "shamir-secret-sharing";

/** Most shares one split can produce (x is a single non-zero byte). */
export const MAX_SHARES = 255;

/** Splits `secret` into `shares` shares, any `threshold` of which reconstruct it (2 ≤ k ≤ n ≤ 255). */
export function splitSecret(secret: Uint8Array, shares: number, threshold: number): Promise<Uint8Array[]> {
  return split(secret, shares, threshold);
}

/**
 * Lagrange interpolation at x = 0. Returns garbage — not an error — when given fewer than the
 * threshold or corrupted shares; callers must authenticate the result.
 */
export function combineShares(shares: Uint8Array[]): Promise<Uint8Array> {
  return combine(shares);
}

/** The share's x-coordinate (its last byte). */
export function shareX(share: Uint8Array): number {
  if (share.length < 2) throw new Error("Shamir: share too short");
  return share[share.length - 1];
}

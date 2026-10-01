/**
 * SIKRIT — lightweight program client (instructions, account decoding, discovery).
 *
 * Depends only on @solana/web3.js and noble, so the browser app does not ship the Anchor TS
 * client. Every byte is checked against the Anchor coder and the IDL in tests/sikrit.ts:
 * instruction data and account metas, the `Capsule` account layout, discriminators and errors.
 */
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { CapsuleConfigInput, SchnorrProof, capsulePda, encodeCapsuleConfig, numberToBytesLE } from "./liveness";

export const PROGRAM_ID = new PublicKey("FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F");

/** Mirrors the program constants (lib.rs). */
export const MAX_GUARDIANS = 5;
export const MAX_SHARES = 10;
export const MIN_HEARTBEAT_INTERVAL = 60;
export const MIN_GRACE_PERIOD = 60;

/** 8 + Capsule::INIT_SPACE: every capsule account has exactly this size. */
export const CAPSULE_ACCOUNT_SIZE = 8 + 32 + 32 + 32 + (4 + 32 * MAX_GUARDIANS) + 3 + 5 * 8 + (4 + 32 * MAX_SHARES) + 2;

const anchorDiscriminator = (preimage: string): Uint8Array => sha256(utf8ToBytes(preimage)).slice(0, 8);

export const DISCRIMINATORS = {
  createCapsule: anchorDiscriminator("global:create_capsule"),
  heartbeat: anchorDiscriminator("global:heartbeat"),
  triggerClaim: anchorDiscriminator("global:trigger_claim"),
  guardianConfirm: anchorDiscriminator("global:guardian_confirm"),
  guardianVeto: anchorDiscriminator("global:guardian_veto"),
  claim: anchorDiscriminator("global:claim"),
  capsuleAccount: anchorDiscriminator("account:Capsule"),
};

export type CapsuleStatus = "active" | "claimPending" | "claimed";
const STATUSES: CapsuleStatus[] = ["active", "claimPending", "claimed"];

export interface CapsuleAccount {
  commitment: Uint8Array;
  /** Salted commitment to the heir's wallet (`memberCommitment`): who inherits stays hidden until the claim. */
  heirCommitment: Uint8Array;
  /** The wallet that opened `heirCommitment` in `claim`; null before. */
  heir: PublicKey | null;
  /** One salted commitment per guardian slot; a guardian is revealed only by its own confirm or veto. */
  guardianCommitments: Uint8Array[];
  guardianThreshold: number;
  /** Bit i set ⇔ the guardian in slot i approved the pending claim. */
  approvals: number;
  /** Bit i set ⇔ the guardian in slot i used its veto since the owner's last heartbeat. */
  vetoes: number;
  heartbeatInterval: bigint;
  gracePeriod: bigint;
  lastHeartbeat: bigint;
  claimTriggeredAt: bigint;
  heartbeatNonce: bigint;
  shareHashes: Uint8Array[];
  status: CapsuleStatus;
  bump: number;
}

/** Program error codes (6000 + index) with user-facing explanations. */
export const PROGRAM_ERRORS: { name: string; message: string }[] = [
  { name: "HeartbeatIntervalTooShort", message: "The heartbeat interval is shorter than the 60-second minimum." },
  { name: "GracePeriodTooShort", message: "The grace period is shorter than the 60-second minimum." },
  { name: "TooManyGuardians", message: "A capsule can have at most 5 guardians." },
  { name: "InvalidGuardianThreshold", message: "The guardian threshold is larger than the number of guardians." },
  { name: "TooManyShares", message: "A capsule can commit to at most 10 shares." },
  { name: "CapsuleNotActive", message: "The capsule is not active." },
  { name: "InvalidCommitment", message: "The liveness commitment is not a valid prime-order point." },
  { name: "InvalidProofR", message: "The proof's R value is not a valid curve point." },
  { name: "InvalidProofS", message: "The proof's s value is not a canonical scalar." },
  { name: "ProofVerificationFailed", message: "The zero-knowledge proof did not verify (wrong key, stale nonce, replay or altered expiry)." },
  { name: "HeartbeatNotExpired", message: "The owner's last heartbeat is still fresh — the capsule cannot be triggered yet." },
  { name: "ClaimNotPending", message: "No claim is pending on this capsule." },
  { name: "UnauthorizedGuardian", message: "This wallet and kit do not open a guardian commitment of this capsule." },
  { name: "GracePeriodNotExpired", message: "The grace period has not ended yet." },
  { name: "InsufficientGuardianApprovals", message: "Not enough guardians have confirmed the claim yet." },
  { name: "UnauthorizedHeir", message: "This wallet and kit do not open the heir commitment of this capsule." },
  { name: "InvalidHeir", message: "The heir commitment is invalid." },
  { name: "InvalidGuardian", message: "A guardian commitment is invalid." },
  { name: "DuplicateGuardian", message: "The same guardian commitment is listed twice." },
  { name: "HeirCannotBeGuardian", message: "The heir commitment cannot also be a guardian commitment." },
  { name: "GuardianAlreadyApproved", message: "This guardian already confirmed the claim." },
  { name: "GuardianAlreadyVetoed", message: "This guardian already used its veto until the owner's next heartbeat." },
  { name: "VetoWindowClosed", message: "The grace period is over, so the claim can no longer be vetoed." },
  { name: "CapsuleAlreadyClaimed", message: "The capsule has already been claimed." },
  { name: "NonceOverflow", message: "The heartbeat counter overflowed." },
  { name: "ProofExpired", message: "The heartbeat proof expired before it reached the chain; send a fresh one." },
  { name: "ProofExpiryTooFar", message: "The heartbeat proof's expiry is more than an hour ahead of the cluster clock." },
];

/** Maps a program error code (e.g. from a failed simulation) to its entry, if it is ours. */
export function programError(code: number): { code: number; name: string; message: string } | undefined {
  const entry = PROGRAM_ERRORS[code - 6000];
  return entry && { code, ...entry };
}

/** Finds `custom program error: 0x…` in a transaction error / logs and explains it. */
export function explainError(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${(error as { logs?: string[] }).logs?.join(" ") ?? ""}` : String(error);
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  const anchorCode = /Error Number: (\d+)/.exec(text);
  const code = hex ? parseInt(hex[1], 16) : anchorCode ? Number(anchorCode[1]) : undefined;
  const known = code !== undefined ? programError(code) : undefined;
  return known ? `${known.message} (${known.name})` : error instanceof Error ? error.message : text;
}

// -----------------------------------------------------------------------------
// Instructions (account order = the program's `#[derive(Accounts)]` structs)
// -----------------------------------------------------------------------------

const proofBytes = (proof: SchnorrProof): Uint8Array => concatBytes(Uint8Array.from(proof.r), Uint8Array.from(proof.s));

const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

export function createCapsuleIx(args: {
  payer: PublicKey;
  commitment: Uint8Array;
  config: CapsuleConfigInput;
  proof: SchnorrProof;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  const [capsule] = capsulePda(programId, args.commitment);
  return new TransactionInstruction({
    programId,
    keys: [
      writable(capsule),
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(DISCRIMINATORS.createCapsule, args.commitment, encodeCapsuleConfig(args.config), proofBytes(args.proof)),
    ),
  });
}

const i64 = (n: bigint): Uint8Array => numberToBytesLE(BigInt.asUintN(64, n), 8);

/** Signer-less: the proof is the only authorization, so any fee payer can relay it (until `expiresAt`). */
export function heartbeatIx(args: {
  capsule: PublicKey;
  proof: SchnorrProof;
  expiresAt: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: [writable(args.capsule)],
    data: Buffer.from(concatBytes(DISCRIMINATORS.heartbeat, proofBytes(args.proof), i64(args.expiresAt))),
  });
}

/** Permissionless: any keeper can open the claim once the interval has elapsed. */
export function triggerClaimIx(args: { capsule: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: [writable(args.capsule)],
    data: Buffer.from(DISCRIMINATORS.triggerClaim),
  });
}

function signedIx(data: Uint8Array, capsule: PublicKey, signer: PublicKey, programId?: PublicKey) {
  return new TransactionInstruction({
    programId: programId ?? PROGRAM_ID,
    keys: [writable(capsule), { pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(data),
  });
}

/** A member's opening of its commitment: the guardian slot (heir: none) and the salt from the kit. */
export interface GuardianOpening {
  capsule: PublicKey;
  guardian: PublicKey;
  slot: number;
  salt: Uint8Array;
  programId?: PublicKey;
}

function guardianData(discriminator: Uint8Array, { slot, salt }: GuardianOpening): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_GUARDIANS) throw new Error("client: guardian slot out of range");
  if (salt.length !== 32) throw new Error("client: salt must be 32 bytes");
  return concatBytes(discriminator, Uint8Array.of(slot), salt);
}

/** Reveals the guardian (signer + salt) on-chain: only call it when acting on a claim. */
export const guardianConfirmIx = (args: GuardianOpening) =>
  signedIx(guardianData(DISCRIMINATORS.guardianConfirm, args), args.capsule, args.guardian, args.programId);

export const guardianVetoIx = (args: GuardianOpening) =>
  signedIx(guardianData(DISCRIMINATORS.guardianVeto, args), args.capsule, args.guardian, args.programId);

export function claimIx(args: { capsule: PublicKey; heir: PublicKey; salt: Uint8Array; programId?: PublicKey }) {
  if (args.salt.length !== 32) throw new Error("client: salt must be 32 bytes");
  return signedIx(concatBytes(DISCRIMINATORS.claim, args.salt), args.capsule, args.heir, args.programId);
}

// -----------------------------------------------------------------------------
// Account decoding
// -----------------------------------------------------------------------------

class Reader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  bytes(length: number): Uint8Array {
    if (this.offset + length > this.data.length) throw new Error("client: capsule account data too short");
    const out = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0];
  }

  u32(): number {
    const b = this.bytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16)) + b[3] * 2 ** 24;
  }

  u64(): bigint {
    return this.bytes(8).reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  }

  i64(): bigint {
    return BigInt.asIntN(64, this.u64());
  }

  vec<T>(max: number, item: () => T): T[] {
    const length = this.u32();
    if (length > max) throw new Error("client: capsule account vector too long");
    return Array.from({ length }, item);
  }
}

export function decodeCapsule(data: Uint8Array): CapsuleAccount {
  const reader = new Reader(data);
  const discriminator = reader.bytes(8);
  if (!discriminator.every((byte, i) => byte === DISCRIMINATORS.capsuleAccount[i])) {
    throw new Error("client: not a SIKRIT capsule account");
  }
  // Capsules created before protocol v2 (devnet, 1 Oct 2026) share the discriminator but not the layout.
  if (data.length !== CAPSULE_ACCOUNT_SIZE) throw new Error("client: capsule from an older protocol version");
  const commitment = reader.bytes(32);
  const heirCommitment = reader.bytes(32);
  const revealed = new PublicKey(reader.bytes(32));
  const heir = revealed.equals(PublicKey.default) ? null : revealed;
  const guardianCommitments = reader.vec(MAX_GUARDIANS, () => reader.bytes(32));
  const guardianThreshold = reader.u8();
  const approvals = reader.u8();
  const vetoes = reader.u8();
  const heartbeatInterval = reader.i64();
  const gracePeriod = reader.i64();
  const lastHeartbeat = reader.i64();
  const claimTriggeredAt = reader.i64();
  const heartbeatNonce = reader.u64();
  const shareHashes = reader.vec(MAX_SHARES, () => reader.bytes(32));
  const status = STATUSES[reader.u8()];
  if (!status) throw new Error("client: unknown capsule status");
  const bump = reader.u8();
  return {
    commitment, heirCommitment, heir, guardianCommitments, guardianThreshold, approvals, vetoes, heartbeatInterval,
    gracePeriod, lastHeartbeat, claimTriggeredAt, heartbeatNonce, shareHashes, status, bump,
  };
}

// -----------------------------------------------------------------------------
// Chain access
// -----------------------------------------------------------------------------

export async function fetchCapsule(connection: Connection, address: PublicKey): Promise<CapsuleAccount | null> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) throw new Error("client: account is not owned by the SIKRIT program");
  return decodeCapsule(info.data);
}

/**
 * Current state of the capsules at `addresses` (null where none exists), in one `getMultipleAccounts` per 100.
 * Heirs and guardians know their capsules from their kits: the chain holds only commitments to them, so there is
 * nothing to search for by wallet (see R3 in the security review).
 */
export async function fetchCapsules(
  connection: Connection,
  addresses: PublicKey[],
): Promise<{ address: PublicKey; capsule: CapsuleAccount | null }[]> {
  const found: { address: PublicKey; capsule: CapsuleAccount | null }[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100); // getMultipleAccounts takes at most 100 keys
    const infos = await connection.getMultipleAccountsInfo(batch, "confirmed");
    infos.forEach((info, j) => {
      if (info && !info.owner.equals(PROGRAM_ID)) throw new Error("client: account is not owned by the SIKRIT program");
      found.push({ address: batch[j], capsule: info ? decodeCapsule(info.data) : null });
    });
  }
  return found;
}

// -----------------------------------------------------------------------------
// Timeline helpers (pure; `now` is the cluster's unix time in seconds)
// -----------------------------------------------------------------------------

export interface CapsuleTimeline {
  /** When `trigger_claim` becomes possible (last heartbeat + interval). */
  expiresAt: bigint;
  /** When the heir may `claim` (trigger + grace), if a claim is pending. */
  claimableAt?: bigint;
  canTrigger: boolean;
  canVeto: boolean;
  canClaim: boolean;
  approvalCount: number;
}

export function timeline(capsule: CapsuleAccount, now: bigint): CapsuleTimeline {
  const expiresAt = capsule.lastHeartbeat + capsule.heartbeatInterval;
  const approvalCount = popcount(capsule.approvals);
  if (capsule.status !== "claimPending") {
    return { expiresAt, canTrigger: capsule.status === "active" && now >= expiresAt, canVeto: false, canClaim: false, approvalCount };
  }
  const claimableAt = capsule.claimTriggeredAt + capsule.gracePeriod;
  return {
    expiresAt,
    claimableAt,
    canTrigger: false,
    canVeto: now < claimableAt,
    canClaim: now >= claimableAt && approvalCount >= capsule.guardianThreshold,
    approvalCount,
  };
}

function popcount(bits: number): number {
  let count = 0;
  for (let b = bits; b; b &= b - 1) count++;
  return count;
}

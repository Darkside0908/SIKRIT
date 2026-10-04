/**
 * SIKRIT — a watcher that warns about a capsule without telling anyone which capsule it watches.
 *
 * Asking an RPC about one capsule every few minutes ties the asker's IP to that capsule, the link SIKRIT exists to
 * hide. `scanCapsules` downloads every capsule instead (one `getProgramAccounts` whose filters match all capsules
 * alike) and the caller picks its own on its own machine. The account's status and timers sit after variable-length
 * vectors, so the scan takes whole accounts (637 bytes each) rather than a slice.
 *
 * `checkCapsule` turns one capsule's state into alerts. Each alert has a key that stays the same for one liveness
 * epoch or one claim, so a polling loop can alert once per event. Alert text never contains the capsule's address or
 * key, so it can go to a third-party push service.
 */
import { Connection, PublicKey } from "@solana/web3.js";

import { CAPSULE_ACCOUNT_SIZE, CapsuleAccount, DISCRIMINATORS, PROGRAM_ID, decodeCapsule, timeline } from "./client";

export const DAY = 86_400n;

/** Every current capsule of the program, by address (base58). Older-format or foreign accounts are left out. */
export async function scanCapsules(connection: Connection, programId: PublicKey = PROGRAM_ID): Promise<Map<string, CapsuleAccount>> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [
      { dataSize: CAPSULE_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: Buffer.from(DISCRIMINATORS.capsuleAccount).toString("base64"), encoding: "base64" } },
    ],
  });
  const capsules = new Map<string, CapsuleAccount>();
  for (const { pubkey, account } of accounts) {
    try {
      capsules.set(pubkey.toBase58(), decodeCapsule(account.data));
    } catch {
      // Not a capsule this client can read: ignore it rather than stop watching the others.
    }
  }
  return capsules;
}

export type AlertKind = "missing" | "heartbeat-due" | "heartbeat-overdue" | "claim-open" | "claimable" | "claimed";

export interface Alert {
  kind: AlertKind;
  /** The same for one liveness epoch or one claim: alert once per key. */
  key: string;
  /** Someone can now start (or finish) taking the capsule: the owner should send a heartbeat. */
  urgent: boolean;
  /** Plain text without the capsule's address, safe to hand to a push service. */
  text: string;
}

export interface WatchOptions {
  /** Remind this many seconds before the next heartbeat is due (default: one day). */
  remindBefore?: bigint;
}

/** What the holder of a capsule should know right now. `capsule` is undefined or null when the scan did not find it. */
export function checkCapsule(capsule: CapsuleAccount | null | undefined, now: bigint, options: WatchOptions = {}): Alert[] {
  if (!capsule) {
    return [{ kind: "missing", key: "missing", urgent: false, text: "Capsule not found on this cluster: check the address and the RPC." }];
  }
  if (capsule.status === "claimed") {
    return [{ kind: "claimed", key: "claimed", urgent: false, text: "The heir has claimed the capsule. Nothing can cancel it any more." }];
  }

  const t = timeline(capsule, now);
  if (capsule.status === "claimPending") {
    const claimableAt = t.claimableAt!;
    const quorum = `${t.approvalCount} of ${capsule.guardianThreshold} guardian approvals so far`;
    const grace = now < claimableAt
      ? `the grace period ends ${at(claimableAt)} (in ${duration(claimableAt - now)})`
      : `the grace period ended ${at(claimableAt)}`;
    const alerts: Alert[] = [{
      kind: "claim-open",
      key: `claim:${capsule.claimTriggeredAt}`,
      urgent: true,
      text: `A claim is open: ${grace}; ${quorum}. If the owner is alive, one heartbeat cancels it.`,
    }];
    if (t.canClaim) {
      alerts.push({
        kind: "claimable",
        key: `claimable:${capsule.claimTriggeredAt}`,
        urgent: true,
        text: "The heir can claim now. Until they do, a heartbeat from the owner still cancels the claim.",
      });
    }
    return alerts;
  }

  if (now >= t.expiresAt) {
    return [{
      kind: "heartbeat-overdue",
      key: `overdue:${capsule.lastHeartbeat}`,
      urgent: true,
      text: `Heartbeat overdue since ${at(t.expiresAt)}: anyone may open a claim now. Send a heartbeat.`,
    }];
  }
  if (now >= t.expiresAt - (options.remindBefore ?? DAY)) {
    return [{
      kind: "heartbeat-due",
      key: `due:${capsule.lastHeartbeat}`,
      urgent: false,
      text: `Heartbeat due by ${at(t.expiresAt)} (in ${duration(t.expiresAt - now)}).`,
    }];
  }
  return [];
}

/** "2026-10-04 12:00 UTC" */
function at(unix: bigint): string {
  return `${new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "6 d 23 h", "5 h 3 min", "42 s" */
export function duration(seconds: bigint): string {
  const s = Number(seconds < 0n ? 0n : seconds);
  const [d, h, m] = [Math.floor(s / 86_400), Math.floor((s % 86_400) / 3600), Math.floor((s % 3600) / 60)];
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return m ? `${m} min` : `${s} s`;
}

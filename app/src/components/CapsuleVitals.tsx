import { CapsuleAccount, timeline } from "@sdk/client";
import type { PublicKey } from "@solana/web3.js";
import type { ReactNode } from "react";

import { who } from "../lib/capsule";
import { duration, short } from "../lib/format";
import { useChainNow } from "../lib/hooks";
import { href } from "../lib/router";
import { StatusChip } from "./ui";
import { Countdown, Ecg, Vital } from "./visuals";

/** Status, countdown and ECG of a capsule as any outside observer sees it. */
export function CapsuleVitals({ address, capsule, children }: { address: PublicKey; capsule: CapsuleAccount; children?: ReactNode }) {
  const now = useChainNow();
  const t = now !== undefined ? timeline(capsule, now) : undefined;
  const vital: Vital =
    capsule.status === "claimed" ? "flat" : capsule.status === "claimPending" || t?.canTrigger ? "pending" : "alive";

  let caption: string;
  let seconds = 0n;
  let tone: "life" | "amber" | "seal" | "bone" = "bone";
  if (capsule.status === "active") {
    seconds = t ? t.expiresAt - now! : 0n;
    caption = t?.canTrigger ? "Silent past its interval — a claim can be opened" : "Owner proved liveness; next proof due in";
    tone = t?.canTrigger ? "seal" : "life";
  } else if (capsule.status === "claimPending") {
    seconds = t ? t.claimableAt! - now! : 0n;
    caption = t && seconds <= 0n ? "Grace period over" : "Claim open — grace period ends in";
    tone = "amber";
  } else {
    caption = capsule.heir ? `Released to ${who(capsule.heir)}` : "Released to the heir";
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-6 p-6">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status={capsule.status} />
            <a href={href({ page: "capsule", address: address.toBase58() })} className="mono text-bone-500 hover:text-bone-200">
              capsule {short(address, 6, 6)}
            </a>
          </div>
          <div className="eyebrow">{caption}</div>
          {capsule.status !== "claimed" ? (
            <Countdown seconds={seconds > 0n ? seconds : 0n} tone={tone} />
          ) : (
            <p className="font-display text-3xl text-seal-300">Sealed no more.</p>
          )}
          <div className="text-xs text-bone-500">
            interval {duration(capsule.heartbeatInterval)} · grace {duration(capsule.gracePeriod)} · guardians{" "}
            {t?.approvalCount ?? 0}/{capsule.guardianThreshold} confirmed · {capsule.heartbeatNonce.toString()} heartbeat
            {capsule.heartbeatNonce === 1n ? "" : "s"}
          </div>
        </div>
        {children && <div className="flex flex-col items-stretch gap-2 sm:items-end">{children}</div>}
      </div>
      <Ecg vital={vital} />
    </div>
  );
}

import { timeline, triggerClaimIx } from "@sdk/client";
import { PublicKey } from "@solana/web3.js";
import { useMemo, useState } from "react";

import { CapsuleVitals } from "../components/CapsuleVitals";
import { ActionButton, AddressLink, Heading, Notice, TxLink } from "../components/ui";
import { who } from "../lib/capsule";
import { sendRelayed } from "../lib/relayer";
import { hex, short, when } from "../lib/format";
import { useAction, useCapsule, useChainNow } from "../lib/hooks";

/** Everything anyone on earth can learn about a capsule — and what they cannot. */
export function CapsulePage({ address }: { address: string }) {
  const key = useMemo(() => {
    try {
      return new PublicKey(address);
    } catch {
      return undefined;
    }
  }, [address]);
  const { capsule, error, refresh } = useCapsule(key);
  const now = useChainNow();
  const action = useAction();
  const [lastTx, setLastTx] = useState<string>();

  if (!key) return <Notice tone="error">Not a valid address.</Notice>;

  const t = capsule && now !== undefined ? timeline(capsule, now) : undefined;

  return (
    <div className="space-y-8">
      <Heading eyebrow="Public view" title={<>Capsule <span className="mono text-3xl text-bone-300">{short(key, 6, 6)}</span></>}>
        This page shows exactly what any observer — a keeper bot, a curious stranger, the heir — can read from the chain.
      </Heading>
      {error && <Notice tone="error">{error}</Notice>}
      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}
      {capsule === null && <Notice tone="warn">No capsule exists at this address on this cluster.</Notice>}
      {capsule && (
        <>
          <CapsuleVitals address={key} capsule={capsule}>
            {capsule.status === "active" && (
              <ActionButton
                busy={action.busy}
                busyLabel="Opening claim"
                label="Open the claim (keeper)"
                disabled={!t?.canTrigger}
                onClick={() =>
                  action.run("Opening claim", async () => {
                    const { signature } = await sendRelayed([triggerClaimIx({ capsule: key })]);
                    setLastTx(signature);
                    refresh();
                  })
                }
              />
            )}
            {lastTx && <TxLink signature={lastTx} />}
          </CapsuleVitals>

          <div className="grid gap-6 md:grid-cols-[1.4fr_1fr]">
            <section className="card space-y-4 p-6">
              <div className="eyebrow">Public record</div>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-bone-500">Liveness key P</dt>
                <dd className="mono break-all text-bone-300">{hex(capsule.commitment)}</dd>
                <dt className="text-bone-500">Heir</dt>
                <dd><AddressLink address={capsule.heir.toBase58()} label={who(capsule.heir)} /></dd>
                <dt className="text-bone-500">Guardians</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-1">
                  {capsule.guardians.map((g) => <AddressLink key={g.toBase58()} address={g.toBase58()} label={who(g)} />)}
                </dd>
                <dt className="text-bone-500">Last proof of life</dt>
                <dd className="text-bone-300">{when(capsule.lastHeartbeat)}</dd>
                <dt className="text-bone-500">Proofs so far</dt>
                <dd className="text-bone-300">{capsule.heartbeatNonce.toString()}</dd>
                <dt className="text-bone-500">Share commitments</dt>
                <dd className="mono space-y-1 text-bone-400">
                  {capsule.shareHashes.map((h) => <div key={hex(h)} className="truncate">{hex(h)}</div>)}
                </dd>
              </dl>
              <p className="text-xs leading-relaxed text-bone-500">
                Heir and guardian addresses and the time of the last heartbeat are public by design (see R1/R3 in the
                security review). What they cannot reveal is who the owner is.
              </p>
            </section>
            <section className="card ledger space-y-4 p-6">
              <div className="eyebrow">Not on-chain, anywhere</div>
              <ul className="space-y-3 text-sm text-bone-300">
                <li className="flex items-center justify-between gap-3">The owner's wallet <span className="redact w-24" /></li>
                <li className="flex items-center justify-between gap-3">The owner's liveness secret <span className="redact w-20" /></li>
                <li className="flex items-center justify-between gap-3">The sealed secret <span className="redact w-28" /></li>
                <li className="flex items-center justify-between gap-3">Any share, even encrypted <span className="redact w-16" /></li>
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

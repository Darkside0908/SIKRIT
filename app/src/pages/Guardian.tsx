import { CapsuleAccount, findCapsulesByGuardian, guardianConfirmIx, guardianVetoIx, timeline, triggerClaimIx } from "@sdk/client";
import * as kit from "@sdk/kit";
import { bytesToHex } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";
import { useState } from "react";

import { CapsuleVitals } from "../components/CapsuleVitals";
import { InboxCard } from "../components/InboxCard";
import { KitImport } from "../components/KitImport";
import { ActingAs } from "../components/Shell";
import { ActionButton, Copyable, Heading, Notice, TxLink } from "../components/ui";
import type { Actor } from "../lib/actors";
import { chainState, useInbox, useVerifiedKit, who } from "../lib/capsule";
import { connection } from "../lib/chain";
import { sendRelayed } from "../lib/relayer";
import { useAction, useCapsule, useChainNow, usePolling } from "../lib/hooks";
import { useActor } from "../lib/identity";
import { encodeRelease, postRelease, useMailbox } from "../lib/mailbox";

type Inbox = ReturnType<typeof useInbox>["inbox"];

export function GuardianPage() {
  const { actor, persona } = useActor("guardian");
  const { inbox, create } = useInbox(actor);
  const action = useAction();
  const key = actor?.publicKey.toBase58();
  const list = usePolling(actor ? () => findCapsulesByGuardian(connection, actor.publicKey) : undefined, [key]);

  return (
    <div className="space-y-10">
      <div className="space-y-6 animate-rise">
        <Heading eyebrow={`Guardian${persona ? ` · ${persona.name}` : ""}`} title="Keep watch, release on silence">
          Guardians stop two failures: an heir who cannot wait, and a false alarm while the owner still lives. Confirm a
          claim only when you know; veto it if you know otherwise; release your share only after the chain says
          <em> claimed</em>.
        </Heading>
        <ActingAs role="guardian" />
      </div>

      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <InboxCard actor={actor} inbox={inbox} busy={action.busy} audience="the owner" onCreate={() => action.run("Creating", create)} />
        <div className="space-y-6">
          {list.error && <Notice tone="error">{list.error}</Notice>}
          {list.value === undefined && actor && <div className="card p-6 text-bone-400">Searching the chain for capsules you guard…</div>}
          {list.value?.length === 0 && (
            <div className="card ledger p-8 text-bone-300">
              <p className="font-display text-2xl text-bone-100">You are not guarding any capsule yet.</p>
              <p className="mt-2 text-sm text-bone-400">When an owner lists your wallet as a guardian, the capsule appears here.</p>
            </div>
          )}
          {/* Keyed by guardian too: several guardians share a capsule, and none may inherit another's UI state. */}
          {list.value?.map(({ address, capsule }) => (
            <GuardianCapsule key={`${key}:${address.toBase58()}`} address={address} initial={capsule} actor={actor!} inbox={inbox} onChange={list.refresh} />
          ))}
        </div>
      </div>
    </div>
  );
}

function GuardianCapsule({
  address,
  initial,
  actor,
  inbox,
  onChange,
}: {
  address: PublicKey;
  initial: CapsuleAccount;
  actor: Actor;
  inbox: Inbox;
  onChange: () => void;
}) {
  const live = useCapsule(address);
  const capsule = live.capsule ?? initial;
  const now = useChainNow();
  const t = now !== undefined ? timeline(capsule, now) : undefined;
  const action = useAction();
  const [lastTx, setLastTx] = useState<string>();
  const slot = capsule.guardians.findIndex((g) => g.equals(actor.publicKey));
  const approved = slot >= 0 && Boolean(capsule.approvals & (1 << slot));
  const vetoed = slot >= 0 && Boolean(capsule.vetoes & (1 << slot));

  const send = (label: string, instructions: Parameters<typeof sendRelayed>[0], cosign?: Actor) =>
    action.run(label, async () => {
      const { signature } = await sendRelayed(instructions, cosign);
      setLastTx(signature);
      live.refresh();
      onChange();
    });

  return (
    <article className="space-y-4 animate-rise">
      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}
      <CapsuleVitals address={address} capsule={capsule}>
        <span className="text-right text-xs text-bone-500">heir: {who(capsule.heir)} · you are guardian #{slot + 1}</span>
        {capsule.status === "active" && t?.canTrigger && (
          <ActionButton
            busy={action.busy}
            busyLabel="Opening claim"
            label="Open the claim"
            onClick={() => send("Opening claim", [triggerClaimIx({ capsule: address })])}
          />
        )}
        {capsule.status === "claimPending" && (
          <div className="flex flex-wrap justify-end gap-2">
            <ActionButton
              className="btn-ghost"
              busy={action.busy}
              busyLabel="Vetoing"
              label={vetoed ? "Veto used" : "Veto — the owner is alive"}
              disabled={vetoed || !t?.canVeto}
              onClick={() => {
                if (confirm("Veto only if you know the owner is alive. It resets their timer and uses your one veto until their next heartbeat.")) {
                  void send("Vetoing", [guardianVetoIx({ capsule: address, guardian: actor.publicKey })], actor);
                }
              }}
            />
            <ActionButton
              busy={action.busy}
              busyLabel="Confirming"
              label={approved ? "Confirmed" : "Confirm the claim"}
              disabled={approved}
              onClick={() => send("Confirming", [guardianConfirmIx({ capsule: address, guardian: actor.publicKey })], actor)}
            />
          </div>
        )}
        {lastTx && <TxLink signature={lastTx} />}
      </CapsuleVitals>
      <Release address={address} capsule={capsule} inbox={inbox} guardian={actor.publicKey} />
    </article>
  );
}

function Release({ address, capsule, inbox, guardian }: { address: PublicKey; capsule: CapsuleAccount; inbox: Inbox; guardian: PublicKey }) {
  const mailbox = useMailbox();
  const action = useAction();
  const { kitText, checked, importKit } = useVerifiedKit(address, capsule);
  const token = mailbox.sent[`${address.toBase58()}:${guardian.toBase58()}`];

  const release = () =>
    action.run("Releasing", async () => {
      if (!checked.kit) throw new Error("No verified kit for this capsule");
      if (!inbox) throw new Error("Create your inbox key first");
      const index = kit.findShareIndex(checked.kit, inbox.keyPair.publicKey);
      if (index < 0) throw new Error("This kit holds no share for your inbox key");
      const share = kit.openShare(checked.kit, index, inbox.keyPair.secretKey);
      // Refuses unless the chain says Claimed, and seals only to the inbox the on-chain heir certified.
      const sealed = kit.releaseShare(checked.kit, share, chainState(capsule));
      postRelease(address.toBase58(), guardian.toBase58(), encodeRelease(address.toBase58(), bytesToHex(sealed)));
    });

  return (
    <section className="card space-y-4 p-6">
      <div className="eyebrow">Your share</div>
      {(!kitText || checked.error) && <KitImport onImport={importKit} rejected={Boolean(checked.error)} />}
      {!kitText ? (
        <p className="text-sm text-bone-400">The owner sends the kit file to every holder when sealing.</p>
      ) : checked.error ? (
        <Notice tone="error">Kit rejected: {checked.error}</Notice>
      ) : capsule.status !== "claimed" ? (
        <p className="text-sm leading-relaxed text-bone-300">
          Kit verified against the chain. Your share stays sealed until the capsule is <em>claimed</em>; this app refuses to
          release it earlier.
        </p>
      ) : token ? (
        <>
          <Notice tone="success">Released to {who(capsule.heir)}'s inbox (demo mailbox). Only their inbox key can open it.</Notice>
          <Copyable text={token} display={`${token.slice(0, 40)}…`} />
        </>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-bone-300">
            The capsule is claimed. Re-seal your share to the inbox key certified by {who(capsule.heir)}'s wallet — the heir
            registered on-chain.
          </p>
          <ActionButton className="btn-seal" busy={action.busy} busyLabel="Releasing" label="Release my share to the heir" onClick={release} />
        </>
      )}
      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}
    </section>
  );
}

import { CapsuleAccount, claimIx, timeline, triggerClaimIx } from "@sdk/client";
import * as kit from "@sdk/kit";
import { hexToBytes } from "@noble/hashes/utils";
import { PublicKey } from "@solana/web3.js";
import { useMemo, useState } from "react";

import { CapsuleVitals } from "../components/CapsuleVitals";
import { InboxCard } from "../components/InboxCard";
import { KitImport } from "../components/KitImport";
import { ActingAs } from "../components/Shell";
import { ActionButton, Heading, Notice, TxLink } from "../components/ui";
import { Seal } from "../components/visuals";
import type { Actor } from "../lib/actors";
import { importMemberKit, useInbox, useMemberCapsules, useVerifiedKit } from "../lib/capsule";
import { sendRelayed } from "../lib/relayer";
import { useAction, useCapsule, useChainNow } from "../lib/hooks";
import { useActor } from "../lib/identity";
import { decodeRelease, useMailbox } from "../lib/mailbox";

type Inbox = ReturnType<typeof useInbox>["inbox"];

export function HeirPage() {
  const { actor, persona } = useActor("heir");
  const { inbox, create } = useInbox(actor);
  const action = useAction();
  const key = actor?.publicKey.toBase58();
  const capsules = useMemberCapsules(actor, "heir");

  return (
    <div className="space-y-10">
      <div className="space-y-6 animate-rise">
        <Heading eyebrow={`Heir${persona ? ` · ${persona.name}` : ""}`} title="What was left for you">
          You hold one share of each capsule sealed for you — by design, not enough to open it. Only when the owner
          falls silent, the claim runs its course and the guardians release their shares does the secret come back
          together, in your browser.
        </Heading>
        <ActingAs role="heir" />
      </div>

      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <InboxCard actor={actor} inbox={inbox} busy={action.busy} audience="the owner" onCreate={() => action.run("Creating", create)} />
        <div className="space-y-6">
          {capsules?.length === 0 && (
            <div className="card ledger space-y-4 p-8 text-bone-300">
              <p className="font-display text-2xl text-bone-100">Nothing sealed for you yet.</p>
              <p className="text-sm text-bone-400">
                The chain holds only a salted commitment to you, so nobody can find what was left for you by searching
                for your wallet, not even you. Your capsules arrive with the kit their owner sends you.
              </p>
            </div>
          )}
          {actor &&
            capsules?.map(({ address }) => (
              <HeirCapsule key={`${key}:${address.toBase58()}`} address={address} actor={actor} inbox={inbox} />
            ))}
          {actor && (
            <KitImport
              message="Received a kit file from an owner? Import it to follow that capsule."
              onImport={(text) => void action.run("Importing", () => importMemberKit(text, actor.publicKey))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HeirCapsule({ address, actor, inbox }: { address: PublicKey; actor: Actor; inbox: Inbox }) {
  const { capsule, error, refresh } = useCapsule(address);
  if (capsule === undefined && error) return <Notice tone="error">Capsule {address.toBase58()}: {error}</Notice>;
  if (capsule === undefined) return <div className="card p-6 text-bone-400">Loading capsule…</div>;
  if (capsule === null) return <Notice tone="warn">The capsule of this kit does not exist on this cluster.</Notice>;
  return <HeirCapsuleView address={address} capsule={capsule} actor={actor} inbox={inbox} onChange={refresh} />;
}

function HeirCapsuleView({
  address,
  capsule,
  actor,
  inbox,
  onChange,
}: {
  address: PublicKey;
  capsule: CapsuleAccount;
  actor: Actor;
  inbox: Inbox;
  onChange: () => void;
}) {
  const now = useChainNow();
  const t = now !== undefined ? timeline(capsule, now) : undefined;
  const action = useAction();
  const [lastTx, setLastTx] = useState<string>();
  const verified = useVerifiedKit(address, capsule);
  const member = verified.checked.kit && kit.membership(verified.checked.kit, actor.publicKey.toBytes());
  const salt = member?.role === "heir" ? member.salt : undefined;

  const send = (label: string, build: () => Parameters<typeof sendRelayed>[0], cosign?: Actor) =>
    action.run(label, async () => {
      const { signature } = await sendRelayed(build(), cosign);
      setLastTx(signature);
      onChange();
    });

  return (
    <article className="space-y-4 animate-rise">
      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}
      <CapsuleVitals address={address} capsule={capsule}>
        {capsule.status === "active" && (
          <ActionButton
            busy={action.busy}
            busyLabel="Opening claim"
            label="Open the claim"
            disabled={!t?.canTrigger}
            title={t?.canTrigger ? "Anyone may do this once the owner is overdue" : "The owner's last proof of life is still fresh"}
            onClick={() => send("Opening claim", () => [triggerClaimIx({ capsule: address })])}
          />
        )}
        {capsule.status === "claimPending" && (
          <>
            <ActionButton
              busy={action.busy}
              busyLabel="Claiming"
              label="Claim the capsule"
              disabled={!t?.canClaim || !salt}
              title={salt ? "Opens the heir commitment: the chain learns that you are the heir" : "Needs a verified kit (it holds your salt)"}
              onClick={() => send("Claiming", () => [claimIx({ capsule: address, heir: actor.publicKey, salt: salt! })], actor)}
            />
            {!t?.canClaim && (
              <span className="text-right text-xs text-bone-500">
                {t && t.approvalCount < capsule.guardianThreshold
                  ? `waiting for guardians · ${t.approvalCount}/${capsule.guardianThreshold}`
                  : "grace period still running"}
              </span>
            )}
          </>
        )}
        {lastTx && <TxLink signature={lastTx} />}
      </CapsuleVitals>
      <Recovery address={address} capsule={capsule} inbox={inbox} verified={verified} />
    </article>
  );
}

function Recovery({
  address,
  capsule,
  inbox,
  verified,
}: {
  address: PublicKey;
  capsule: CapsuleAccount;
  inbox: Inbox;
  verified: ReturnType<typeof useVerifiedKit>;
}) {
  const mailbox = useMailbox();
  const action = useAction();
  const { kitText, checked, importKit } = verified;
  const [pasted, setPasted] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState<string>();
  const addressText = address.toBase58();

  const own = useMemo(() => {
    if (!checked.kit || !inbox) return undefined;
    const index = kit.findShareIndex(checked.kit, inbox.keyPair.publicKey);
    if (index < 0) return { error: "This kit has no share for your inbox key." };
    try {
      return { share: kit.openShare(checked.kit, index, inbox.keyPair.secretKey), index };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [checked.kit, inbox]);

  const tokens = [...new Set([...(mailbox.releases[addressText] ?? []), ...pasted])];
  const releases = useMemo(
    () =>
      tokens.map((token) => {
        try {
          if (!checked.kit || !inbox) throw new Error("waiting for kit and inbox");
          const { capsule: target, sealedHex } = decodeRelease(token);
          if (target !== addressText) throw new Error("release is for another capsule");
          const share = kit.openRelease(checked.kit, hexToBytes(sealedHex), inbox.keyPair.secretKey);
          return { token, share, index: kit.shareIndexOf(checked.kit, share) };
        } catch (e) {
          return { token, error: (e as Error).message.replace(/^kit: /, "") };
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tokens.join(","), checked.kit, inbox, addressText],
  );

  const shares = [own?.share, ...releases.map((r) => r.share)].filter((s): s is Uint8Array => Boolean(s));
  const indices = new Set([own?.index, ...releases.map((r) => r.index)].filter((i): i is number => i !== undefined && i >= 0));
  const needed = checked.kit?.threshold ?? capsule.guardianThreshold + 1;
  const canUnseal = capsule.status === "claimed" && checked.kit && indices.size >= needed;

  const unseal = () =>
    action.run("Unsealing", async () => {
      const bytes = await kit.recoverSecret(checked.kit!, shares);
      setRevealed(new TextDecoder().decode(bytes));
    });

  return (
    <section className="card ledger space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="eyebrow">Your key to this capsule</div>
        <div className="flex items-center gap-1.5" aria-label={`${indices.size} of ${needed} shares`}>
          {Array.from({ length: needed }, (_, i) => (
            <Seal
              key={i}
              label={i < indices.size ? "✓" : "?"}
              tone={i < indices.size ? (i === 0 && own?.share ? "bone" : "life") : "ash"}
              size={34}
              className={i < indices.size ? "animate-stamp" : "opacity-60"}
            />
          ))}
          <span className="ml-2 text-sm text-bone-300">
            {indices.size} / {needed} shares
          </span>
        </div>
      </div>

      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}

      {(!kitText || checked.error) && <KitImport onImport={importKit} rejected={Boolean(checked.error)} />}
      {checked.error && <Notice tone="error">Kit rejected: {checked.error}</Notice>}
      {checked.kit && (
        <Notice tone="success">
          Kit verified against the chain: same capsule, same share hashes, and every holder's wallet and salt open the
          heir and guardian commitments registered on-chain.
        </Notice>
      )}
      {own?.share && (
        <p className="text-sm leading-relaxed text-bone-300">
          You hold <span className="text-bone-50">share #{own.index}</span>.{" "}
          {indices.size < needed && "On its own it is statistically independent of the secret — every possible secret is equally consistent with it."}
        </p>
      )}
      {own?.error && <Notice tone="warn">{own.error}</Notice>}
      {!inbox && <Notice tone="warn">Create your inbox key to open your share.</Notice>}

      {releases.length > 0 && (
        <ul className="space-y-1.5">
          {releases.map((r) => (
            <li key={r.token} className={`flex items-center gap-2 text-sm ${r.share ? "text-verdigris-300" : "text-seal-300"}`}>
              {r.share ? `✓ guardian share #${r.index} released to you and authenticated` : `✕ release rejected: ${r.error}`}
            </li>
          ))}
        </ul>
      )}

      {capsule.status === "claimed" && (
        <div className="flex gap-2">
          <input className="mono text-xs" placeholder="paste a sikrit-release:v1:… token from a guardian" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn-ghost" disabled={!draft.trim()} onClick={() => (setPasted((p) => [...p, draft.trim()]), setDraft(""))}>
            Add
          </button>
        </div>
      )}

      {capsule.status !== "claimed" ? (
        <p className="text-xs text-bone-500">Guardian releases can only arrive after the capsule is claimed on-chain.</p>
      ) : !revealed ? (
        <ActionButton className="btn-seal px-6 py-3" busy={action.busy} busyLabel="Unsealing" label="Unseal the secret" disabled={!canUnseal} onClick={unseal} />
      ) : (
        <Revealed text={revealed} onClear={() => setRevealed(undefined)} />
      )}
    </section>
  );
}

/** Press-and-hold reveal, so a seed phrase is never on screen by accident. */
function Revealed({ text, onClear }: { text: string; onClear: () => void }) {
  const [holding, setHolding] = useState(false);
  const words = text.trim().split(/\s+/);
  const looksLikeSeed = words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]+$/.test(w));
  return (
    <div className="space-y-4 animate-rise">
      <div className="relative overflow-hidden rounded-xl border border-bone-300/30 bg-bone-100 p-6 text-ink-950 shadow-[0_30px_80px_-30px_rgba(236,227,210,0.35)]">
        <div className="eyebrow mb-4 text-ink-600">Recovered secret</div>
        <div className={`transition duration-300 ${holding ? "" : "blur-md select-none"}`}>
          {looksLikeSeed ? (
            <ol className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
              {words.map((word, i) => (
                <li key={i} className="flex gap-2 font-mono text-sm">
                  <span className="w-5 text-right text-ink-600">{i + 1}</span>
                  {word}
                </li>
              ))}
            </ol>
          ) : (
            <pre className="font-mono text-sm whitespace-pre-wrap">{text}</pre>
          )}
        </div>
        <Seal label="S" size={58} className="absolute -right-3 -bottom-3 rotate-12 opacity-90" />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-ghost"
          onMouseDown={() => setHolding(true)}
          onMouseUp={() => setHolding(false)}
          onMouseLeave={() => setHolding(false)}
          onTouchStart={() => setHolding(true)}
          onTouchEnd={() => setHolding(false)}
        >
          Hold to reveal
        </button>
        <button className="btn-quiet" onClick={onClear}>
          Clear from screen
        </button>
      </div>
      <p className="text-xs text-bone-500">Reconstructed in this browser from authenticated shares. Move the funds to a wallet you control.</p>
    </div>
  );
}

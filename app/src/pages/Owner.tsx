import { CapsuleAccount, PROGRAM_ID, createCapsuleIx, heartbeatIx, timeline } from "@sdk/client";
import * as kit from "@sdk/kit";
import * as liveness from "@sdk/liveness";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";

import { Inspector } from "../components/Inspector";
import { ActingAs } from "../components/Shell";
import { ActionButton, Copyable, Field, Heading, Notice, Stat, StatusChip } from "../components/ui";
import { Countdown, Ecg, Seal, Vital } from "../components/visuals";
import { CLUSTER } from "../config";
import { Actor, CAST, personaActor, relayerKeypair } from "../lib/actors";
import { who } from "../lib/capsule";
import { SentTransaction, ensureFunded, sendWithRelayer } from "../lib/chain";
import { duration, hex, short, when } from "../lib/format";
import { useAction, useCapsule, useChainNow } from "../lib/hooks";
import { useActor } from "../lib/identity";
import { download, postInvite, postKit, useMailbox } from "../lib/mailbox";

const SAMPLE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

export function OwnerPage() {
  const { actor, persona } = useActor("owner");
  const [secret, setSecret] = useState<bigint>();
  const [sent, setSent] = useState<SentTransaction>();
  const action = useAction();
  const actorKey = actor?.publicKey.toBase58();

  // A different identity means a different liveness key: forget everything derived so far.
  useEffect(() => {
    setSecret(undefined);
    setSent(undefined);
  }, [actorKey]);

  const commitment = useMemo(() => (secret ? liveness.commitmentFromSecret(secret) : undefined), [secret]);
  const address = useMemo(() => (commitment ? liveness.capsulePda(PROGRAM_ID, commitment)[0] : undefined), [commitment]);
  const { capsule, refresh } = useCapsule(address);

  const unlock = () =>
    action.run("Deriving", async () => {
      if (!actor) throw new Error("Choose who you are acting as first");
      setSecret(await liveness.deriveLivenessSecretFromWallet(actor.publicKey.toBytes(), actor.signMessage));
    });

  return (
    <div className="space-y-10">
      <div className="space-y-6 animate-rise">
        <Heading eyebrow={`Owner${persona ? ` · ${persona.name}` : ""}`} title="Your capsule">
          Seal a secret for the people you love. Prove you are alive with a zero-knowledge proof; if you fall silent,
          your guardians release it to your heir.
        </Heading>
        <ActingAs role="owner" />
      </div>

      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}

      {!secret ? (
        <UnlockCard actor={actor} busy={action.busy} onUnlock={unlock} />
      ) : capsule === undefined ? (
        <div className="card p-8 text-bone-400">Looking up your capsule…</div>
      ) : capsule === null ? (
        <CreateWizard
          actor={actor!}
          secret={secret}
          commitment={commitment!}
          address={address!}
          onCreated={(created) => {
            setSent(created);
            refresh();
          }}
        />
      ) : (
        <Dashboard actor={actor!} secret={secret} address={address!} capsule={capsule} sent={sent} onSent={setSent} />
      )}
    </div>
  );
}

function UnlockCard({ actor, busy, onUnlock }: { actor?: Actor; busy?: string; onUnlock: () => void }) {
  return (
    <section className="card ledger grid gap-8 p-8 md:grid-cols-[1fr_auto] md:items-center animate-rise [animation-delay:120ms]">
      <div className="space-y-4">
        <div className="eyebrow">Step 0 · your liveness key</div>
        <h2 className="font-display text-3xl text-bone-50">Unlock with a signature, not a transaction</h2>
        <p className="max-w-xl leading-relaxed text-bone-300">
          Your wallet signs a fixed message twice. SIKRIT hashes that signature into a separate secret{" "}
          <span className="mono text-bone-100">x</span> and publishes only <span className="mono text-bone-100">P = x·G</span>.
          Your wallet address never touches the capsule — and because the key is re-derived from your wallet, there is
          nothing new to back up.
        </p>
        <p className="text-xs text-bone-500">
          Signing twice checks that your wallet signs deterministically; wallets that don't would lock you out later.
        </p>
      </div>
      <ActionButton className="btn-seal px-6 py-3 text-base" busy={busy} busyLabel="Deriving" label="Derive my liveness key" onClick={onUnlock} disabled={!actor} />
    </section>
  );
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

const INTERVALS = [
  { label: "1 minute (demo)", seconds: 60 },
  { label: "3 minutes (demo)", seconds: 180 },
  { label: "30 days", seconds: 30 * 86_400 },
  { label: "90 days", seconds: 90 * 86_400 },
  { label: "180 days", seconds: 180 * 86_400 },
];
const GRACES = [
  { label: "1 minute (demo)", seconds: 60 },
  { label: "2 minutes (demo)", seconds: 120 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "14 days", seconds: 14 * 86_400 },
];

function parseInvite(text: string): { certificate?: kit.InboxCertificate; error?: string } {
  if (!text.trim()) return {};
  try {
    return { certificate: kit.decodeInboxCertificate(text) };
  } catch (e) {
    return { error: (e as Error).message.replace(/^kit: /, "") };
  }
}

function CreateWizard({
  actor,
  secret,
  commitment,
  address,
  onCreated,
}: {
  actor: Actor;
  secret: bigint;
  commitment: Uint8Array;
  address: PublicKey;
  onCreated: (sent: SentTransaction) => void;
}) {
  const mailbox = useMailbox();
  const action = useAction();
  const [heirText, setHeirText] = useState("");
  const [guardianTexts, setGuardianTexts] = useState<string[]>(["", "", ""]);
  const [plaintext, setPlaintext] = useState("");
  const [interval, setIntervalSeconds] = useState(CLUSTER === "devnet" ? 180 : 60);
  const [grace, setGrace] = useState(60);
  const [quorum, setQuorum] = useState(2);

  const heir = parseInvite(heirText);
  const guardians = guardianTexts.map(parseInvite);
  const validGuardians = guardians.filter((g) => g.certificate).map((g) => g.certificate!);
  const effectiveQuorum = Math.min(Math.max(1, quorum), Math.max(1, validGuardians.length));
  const secretBytes = new TextEncoder().encode(plaintext);
  const inviteProblems = [heir, ...guardians].some((x) => x.error);
  const ready = heir.certificate && validGuardians.length > 0 && secretBytes.length > 0 && !inviteProblems;

  const inviteFamily = () =>
    action.run("Inviting", async () => {
      const family = CAST.filter((p) => p.role !== "owner");
      const invites = new Map<string, string>();
      for (const persona of family) {
        const member = personaActor(persona);
        const { certificate } = await kit.createInbox(member.publicKey.toBytes(), member.signMessage);
        const invite = kit.encodeInboxCertificate(certificate);
        postInvite(member.publicKey.toBase58(), invite);
        invites.set(persona.id, invite);
      }
      setHeirText(invites.get("sari")!);
      setGuardianTexts(["budi", "dewi", "rizal"].map((id) => invites.get(id)!));
      setQuorum(2);
    });

  const seal = () =>
    action.run("Sealing", async () => {
      const config: liveness.CapsuleConfigInput = {
        heir: new PublicKey(heir.certificate!.wallet),
        heartbeatInterval: BigInt(interval),
        gracePeriod: BigInt(grace),
        guardians: validGuardians.map((g) => new PublicKey(g.wallet)),
        guardianThreshold: effectiveQuorum,
        shareHashes: [],
      };
      // The heir's share plus `quorum` guardian shares reconstruct: the cryptographic threshold
      // mirrors the guardian quorum the program enforces.
      const sealed = await kit.sealCapsuleKit({
        secret: secretBytes,
        commitment,
        heir: heir.certificate!,
        guardians: validGuardians,
        threshold: effectiveQuorum + 1,
      });
      config.shareHashes = sealed.shareHashes;
      const proof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);
      const relayer = relayerKeypair();
      await ensureFunded(relayer.publicKey, 0.05, CLUSTER === "devnet" ? 1 : 5);
      const sent = await sendWithRelayer([createCapsuleIx({ payer: relayer.publicKey, commitment, config, proof })], relayer);
      postKit(address.toBase58(), kit.encodeKit(sealed));
      setPlaintext("");
      onCreated(sent);
    });

  const knownInvites = Object.entries(mailbox.invites);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}

        <Step n={1} title="Who inherits, who guards" done={Boolean(heir.certificate && validGuardians.length)}>
          <p className="text-sm leading-relaxed text-bone-300">
            Your heir and guardians each send you an <em>invite</em>: an encryption key signed by their wallet. SIKRIT
            checks every signature, so nobody in between can swap in their own key.
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionButton className="btn-ghost" busy={action.busy} busyLabel="Inviting" label="Invite the demo family" onClick={inviteFamily} />
            {knownInvites.length > 0 && <span className="self-center text-xs text-bone-500">{knownInvites.length} invite(s) in this browser's mailbox</span>}
          </div>
          <InviteInput label="Heir" value={heirText} onChange={setHeirText} parsed={heir} />
          {guardianTexts.map((text, i) => (
            <InviteInput
              key={i}
              label={`Guardian ${i + 1}`}
              value={text}
              onChange={(value) => setGuardianTexts((list) => list.map((t, j) => (j === i ? value : t)))}
              parsed={guardians[i]}
              optional={i > 0}
            />
          ))}
          {guardianTexts.length < 5 && (
            <button className="btn-quiet" onClick={() => setGuardianTexts((list) => [...list, ""])}>
              + add guardian
            </button>
          )}
        </Step>

        <Step n={2} title="What to seal" done={secretBytes.length > 0}>
          <Field
            label="Secret"
            hint="Encrypted in this browser under a fresh random key; only the key is split. The plaintext never leaves your device."
          >
            <textarea
              rows={3}
              className="mono leading-relaxed"
              value={plaintext}
              placeholder="seed phrase, password, instructions for your family…"
              onChange={(e) => setPlaintext(e.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between text-xs text-bone-500">
            <button className="btn-quiet px-0" onClick={() => setPlaintext(SAMPLE_SEED)}>
              Use a sample seed phrase
            </button>
            <span>{secretBytes.length} / {kit.MAX_SECRET_LENGTH} bytes</span>
          </div>
        </Step>

        <Step n={3} title="The rules of silence" done>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Heartbeat every" hint="Miss one and anyone may open a claim.">
              <select value={interval} onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
                {INTERVALS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Grace period" hint="Time to cancel a false alarm.">
              <select value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
                {GRACES.map((o) => (
                  <option key={o.seconds} value={o.seconds}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Guardian quorum" hint={`of ${Math.max(1, validGuardians.length)} guardian(s)`}>
              <select value={effectiveQuorum} onChange={(e) => setQuorum(Number(e.target.value))}>
                {Array.from({ length: Math.max(1, validGuardians.length) }, (_, i) => i + 1).map((q) => (
                  <option key={q} value={q}>{q}</option>
                ))}
              </select>
            </Field>
          </div>
          <p className="rounded-lg border border-ink-700 bg-ink-950/50 p-4 text-sm leading-relaxed text-bone-300">
            The key is split <span className="text-bone-50">{effectiveQuorum + 1}-of-{validGuardians.length + 1}</span>: your
            heir holds one share and each guardian one. Your heir alone learns <em>nothing</em>; after the claim,{" "}
            {effectiveQuorum} guardian{effectiveQuorum > 1 ? "s" : ""} must release their shares.
            {validGuardians.length > effectiveQuorum && (
              <span className="mt-2 block text-xs text-amber-glow">
                Any {effectiveQuorum + 1} shares open it, so {effectiveQuorum + 1} guardians acting together could open it
                without your heir. That is also how your heir recovers if they lose their wallet. To always require your
                heir, set the quorum to all {validGuardians.length} guardians.
              </span>
            )}
          </p>
        </Step>

        <Step n={4} title="Seal and register" done={false}>
          <p className="text-sm leading-relaxed text-bone-300">
            One transaction, paid by the relayer: it stores <span className="mono">P</span>, the rules and one hash per
            share, plus a proof that you know <span className="mono">x</span>. No wallet of yours signs it.
          </p>
          <ActionButton className="btn-seal px-6 py-3 text-base" busy={action.busy} busyLabel="Sealing" label="Seal the capsule" onClick={seal} disabled={!ready} />
        </Step>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <div className="card space-y-4 p-5">
          <div className="eyebrow">Your capsule will live at</div>
          <Copyable text={address.toBase58()} display={short(address, 8, 8)} />
          <div className="eyebrow pt-2">Public key P = x·G</div>
          <div className="mono break-all text-bone-400">{hex(commitment)}</div>
          <p className="text-xs leading-relaxed text-bone-500">
            Derived from P alone. Signed in as {who(actor.publicKey)}, yet that wallet is not part of this address, its
            data, or any future heartbeat.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section className="card space-y-4 p-6 animate-rise" style={{ animationDelay: `${n * 70}ms` }}>
      <div className="flex items-center gap-3">
        <span className={`grid size-7 place-items-center rounded-full border font-display text-sm ${done ? "border-verdigris-400 text-verdigris-300" : "border-ink-600 text-bone-400"}`}>
          {done ? "✓" : n}
        </span>
        <h2 className="font-display text-2xl text-bone-50">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function InviteInput({
  label,
  value,
  onChange,
  parsed,
  optional,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  parsed: { certificate?: kit.InboxCertificate; error?: string };
  optional?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}{optional ? " (optional)" : ""}</span>
        {parsed.certificate && (
          <span className="flex items-center gap-2 text-xs text-verdigris-300">
            ✓ signed by {who(parsed.certificate.wallet)}
          </span>
        )}
        {parsed.error && <span className="text-xs text-seal-300">{parsed.error}</span>}
      </div>
      <input className="mono text-xs" value={value} placeholder="sikrit-invite:v1:…" onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------

function Dashboard({
  actor,
  secret,
  address,
  capsule,
  sent,
  onSent,
}: {
  actor: Actor;
  secret: bigint;
  address: PublicKey;
  capsule: CapsuleAccount;
  sent?: SentTransaction;
  onSent: (sent: SentTransaction) => void;
}) {
  const now = useChainNow();
  const action = useAction();
  const mailbox = useMailbox();
  const [beats, setBeats] = useState(0);
  const t = now !== undefined ? timeline(capsule, now) : undefined;
  const relayer = relayerKeypair();

  const heartbeat = () =>
    action.run("Proving", async () => {
      const proof = liveness.proveLiveness(secret, PROGRAM_ID, address, capsule.heartbeatNonce);
      await ensureFunded(relayer.publicKey, 0.01, CLUSTER === "devnet" ? 1 : 5);
      onSent(await sendWithRelayer([heartbeatIx({ capsule: address, proof })], relayer));
      setBeats((b) => b + 1);
    });

  const vital: Vital = capsule.status === "claimed" ? "flat" : capsule.status === "claimPending" ? "pending" : t?.canTrigger ? "pending" : "alive";
  const remaining = t ? (capsule.status === "claimPending" ? t.claimableAt! - now! : t.expiresAt - now!) : 0n;

  return (
    <div className="space-y-6">
      {action.error && <Notice tone="error" onClose={action.clearError}>{action.error}</Notice>}

      <section className="card overflow-hidden animate-rise">
        <div className="grid gap-8 p-7 md:grid-cols-[1.2fr_1fr] md:items-end">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <StatusChip status={capsule.status} />
              <span className="mono text-bone-500">{short(address, 6, 6)}</span>
            </div>
            {capsule.status === "active" && (
              <>
                <div className="eyebrow">{t?.canTrigger ? "Overdue — anyone may open a claim now" : "Your capsule stays sealed for"}</div>
                <Countdown seconds={remaining} tone={t?.canTrigger ? "seal" : "life"} />
              </>
            )}
            {capsule.status === "claimPending" && (
              <>
                <div className="eyebrow text-amber-glow">A claim is open. Prove you're alive to cancel it — within</div>
                <Countdown seconds={remaining} tone="amber" />
              </>
            )}
            {capsule.status === "claimed" && (
              <>
                <div className="eyebrow">Released to {who(capsule.heir)}</div>
                <p className="font-display text-3xl text-seal-300">The capsule has been claimed.</p>
              </>
            )}
          </div>
          <div className="flex flex-col items-start gap-3 md:items-end">
            {capsule.status !== "claimed" && (
              <ActionButton
                className={`btn-life px-7 py-4 text-base ${beats ? "animate-beat" : ""}`}
                key={beats}
                busy={action.busy}
                busyLabel="Proving"
                label={capsule.status === "claimPending" ? "I'm alive — cancel the claim" : "Send ZK heartbeat"}
                onClick={heartbeat}
              />
            )}
            <span className="text-xs text-bone-500">Proof generated in your browser · relayed by {short(relayer.publicKey)}</span>
          </div>
        </div>
        <Ecg vital={vital} beatKey={beats} className="-mt-2" />
      </section>

      {sent && (
        <Inspector
          sent={sent}
          known={[
            { address, label: "Your capsule (derived from P)" },
            { address: relayer.publicKey, label: "Relayer · fee payer" },
          ]}
          absent={[{ address: actor.publicKey, label: `Your wallet (${actor.name})` }]}
        />
      )}

      <section className="grid gap-6 md:grid-cols-3">
        <div className="card space-y-5 p-6 md:col-span-2">
          <div className="eyebrow">The rules you set</div>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
            <Stat label="Heir" value={who(capsule.heir)} />
            <Stat label="Heartbeat every" value={duration(capsule.heartbeatInterval)} />
            <Stat label="Grace period" value={duration(capsule.gracePeriod)} />
            <Stat label="Guardian quorum" value={`${capsule.guardianThreshold} of ${capsule.guardians.length}`} />
            <Stat label="Heartbeats proven" value={capsule.heartbeatNonce.toString()} sub="each proof valid exactly once" />
            <Stat label="Last proof of life" value={<span className="text-sm">{when(capsule.lastHeartbeat)}</span>} />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {capsule.guardians.map((g, i) => (
              <span key={g.toBase58()} className="chip border-ink-600 text-bone-300">
                <Seal label={String(i + 1)} tone="life" size={16} />
                {who(g)}
                {capsule.approvals & (1 << i) ? <span className="text-amber-glow">· confirmed</span> : null}
              </span>
            ))}
          </div>
        </div>
        <div className="card space-y-4 p-6">
          <div className="eyebrow">Sealed kit</div>
          <p className="text-sm leading-relaxed text-bone-300">
            {capsule.shareHashes.length} encrypted shares, one per holder. Only their hashes are on-chain.
          </p>
          {mailbox.kits[address.toBase58()] ? (
            <>
              <Notice tone="success">Delivered to the family's inboxes (demo mailbox).</Notice>
              <button className="btn-ghost w-full" onClick={() => download(`sikrit-kit-${short(address, 6, 0)}.json`, mailbox.kits[address.toBase58()])}>
                Download kit
              </button>
            </>
          ) : (
            <Notice tone="warn">No copy of the kit in this browser. Holders need the kit file you downloaded when sealing.</Notice>
          )}
        </div>
      </section>
    </div>
  );
}

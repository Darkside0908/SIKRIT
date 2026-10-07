import { CapsuleAccount, PROGRAM_ID, createCapsuleIx, fetchCapsule, heartbeatIx, timeline, updateCapsuleIx } from "@sdk/client";
import * as kit from "@sdk/kit";
import * as liveness from "@sdk/liveness";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Inspector } from "../components/Inspector";
import { ActingAs } from "../components/Shell";
import { ActionButton, Copyable, Field, Heading, Notice, Stat, StatusChip } from "../components/ui";
import { Countdown, Ecg, Seal, Vital } from "../components/visuals";
import { CLUSTER } from "../config";
import { Actor, CAST, personaActor } from "../lib/actors";
import { chainState, useAdoptPendingKit, useMailboxKit, who } from "../lib/capsule";
import { SentTransaction, connection, readChainTime, sendWithRelayer } from "../lib/chain";
import { getRelayer, sendRelayed, useRelayer } from "../lib/relayer";
import { duration, hex, short, when } from "../lib/format";
import { useAction, useCapsule, useChainNow } from "../lib/hooks";
import { useActor } from "../lib/identity";
import { download, postInvite, postKit, postPendingKit, useMailbox } from "../lib/mailbox";

const SAMPLE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

export function OwnerPage() {
  const { actor, persona } = useActor("owner");
  const [derived, setDerived] = useState<{ by: string; secret: bigint }>();
  const [sent, setSent] = useState<SentTransaction>();
  const action = useAction();
  const actorKey = actor?.publicKey.toBase58();
  // The liveness key belongs to the identity that derived it. Another identity, or none (a wallet that disconnected or
  // locked), never renders with it, not even for the one frame before the effect below runs.
  const secret = actorKey !== undefined && derived?.by === actorKey ? derived.secret : undefined;

  // A different identity means a different liveness key: forget everything derived so far.
  useEffect(() => {
    setDerived((current) => (current?.by === actorKey ? current : undefined));
    setSent(undefined);
  }, [actorKey]);

  const commitment = useMemo(() => (secret ? liveness.commitmentFromSecret(secret) : undefined), [secret]);
  const address = useMemo(() => (commitment ? liveness.capsulePda(PROGRAM_ID, commitment)[0] : undefined), [commitment]);
  const { capsule, error: capsuleError, refresh } = useCapsule(address);

  const unlock = () =>
    action.run("Deriving", async () => {
      if (!actor) throw new Error("Choose who you are acting as first");
      const secret = await liveness.deriveLivenessSecretFromWallet(actor.publicKey.toBytes(), actor.signMessage);
      setDerived({ by: actor.publicKey.toBase58(), secret });
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
      ) : capsule === undefined && capsuleError ? (
        <Notice tone="error">
          Your capsule could not be read: {capsuleError}. A capsule made by an earlier protocol version cannot be used
          with this one{actor?.kind === "persona" ? "; reset the demo for a fresh cast" : ""}.
        </Notice>
      ) : capsule === undefined ? (
        <div className="card p-8 text-bone-400">Looking up your capsule…</div>
      ) : capsule === null ? (
        <SealWizard
          actor={actor!}
          secret={secret}
          commitment={commitment!}
          address={address!}
          mode={{ kind: "create" }}
          onSent={(created) => {
            setSent(created);
            refresh();
          }}
          onFailed={refresh}
        />
      ) : (
        <Dashboard
          actor={actor!}
          secret={secret}
          commitment={commitment!}
          address={address!}
          capsule={capsule}
          sent={sent}
          onSent={setSent}
          onRefresh={refresh}
        />
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

/** Creating a capsule, or re-sealing an existing one with new holders and rules (`update_capsule`). */
type SealMode = { kind: "create" } | { kind: "update"; capsule: CapsuleAccount; kit?: kit.CapsuleKit };

/** The interval/grace choices, plus the capsule's current value when it is not one of them. */
function choices(options: { label: string; seconds: number }[], current?: number) {
  return current === undefined || options.some((o) => o.seconds === current)
    ? options
    : [...options, { label: `${duration(current)} (current)`, seconds: current }];
}

const hashesKey = (hashes: Uint8Array[]) => hashes.map(hex).join(",");

function SealWizard({
  actor,
  secret,
  commitment,
  address,
  mode,
  onSent,
  onFailed,
  onCancel,
}: {
  actor: Actor;
  secret: bigint;
  commitment: Uint8Array;
  address: PublicKey;
  mode: SealMode;
  onSent: (sent?: SentTransaction) => void;
  /** Re-reads the capsule: a transaction whose confirmation failed may have landed anyway. */
  onFailed: () => void;
  onCancel?: () => void;
}) {
  const updating = mode.kind === "update" ? mode : undefined;
  const mailbox = useMailbox();
  const action = useAction();
  // Re-sealing starts from the current holders and rules: change what changed.
  const [heirText, setHeirText] = useState(() => (updating?.kit ? kit.encodeInboxCertificate(updating.kit.shares[0].holder) : ""));
  const [guardianTexts, setGuardianTexts] = useState<string[]>(() =>
    updating?.kit ? updating.kit.shares.slice(1).map((entry) => kit.encodeInboxCertificate(entry.holder)) : ["", "", ""],
  );
  const [plaintext, setPlaintext] = useState("");
  const [interval, setIntervalSeconds] = useState(() =>
    updating ? Number(updating.capsule.heartbeatInterval) : CLUSTER === "devnet" ? 180 : 60,
  );
  const [grace, setGrace] = useState(() => (updating ? Number(updating.capsule.gracePeriod) : 60));
  const [quorum, setQuorum] = useState(() => updating?.capsule.guardianThreshold || 2);
  // Share hashes of the kit sealed for the update in flight: once the chain shows them, the update landed.
  const [inFlight, setInFlight] = useState<string>();

  const heir = parseInvite(heirText);
  const guardians = guardianTexts.map(parseInvite);
  const validGuardians = guardians.filter((g) => g.certificate).map((g) => g.certificate!);
  const effectiveQuorum = Math.min(Math.max(1, quorum), Math.max(1, validGuardians.length));
  const secretBytes = new TextEncoder().encode(plaintext);
  const inviteProblems = [heir, ...guardians].some((x) => x.error);
  const ready = heir.certificate && validGuardians.length > 0 && secretBytes.length > 0 && !inviteProblems;

  // An update whose reply was lost (SIK-22) still shows up on-chain: close as if it had been confirmed.
  const landed = Boolean(updating && inFlight && inFlight === hashesKey(updating.capsule.shareHashes));
  useEffect(() => {
    if (landed) onSent();
  }, [landed, onSent]);

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
      // An earlier attempt may have landed although the app never heard back: never register twice.
      if (!updating && (await fetchCapsule(connection, address))) return onFailed();
      // The heir's share plus `quorum` guardian shares reconstruct: the cryptographic threshold
      // mirrors the guardian quorum the program enforces.
      const sealed = await kit.sealCapsuleKit({
        secret: secretBytes,
        commitment,
        heir: heir.certificate!,
        guardians: validGuardians,
        threshold: effectiveQuorum + 1,
      });
      // The chain gets salted commitments to the heir and guardians, never their wallets; the salts stay in the kit.
      const roster = kit.rosterCommitments(sealed);
      const config: liveness.CapsuleConfigInput = {
        heirCommitment: roster.heir,
        heartbeatInterval: BigInt(interval),
        gracePeriod: BigInt(grace),
        guardianCommitments: roster.guardians,
        guardianThreshold: effectiveQuorum,
        shareHashes: sealed.shareHashes,
      };
      const relayer = await getRelayer();
      let instruction;
      if (updating) {
        // Proven like a heartbeat, over the whole new config: no wallet signs, nobody can alter the rules in transit.
        const expiresAt = (await readChainTime()) + liveness.DEFAULT_PROOF_LIFETIME;
        const proof = liveness.proveUpdate(secret, PROGRAM_ID, address, updating.capsule.heartbeatNonce, expiresAt, config);
        instruction = updateCapsuleIx({ capsule: address, config, proof, expiresAt });
        await relayer.ready(0.01);
      } else {
        const proof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);
        instruction = createCapsuleIx({ payer: relayer.publicKey, commitment, config, proof });
        // The relayer also pays the new capsule's rent (~0.004 SOL), hence the larger top-up for a browser relayer.
        await relayer.ready(0.05);
      }
      // Filed before broadcasting (SIK-22): if the confirmation is lost although the transaction landed, the
      // dashboard adopts this kit, so a capsule on-chain never ends up without the kit that matches it.
      const text = kit.encodeKit(sealed);
      postPendingKit(address.toBase58(), text);
      setInFlight(hashesKey(sealed.shareHashes));
      try {
        const sent = await sendWithRelayer([instruction], relayer);
        postKit(address.toBase58(), text);
        setPlaintext("");
        onSent(sent);
      } catch (error) {
        onFailed();
        throw error;
      }
    });

  const knownInvites = Object.entries(mailbox.invites);

  return (
    <div className={updating ? "space-y-6" : "grid gap-6 lg:grid-cols-[1fr_20rem]"}>
      <div className="space-y-6">
        {action.error && (
          <Notice tone="error" onClose={action.clearError}>
            {action.error}
            {updating && inFlight && " If only the reply was lost, the update may still land; this closes when the chain shows it."}
          </Notice>
        )}

        <Step n={1} title={updating ? "Who inherits, who guards — now" : "Who inherits, who guards"} done={Boolean(heir.certificate && validGuardians.length)}>
          <p className="text-sm leading-relaxed text-bone-300">
            {updating
              ? "Your current heir and guardians are filled in from your kit. Replace, remove or add anyone: each needs an invite signed by their own wallet."
              : "Your heir and guardians each send you an invite: an encryption key signed by their wallet. SIKRIT checks every signature, so nobody in between can swap in their own key."}
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

        <Step n={2} title={updating ? "What to seal, again" : "What to seal"} done={secretBytes.length > 0}>
          <Field
            label="Secret"
            hint={
              updating
                ? "Enter it again (or a new one): the capsule gets a fresh key and new shares, and your current kit stops matching the chain. It never leaves your device."
                : "Encrypted in this browser under a fresh random key; only the key is split. The plaintext never leaves your device."
            }
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
                {choices(INTERVALS, updating && Number(updating.capsule.heartbeatInterval)).map((o) => (
                  <option key={o.seconds} value={o.seconds}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Grace period" hint="Time to cancel a false alarm.">
              <select value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
                {choices(GRACES, updating && Number(updating.capsule.gracePeriod)).map((o) => (
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

        {updating ? (
          <Step n={4} title="Re-seal and update" done={false}>
            <p className="text-sm leading-relaxed text-bone-300">
              One transaction, paid by the relayer and authorized like a heartbeat: a proof that you know{" "}
              <span className="mono">x</span>, bound to the new rules. It also proves you are alive (a pending claim is
              cancelled). The chain forgets the old commitments and share hashes, so guardians refuse to release from the
              old kit; send everyone the new one.
            </p>
            <p className="text-xs leading-relaxed text-amber-glow">
              Shares already handed out are not taken back: enough former holders together could still open the old kit
              offline. If you remove someone you no longer trust, also move the funds behind the secret.
            </p>
            <div className="flex flex-wrap gap-2">
              <ActionButton className="btn-seal px-6 py-3 text-base" busy={action.busy} busyLabel="Sealing" label="Re-seal and update" onClick={seal} disabled={!ready} />
              {onCancel && (
                <button className="btn-ghost" onClick={onCancel} disabled={Boolean(action.busy)}>
                  Cancel
                </button>
              )}
            </div>
          </Step>
        ) : (
          <Step n={4} title="Seal and register" done={false}>
            <p className="text-sm leading-relaxed text-bone-300">
              One transaction, paid by the relayer: it stores <span className="mono">P</span>, the rules, one hash per
              share and a salted commitment to each family member, plus a proof that you know{" "}
              <span className="mono">x</span>. No wallet signs it, yours or theirs, and none is written to the chain.
            </p>
            <ActionButton className="btn-seal px-6 py-3 text-base" busy={action.busy} busyLabel="Sealing" label="Seal the capsule" onClick={seal} disabled={!ready} />
          </Step>
        )}
      </div>

      {!updating && (
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
      )}
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
  commitment,
  address,
  capsule,
  sent,
  onSent,
  onRefresh,
}: {
  actor: Actor;
  secret: bigint;
  commitment: Uint8Array;
  address: PublicKey;
  capsule: CapsuleAccount;
  sent?: SentTransaction;
  onSent: (sent: SentTransaction) => void;
  onRefresh: () => void;
}) {
  const now = useChainNow();
  const action = useAction();
  const mailbox = useMailbox();
  const ownKit = useMailboxKit(address);
  useAdoptPendingKit(address, capsule);
  const [beats, setBeats] = useState(0);
  const [editing, setEditing] = useState(false);
  const closeEditor = useCallback(
    (updated?: SentTransaction) => {
      if (updated) onSent(updated);
      setEditing(false);
    },
    [onSent],
  );
  const relayer = useRelayer();
  const t = now !== undefined ? timeline(capsule, now) : undefined;
  // Names come only from a kit that matches the chain: right after an update the filed kit may still be the old one.
  const currentKit = useMemo(() => {
    try {
      if (ownKit) kit.verifyKit(ownKit, chainState(capsule));
      return ownKit;
    } catch {
      return undefined;
    }
  }, [ownKit, capsule]);
  const family = currentKit?.shares.map((entry) => new PublicKey(entry.holder.wallet)) ?? [];

  const heartbeat = () =>
    action.run("Proving", async () => {
      // Bound to the cluster clock: a relayer that holds the proof back finds it expired within minutes.
      const expiresAt = (await readChainTime()) + liveness.DEFAULT_PROOF_LIFETIME;
      const proof = liveness.proveLiveness(secret, PROGRAM_ID, address, capsule.heartbeatNonce, expiresAt);
      onSent(await sendRelayed([heartbeatIx({ capsule: address, proof, expiresAt })]));
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
                <div className="eyebrow">Released to {capsule.heir ? who(capsule.heir) : "the heir"}</div>
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
            <span className="text-xs text-bone-500">
              Proof generated in your browser · relayed by {relayer ? short(relayer.publicKey) : "…"}
              {relayer?.kind === "service" && " (relayer service)"}
            </span>
          </div>
        </div>
        <Ecg vital={vital} beatKey={beats} className="-mt-2" />
      </section>

      {sent && (
        <Inspector
          sent={sent}
          known={[
            { address, label: "Your capsule (derived from P)" },
            { address: sent.transaction.feePayer!, label: "Relayer · fee payer" },
          ]}
          absent={[
            { address: actor.publicKey, label: `Your wallet (${actor.name})` },
            ...family.map((wallet, i) => ({ address: wallet, label: `${who(wallet)}'s wallet (${i === 0 ? "heir" : "guardian"})` })),
          ]}
        />
      )}

      {editing ? (
        <section className="space-y-5 animate-rise">
          <div className="space-y-1">
            <div className="eyebrow">Re-seal your capsule</div>
            <p className="max-w-3xl text-sm leading-relaxed text-bone-400">
              Same address, same liveness key; new heir, guardians, quorum or timers, and a new kit for everyone who holds
              a share.
            </p>
          </div>
          <SealWizard
            actor={actor}
            secret={secret}
            commitment={commitment}
            address={address}
            mode={{ kind: "update", capsule, kit: currentKit }}
            onSent={closeEditor}
            onFailed={onRefresh}
            onCancel={() => setEditing(false)}
          />
        </section>
      ) : (
      <section className="grid gap-6 md:grid-cols-3">
        <div className="card space-y-5 p-6 md:col-span-2">
          <div className="eyebrow">The rules you set</div>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
            <Stat label="Heir" value={family[0] ? who(family[0]) : "sealed"} sub="on-chain: a salted commitment" />
            <Stat label="Heartbeat every" value={duration(capsule.heartbeatInterval)} />
            <Stat label="Grace period" value={duration(capsule.gracePeriod)} />
            <Stat label="Guardian quorum" value={`${capsule.guardianThreshold} of ${capsule.guardianCommitments.length}`} />
            <Stat label="Heartbeats proven" value={capsule.heartbeatNonce.toString()} sub="each proof valid once, for minutes" />
            <Stat label="Last proof of life" value={<span className="text-sm">{when(capsule.lastHeartbeat)}</span>} />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {capsule.guardianCommitments.map((c, i) => (
              <span key={hex(c)} className="chip border-ink-600 text-bone-300">
                <Seal label={String(i + 1)} tone="life" size={16} />
                {family[i + 1] ? who(family[i + 1]) : `sealed ${hex(c).slice(0, 8)}…`}
                {capsule.approvals & (1 << i) ? <span className="text-amber-glow">· confirmed</span> : null}
              </span>
            ))}
          </div>
          {capsule.status !== "claimed" && (
            <button className="btn-ghost" onClick={() => setEditing(true)}>
              Change heir, guardians or rules
            </button>
          )}
        </div>
        <div className="card space-y-4 p-6">
          <div className="eyebrow">Sealed kit</div>
          <p className="text-sm leading-relaxed text-bone-300">
            {capsule.shareHashes.length} encrypted shares, one per holder. Only their hashes are on-chain.
          </p>
          {currentKit ? (
            <>
              <Notice tone="success">Delivered to the family's inboxes (demo mailbox).</Notice>
              <button className="btn-ghost w-full" onClick={() => download(`sikrit-kit-${short(address, 6, 0)}.json`, mailbox.kits[address.toBase58()])}>
                Download kit
              </button>
            </>
          ) : mailbox.kits[address.toBase58()] ? (
            <Notice tone="warn">The kit in this browser no longer matches the capsule on-chain.</Notice>
          ) : (
            <Notice tone="warn">No copy of the kit in this browser. Holders need the kit file you downloaded when sealing.</Notice>
          )}
        </div>
      </section>
      )}
    </div>
  );
}

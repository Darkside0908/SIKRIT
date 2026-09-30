import { DISCRIMINATORS, PROGRAM_ID } from "@sdk/client";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import type { SentTransaction } from "../lib/chain";
import { hex, short } from "../lib/format";
import { TxLink } from "./ui";

const INSTRUCTION_NAMES: [Uint8Array, string][] = [
  [DISCRIMINATORS.createCapsule, "create_capsule"],
  [DISCRIMINATORS.heartbeat, "heartbeat"],
  [DISCRIMINATORS.triggerClaim, "trigger_claim"],
  [DISCRIMINATORS.guardianConfirm, "guardian_confirm"],
  [DISCRIMINATORS.guardianVeto, "guardian_veto"],
  [DISCRIMINATORS.claim, "claim"],
];

const instructionName = (data: Uint8Array) =>
  INSTRUCTION_NAMES.find(([disc]) => disc.every((b, i) => b === data[i]))?.[1] ?? "unknown";

/** Splits instruction data into labelled byte ranges for the known SIKRIT instructions. */
function dataSegments(name: string, data: Uint8Array): { label: string; bytes: Uint8Array; tone: string }[] {
  const seg = (label: string, from: number, to: number, tone: string) => ({ label, bytes: data.slice(from, to), tone });
  const disc = seg("discriminator", 0, 8, "text-bone-500");
  if (name === "heartbeat") {
    return [disc, seg("R = k·G", 8, 40, "text-verdigris-300"), seg("s = k + e·x", 40, 72, "text-verdigris-300")];
  }
  if (name === "create_capsule") {
    return [
      disc,
      seg("commitment P = x·G", 8, 40, "text-seal-300"),
      seg("config (heir, timers, guardians, share hashes)", 40, data.length - 64, "text-bone-300"),
      seg("proof-of-possession (R, s)", data.length - 64, data.length, "text-verdigris-300"),
    ];
  }
  return [disc];
}

export interface KnownAccount {
  address: PublicKey;
  label: string;
}

/**
 * "What the chain sees": the exact accounts, signers and bytes of a transaction that was just
 * broadcast, next to the identities that are provably absent from it.
 */
export function Inspector({
  sent,
  known,
  absent,
  title = "What the chain sees",
}: {
  sent: SentTransaction;
  known: KnownAccount[];
  absent: KnownAccount[];
  title?: string;
}) {
  const message = sent.transaction.compileMessage();
  const keys = message.accountKeys;
  const labelOf = (key: PublicKey) =>
    known.find((k) => k.address.equals(key))?.label ??
    (key.equals(PROGRAM_ID) ? "SIKRIT program" : key.equals(SystemProgram.programId) ? "System program" : "—");
  const sikritIx = sent.transaction.instructions.find((ix) => ix.programId.equals(PROGRAM_ID));
  const data = sikritIx ? Uint8Array.from(sikritIx.data) : new Uint8Array();
  const name = sikritIx ? instructionName(data) : "—";
  const signerCount = message.header.numRequiredSignatures;

  return (
    <section className="card overflow-hidden animate-rise">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 bg-ink-850/70 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="font-display text-lg text-bone-50">{title}</span>
          <span className="mono rounded border border-ink-600 px-1.5 py-0.5 text-bone-400">{name}</span>
        </div>
        <TxLink signature={sent.signature} />
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-5">
          <div>
            <div className="eyebrow mb-2">Accounts ({keys.length})</div>
            <ul className="divide-y divide-ink-700/70 rounded-lg border border-ink-700">
              {keys.map((key, i) => (
                <li key={key.toBase58()} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-sm text-bone-200">{labelOf(key)}</span>
                  <span className="flex items-center gap-2">
                    {i < signerCount && <span className="chip border-bone-500/50 text-bone-300">signer</span>}
                    {message.isAccountWritable(i) && <span className="chip border-ink-600 text-bone-500">writable</span>}
                    <span className="mono text-bone-400">{short(key, 5, 5)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="eyebrow mb-2">Instruction data ({data.length} bytes)</div>
            <div className="space-y-2 rounded-lg border border-ink-700 bg-ink-950/60 p-3">
              {dataSegments(name, data).map((segment) => (
                <div key={segment.label} className="grid gap-1 sm:grid-cols-[11rem_1fr]">
                  <span className="text-xs text-bone-500">{segment.label}</span>
                  <span className={`mono break-all leading-relaxed ${segment.tone}`}>{hex(segment.bytes)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="eyebrow">Not in this transaction</div>
          {absent.map((account) => {
            const present = keys.some((key) => key.equals(account.address));
            return (
              <div key={account.label} className="relative rounded-lg border border-ink-700 bg-ink-950/50 p-4">
                <div className="text-sm text-bone-200">{account.label}</div>
                <div className="mono mt-1 text-bone-500">{short(account.address, 6, 6)}</div>
                <span
                  className={`stamp absolute top-3 right-3 animate-stamp ${present ? "border-seal-400 text-seal-400" : "border-verdigris-400 text-verdigris-300"}`}
                >
                  {present ? "Present!" : "Not present"}
                </span>
              </div>
            );
          })}
          <div className="rounded-lg border border-dashed border-ink-600 p-4 text-sm leading-relaxed text-bone-400">
            <div className="eyebrow mb-2 text-bone-500">Never leaves the device</div>
            <div className="space-y-1.5">
              <div>
                liveness secret <span className="mono text-bone-500">x</span> <span className="redact w-28" />
              </div>
              <div>
                the sealed secret <span className="redact w-36" />
              </div>
              <div>
                wallet signature used to derive <span className="mono text-bone-500">x</span> <span className="redact w-16" />
              </div>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-bone-500">
            {signerCount === 1 ? "One signature: the relayer that paid the fee." : `${signerCount} signatures.`} Anyone can
            read this transaction on any explorer; it carries a zero-knowledge proof, not an identity.
          </p>
        </div>
      </div>
    </section>
  );
}

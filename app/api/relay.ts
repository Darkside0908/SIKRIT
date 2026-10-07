/// <reference types="node" />
/**
 * SIKRIT relayer service: pays the fee (and a new capsule's rent) for SIKRIT instructions, so neither the owner's
 * wallet nor a key held in the visitor's browser needs SOL. It is the "relayer" of the privacy story: the owner's
 * heartbeats reach the chain with this service as the only fee payer.
 *
 *   GET  /api/relay   → { relayer }                          the fee payer to build transactions with
 *   POST /api/relay   { transaction } (base64, co-signed)    → { signature } | { error, logs? }
 *   POST /api/relay   { transaction, sign: true } (unsigned) → { transaction } signed by the relayer only | { error, logs? }
 *
 * The second POST is for heirs and guardians co-signing in a real wallet (SIK-23). A wallet such as Phantom prepends
 * priority-fee (ComputeBudget) instructions to a transaction that carries no signature yet, which this relayer would
 * pay for and so refuses; one that is already signed it leaves as it is. So the app has the relayer sign first, the
 * wallet adds its signature to the frozen message, and the result comes back through the first POST.
 *
 * It signs only transactions made of exactly one SIKRIT instruction with exactly that instruction's accounts, and
 * appears in it only as the rent payer of `create_capsule`, so its signature can never move its SOL anywhere else nor
 * pay for more signatures than the instruction needs.
 *
 * Vercel deploys this file as a serverless function; `vite dev` and `vite preview` mount the same handler (see
 * vite.config.ts). Configuration (server-side only, never `VITE_`-prefixed):
 *   RELAYER_SECRET_KEY  the relayer keypair as a JSON byte array (`solana-keygen new -o relayer.json` output)
 *   RPC_URL             cluster RPC (default https://api.devnet.solana.com)
 *
 * Self-contained on purpose (only @solana/web3.js): a function under app/ cannot import ../sdk on Vercel.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F");

const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/**
 * The instructions the relayer pays for: how many accounts each takes, the slots (if any) where the relayer may appear,
 * and how many signatures its transaction may carry. The fee is 5 000 lamports per signature and the program ignores
 * extra accounts, so without the exact account count anyone could pad a heartbeat with throwaway signers and make the
 * relayer pay up to ten fees for it. `cosigned`: a heir's or guardian's wallet signs it too, so the relayer signs it
 * first on request (SIK-23).
 */
export const RELAYED = [
  { name: "create_capsule", accounts: 3, signatures: 2, relayerSlots: [1], cosigned: false }, // payer of the new capsule's rent
  { name: "heartbeat", accounts: 1, signatures: 1, relayerSlots: [], cosigned: false },
  { name: "update_capsule", accounts: 1, signatures: 1, relayerSlots: [], cosigned: false },
  { name: "trigger_claim", accounts: 1, signatures: 1, relayerSlots: [], cosigned: false },
  { name: "guardian_confirm", accounts: 2, signatures: 2, relayerSlots: [], cosigned: true },
  { name: "guardian_veto", accounts: 2, signatures: 2, relayerSlots: [], cosigned: true },
  { name: "claim", accounts: 2, signatures: 2, relayerSlots: [], cosigned: true },
].map((entry) => ({ ...entry, relayerSlots: entry.relayerSlots as number[], discriminator: discriminator(entry.name) }));

/** Why the relayer refuses to sign `tx`, or undefined when it may. */
export function refusal(tx: Transaction, relayer: PublicKey, programId = PROGRAM_ID): string | undefined {
  if (!tx.feePayer?.equals(relayer)) return "the relayer must be the fee payer";
  if (tx.instructions.length !== 1) return "exactly one instruction per transaction";
  const [ix] = tx.instructions;
  if (!ix.programId.equals(programId)) return "only SIKRIT instructions are relayed";
  const kind = RELAYED.find((entry) => ix.data.length >= 8 && entry.discriminator.equals(ix.data.subarray(0, 8)));
  if (!kind) return "unknown SIKRIT instruction";
  if (ix.keys.length !== kind.accounts) return `${kind.name} takes exactly ${kind.accounts} account${kind.accounts > 1 ? "s" : ""}`;
  if (tx.signatures.length > kind.signatures) return "too many signatures: each one is another fee";
  const slots = ix.keys.flatMap(({ pubkey }, slot) => (pubkey.equals(relayer) ? [slot] : []));
  if (slots.some((slot) => !kind.relayerSlots.includes(slot))) {
    return "the relayer signs only as fee payer and as a new capsule's rent payer";
  }
  return undefined;
}

/** The cluster calls the relayer needs (an RPC in production, LiteSVM in tests). */
export interface RelayChain {
  /** Broadcasts with preflight, so a transaction the program rejects costs no fee. */
  sendRawTransaction(raw: Uint8Array): Promise<string>;
  getBalance(address: string): Promise<number>;
  /** Runs a transaction whose co-signature is still missing (signatures unchecked); `err` is null when it succeeds. */
  simulate(raw: Uint8Array): Promise<{ err: unknown; logs?: string[] }>;
}

export interface RelayReply {
  status: number;
  body: { relayer?: string; signature?: string; transaction?: string; error?: string; logs?: string[] };
}

export interface RelayOptions {
  secretKey: Uint8Array;
  chain: RelayChain;
  programId?: PublicKey;
  /** Per client: relayed transactions per minute and new capsules per hour (rent is the relayer's main cost). */
  limits?: { perMinute: number; capsulesPerHour: number };
  /** Below this balance, refuse with a clear "out of test SOL" error instead of a failed send. */
  minimumLamports?: number;
}

const MINUTE = 60_000;

export function createRelay({ secretKey, chain, programId = PROGRAM_ID, limits, minimumLamports = 0.01 * LAMPORTS_PER_SOL }: RelayOptions) {
  const relayer = Keypair.fromSecretKey(secretKey);
  const history = new Map<string, { at: number; capsule: boolean }[]>();

  function limited(client: string, capsule: boolean): boolean {
    if (!limits) return false;
    const now = Date.now();
    if (history.size > 5000) {
      // Many distinct clients: forget those idle for an hour, so the map cannot grow without bound.
      for (const [key, entries] of history) {
        const last = entries[entries.length - 1];
        if (!last || now - last.at >= 60 * MINUTE) history.delete(key);
      }
    }
    const recent = (history.get(client) ?? []).filter((entry) => now - entry.at < 60 * MINUTE);
    history.set(client, recent);
    const lastMinute = recent.filter((entry) => now - entry.at < MINUTE).length;
    const capsules = recent.filter((entry) => entry.capsule).length;
    if (lastMinute >= limits.perMinute || (capsule && capsules >= limits.capsulesPerHour)) return true;
    recent.push({ at: now, capsule });
    return false;
  }

  /** Parses and vets a posted transaction (policy, rate limit, balance): the transaction, or the reply refusing it. */
  async function admit(base64: unknown, client: string, cosignedOnly: boolean): Promise<Transaction | RelayReply> {
    let tx: Transaction;
    try {
      if (typeof base64 !== "string" || base64.length > 2048) throw new Error();
      tx = Transaction.from(Buffer.from(base64, "base64"));
    } catch {
      return { status: 400, body: { error: "expected { transaction: <base64 legacy transaction> }" } };
    }
    const why = refusal(tx, relayer.publicKey, programId);
    if (why) return { status: 400, body: { error: `relayer: ${why}` } };
    const data = tx.instructions[0].data.subarray(0, 8);
    if (cosignedOnly && !RELAYED.some((entry) => entry.cosigned && entry.discriminator.equals(data))) {
      return { status: 400, body: { error: "relayer: it signs first only co-signed instructions (confirm, veto, claim)" } };
    }
    if (limited(client, data.equals(RELAYED[0].discriminator))) {
      return { status: 429, body: { error: "relayer: too many requests from this address, try again in a minute" } };
    }
    if ((await chain.getBalance(relayer.publicKey.toBase58())) < minimumLamports) {
      return { status: 503, body: { error: `relayer: out of test SOL, send devnet SOL to ${relayer.publicKey.toBase58()}` } };
    }
    return tx;
  }

  return {
    publicKey: relayer.publicKey,

    /**
     * Signs, without broadcasting, a transaction its co-signer has yet to sign (SIK-23). Whoever holds the result can
     * broadcast it without preflight, so it is signed only if the program accepts it now (simulated with the
     * co-signature missing): the message is then frozen, and at most its two 5 000-lamport signature fees are at stake.
     */
    async sign(base64: unknown, client = "local"): Promise<RelayReply> {
      const tx = await admit(base64, client, true);
      if (!(tx instanceof Transaction)) return tx;
      tx.partialSign(relayer);
      const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      let simulated: { err: unknown; logs?: string[] };
      try {
        simulated = await chain.simulate(raw);
      } catch (error) {
        return { status: 502, body: { error: `relayer: could not simulate (${(error as Error).message ?? error})` } };
      }
      if (simulated.err !== null && simulated.err !== undefined) {
        return { status: 422, body: { error: `Transaction simulation failed: ${JSON.stringify(simulated.err)}`, logs: simulated.logs } };
      }
      return { status: 200, body: { transaction: Buffer.from(raw).toString("base64") } };
    },

    async relay(base64: unknown, client = "local"): Promise<RelayReply> {
      const tx = await admit(base64, client, false);
      if (!(tx instanceof Transaction)) return tx;
      tx.partialSign(relayer);
      if (!tx.verifySignatures()) return { status: 400, body: { error: "relayer: a required signature is missing or invalid" } };
      try {
        return { status: 200, body: { signature: await chain.sendRawTransaction(tx.serialize()) } };
      } catch (error) {
        const { message, logs } = error as { message?: string; logs?: string[] };
        return { status: 422, body: { error: message ?? String(error), logs } };
      }
    },
  };
}

export type Relay = ReturnType<typeof createRelay>;

export function rpcChain(rpcUrl: string): RelayChain {
  const connection = new Connection(rpcUrl, "confirmed");
  return {
    sendRawTransaction: (raw) => connection.sendRawTransaction(raw, { preflightCommitment: "confirmed" }),
    getBalance: (address) => connection.getBalance(new PublicKey(address)),
    async simulate(raw) {
      const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), {
        sigVerify: false,
        commitment: "confirmed",
      });
      return { err: value.err, logs: value.logs ?? undefined };
    },
  };
}

type Request = IncomingMessage & { body?: unknown };

async function bodyOf(req: Request): Promise<{ transaction?: unknown; sign?: unknown } | undefined> {
  // Vercel hands over a parsed body (its getter throws on malformed JSON); a plain Node server (vite dev/preview)
  // hands over the stream.
  let body: unknown;
  try {
    body = req.body;
  } catch {
    return undefined;
  }
  if (body === undefined) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) return undefined;
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString("utf8");
  }
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString());
    } catch {
      return undefined;
    }
  }
  return (body as { transaction?: unknown; sign?: unknown } | null) ?? undefined;
}

const clientOf = (req: Request) =>
  String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";

/** Node `(req, res)` handler around a relay: Vercel's function signature and Connect middleware alike. */
export function relayHandler(relay: Relay | undefined) {
  return async (req: Request, res: ServerResponse): Promise<void> => {
    let reply: RelayReply;
    if (!relay) reply = { status: 503, body: { error: "relayer not configured (RELAYER_SECRET_KEY)" } };
    else if (req.method === "GET") reply = { status: 200, body: { relayer: relay.publicKey.toBase58() } };
    else if (req.method === "POST") {
      const body = await bodyOf(req);
      reply = await (body?.sign === true ? relay.sign : relay.relay)(body?.transaction, clientOf(req));
    }
    else reply = { status: 405, body: { error: "use GET or POST" } };
    res.statusCode = reply.status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(reply.body));
  };
}

export function relayFromEnv(env: Record<string, string | undefined> = process.env): Relay | undefined {
  if (!env.RELAYER_SECRET_KEY) return undefined;
  return createRelay({
    secretKey: Uint8Array.from(JSON.parse(env.RELAYER_SECRET_KEY)),
    chain: rpcChain(env.RPC_URL || "https://api.devnet.solana.com"),
    limits: { perMinute: 10, capsulesPerHour: 6 },
  });
}

let fromEnv: ReturnType<typeof relayHandler> | undefined;

/** The Vercel function. */
export default function handler(req: Request, res: ServerResponse): Promise<void> {
  if (!fromEnv) {
    let relay: Relay | undefined;
    try {
      relay = relayFromEnv();
    } catch {
      relay = undefined; // a malformed key reads as "not configured"; the app falls back to its browser relayer
    }
    fromEnv = relayHandler(relay);
  }
  return fromEnv(req, res);
}

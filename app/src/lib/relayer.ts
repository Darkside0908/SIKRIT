import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { useEffect, useState } from "react";

import { CLUSTER, RELAYER_URL } from "../config";
import { relayerKeypair } from "./actors";
import { Cosigner, FeePayer, SentTransaction, connection, ensureFunded, sendWithRelayer } from "./chain";

/** Who pays the fees. Either way it is the only account the owner's transactions have in common, and not the owner. */
export interface Relayer extends FeePayer {
  /** "service": the relayer server pays every fee. "browser": a demo key in this browser pays, topped up from the faucet. */
  kind: "service" | "browser";
  /** Makes sure a browser key can pay (asks the faucet if needed); the service funds itself. */
  ready(minimumSol: number): Promise<void>;
}

function browserRelayer(): Relayer {
  const keypair = relayerKeypair();
  return {
    kind: "browser",
    publicKey: keypair.publicKey,
    async ready(minimumSol) {
      await ensureFunded(keypair.publicKey, minimumSol, CLUSTER === "devnet" ? 1 : 5);
    },
    async signFirst(transaction) {
      transaction.partialSign(keypair);
      return transaction;
    },
    async submit(transaction) {
      transaction.partialSign(keypair);
      return connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "confirmed" });
    },
  };
}

function serviceRelayer(url: string, publicKey: PublicKey): Relayer {
  const post = async (transaction: Transaction, sign: boolean) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transaction: transaction.serialize({ requireAllSignatures: false }).toString("base64"),
        ...(sign ? { sign: true } : {}),
      }),
    });
    const reply: { signature?: string; transaction?: string; error?: string; logs?: string[] } = await response.json().catch(() => ({}));
    if (!response.ok || !(sign ? reply.transaction : reply.signature)) {
      // `logs` lets explainError name the program error behind a failed preflight.
      throw Object.assign(new Error(reply.error ?? `relayer: HTTP ${response.status}`), { logs: reply.logs });
    }
    return reply;
  };
  return {
    kind: "service",
    publicKey,
    async ready() {},
    async signFirst(transaction: Transaction) {
      const signed = Transaction.from(Uint8Array.from(atob((await post(transaction, true)).transaction!), (c) => c.charCodeAt(0)));
      // Only the relayer's signature may come back, on exactly the message that was sent.
      const sent = transaction.serializeMessage();
      if (!signed.serializeMessage().equals(sent) || !signed.feePayer?.equals(publicKey) || !signed.verifySignatures(false)) {
        throw new Error("relayer: the service returned a different transaction");
      }
      return signed;
    },
    async submit(transaction: Transaction) {
      return (await post(transaction, false)).signature!;
    },
  };
}

let discovered: Promise<Relayer> | undefined;

/** The relayer service when the host runs one, else the in-browser demo relayer. Decided once per page load. */
export function getRelayer(): Promise<Relayer> {
  return (discovered ??= discover());
}

async function discover(): Promise<Relayer> {
  const url = new URL(RELAYER_URL, document.baseURI).href;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const { relayer } = await response.json();
    return serviceRelayer(url, new PublicKey(relayer));
  } catch {
    return browserRelayer(); // a static host (GitHub Pages), or a service that is down or not configured
  }
}

/** Sends through the relayer (see `sendWithRelayer`), topping up a browser relayer first if it runs low. */
export async function sendRelayed(instructions: TransactionInstruction[], cosigner?: Cosigner): Promise<SentTransaction> {
  const relayer = await getRelayer();
  await relayer.ready(0.01);
  return sendWithRelayer(instructions, relayer, cosigner);
}

export function useRelayer(): Relayer | undefined {
  const [relayer, setRelayer] = useState<Relayer>();
  useEffect(() => {
    let live = true;
    void getRelayer().then((value) => live && setRelayer(value));
    return () => {
      live = false;
    };
  }, []);
  return relayer;
}

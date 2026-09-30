import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { RPC_URL } from "../config";

export const connection = new Connection(RPC_URL, { commitment: "confirmed" });

/** The cluster's own clock (Clock sysvar `unix_timestamp`), which is what the program checks. */
export async function readChainTime(): Promise<bigint> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!info) throw new Error("Clock sysvar unavailable");
  return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigInt64(32, true);
}

/** Anything that can add its signature to a transaction (persona keypair or wallet adapter). */
export interface Cosigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export interface SentTransaction {
  signature: string;
  /** Exactly what was broadcast — shown in the "what the chain sees" inspector. */
  transaction: Transaction;
}

/**
 * Broadcasts with the relayer as fee payer. Owner actions (create, heartbeat) need no other
 * signature at all; heir and guardian actions add theirs through `cosigner`, so nobody but the
 * relayer ever needs SOL.
 */
export async function sendWithRelayer(
  instructions: TransactionInstruction[],
  relayer: Keypair,
  cosigner?: Cosigner,
): Promise<SentTransaction> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  let transaction = new Transaction({ feePayer: relayer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
  if (cosigner) transaction = await cosigner.signTransaction(transaction);
  transaction.partialSign(relayer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "confirmed" });
  const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (value.err) throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);
  return { signature, transaction };
}

export async function balanceSol(address: PublicKey): Promise<number> {
  return (await connection.getBalance(address, "confirmed")) / LAMPORTS_PER_SOL;
}

/** Tops up a demo account from the cluster faucet (localnet: unlimited; devnet: rate-limited). */
export async function ensureFunded(address: PublicKey, minimumSol = 0.05, topUpSol = 1): Promise<number> {
  const balance = await balanceSol(address);
  if (balance >= minimumSol) return balance;
  const signature = await connection.requestAirdrop(address, Math.round(topUpSol * LAMPORTS_PER_SOL));
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return balanceSol(address);
}

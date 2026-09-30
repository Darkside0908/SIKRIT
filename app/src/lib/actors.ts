import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";

import type { Cosigner } from "./chain";

export type Role = "owner" | "heir" | "guardian";

/** Whoever the user is acting as: a demo persona (in-browser keypair) or a connected wallet. */
export interface Actor extends Cosigner {
  kind: "persona" | "wallet";
  id: string;
  name: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface Persona {
  id: string;
  name: string;
  role: Role;
  blurb: string;
  initials: string;
}

/** The demo family from the pitch: Pak Arif leaves his seed phrase to his daughter Sari. */
export const CAST: Persona[] = [
  { id: "arif", name: "Pak Arif", role: "owner", blurb: "Owner. Keeps the family savings in self-custody.", initials: "PA" },
  { id: "sari", name: "Sari", role: "heir", blurb: "Heir. His daughter.", initials: "SA" },
  { id: "budi", name: "Budi", role: "guardian", blurb: "Guardian. His younger brother.", initials: "BU" },
  { id: "dewi", name: "Dewi", role: "guardian", blurb: "Guardian. The family notary.", initials: "DE" },
  { id: "rizal", name: "Rizal", role: "guardian", blurb: "Guardian. Friend since university.", initials: "RI" },
];

const CAST_KEY = "sikrit:cast:v1";
const RELAYER_KEY = "sikrit:relayer:v1";

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function loadKeypair(storageKey: string, id: string): Keypair {
  const store: Record<string, string> = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
  if (store[id]) return Keypair.fromSecretKey(fromBase64(store[id]));
  const keypair = Keypair.generate();
  store[id] = toBase64(keypair.secretKey);
  localStorage.setItem(storageKey, JSON.stringify(store));
  return keypair;
}

/** Demo-only keys, stored in this browser's localStorage. Never use them for real funds. */
export function personaKeypair(id: string): Keypair {
  return loadKeypair(CAST_KEY, id);
}

/**
 * The fee payer for every transaction. It stands in for a public relayer service: it is the only
 * account the owner's heartbeats have in common, and it is not the owner.
 */
export function relayerKeypair(): Keypair {
  return loadKeypair(RELAYER_KEY, "relayer");
}

export function personaActor(persona: Persona): Actor {
  const keypair = personaKeypair(persona.id);
  return {
    kind: "persona",
    id: persona.id,
    name: persona.name,
    publicKey: keypair.publicKey,
    signMessage: async (message) => ed25519.sign(message, keypair.secretKey.slice(0, 32)),
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(keypair);
      return tx;
    },
  };
}

export function personaFor(address: PublicKey): Persona | undefined {
  return CAST.find((persona) => personaKeypair(persona.id).publicKey.equals(address));
}

/** Forget every demo key and message (fresh demo run). */
export function resetDemo(): void {
  for (const key of Object.keys(localStorage)) if (key.startsWith("sikrit:")) localStorage.removeItem(key);
}

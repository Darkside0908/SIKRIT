import type { CapsuleAccount } from "@sdk/client";
import * as kit from "@sdk/kit";
import type { KeyPair } from "@sdk/hpke";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";

import { Actor, personaFor } from "./actors";
import { short } from "./format";
import { postInvite } from "./mailbox";

/** The capsule as a kit consumer checks it (sdk/kit.ts `CapsuleState`). */
export const chainState = (capsule: CapsuleAccount): kit.CapsuleState => ({
  commitment: capsule.commitment,
  heir: capsule.heir.toBytes(),
  guardians: capsule.guardians.map((g) => g.toBytes()),
  shareHashes: capsule.shareHashes,
  claimed: capsule.status === "claimed",
});

/** "Sari (7xK…p2)" for demo personas, the short address otherwise. */
export function who(address: PublicKey | Uint8Array): string {
  const key = address instanceof PublicKey ? address : new PublicKey(address);
  const persona = personaFor(key);
  return persona ? persona.name : short(key);
}

interface Inbox {
  keyPair: KeyPair;
  certificate: kit.InboxCertificate;
  invite: string;
}

const inboxCache = new Map<string, Inbox>();

/**
 * The holder's inbox key, derived from their wallet (sign twice + certificate). Kept in memory
 * only; demo personas derive it silently, real wallets on request. Creating it also drops the
 * invite into the demo mailbox so the owner (in this browser) can pick it up.
 */
export function useInbox(actor: Actor | undefined) {
  const id = actor ? `${actor.kind}:${actor.publicKey.toBase58()}` : undefined;
  const [inbox, setInbox] = useState<Inbox | undefined>(id ? inboxCache.get(id) : undefined);

  useEffect(() => setInbox(id ? inboxCache.get(id) : undefined), [id]);

  const create = useCallback(async () => {
    if (!actor || !id) throw new Error("Choose who you are acting as first");
    const { keyPair, certificate } = await kit.createInbox(actor.publicKey.toBytes(), actor.signMessage);
    const created = { keyPair, certificate, invite: kit.encodeInboxCertificate(certificate) };
    inboxCache.set(id, created);
    postInvite(actor.publicKey.toBase58(), created.invite);
    setInbox(created);
    return created;
  }, [actor, id]);

  // Personas sign locally without prompts, so their inbox is ready immediately.
  useEffect(() => {
    if (actor?.kind === "persona" && id && !inboxCache.has(id)) void create();
  }, [actor, id, create]);

  return { inbox, create };
}

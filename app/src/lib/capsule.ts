import { CapsuleAccount, PROGRAM_ID, fetchCapsule } from "@sdk/client";
import * as kit from "@sdk/kit";
import type { KeyPair } from "@sdk/hpke";
import { capsulePda } from "@sdk/liveness";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Actor, personaFor } from "./actors";
import { connection } from "./chain";
import { short } from "./format";
import { postInvite, postKit, useMailbox } from "./mailbox";

/** The capsule as a kit consumer checks it (sdk/kit.ts `CapsuleState`). */
export const chainState = (capsule: CapsuleAccount): kit.CapsuleState => ({
  commitment: capsule.commitment,
  heirCommitment: capsule.heirCommitment,
  guardianCommitments: capsule.guardianCommitments,
  shareHashes: capsule.shareHashes,
  claimed: capsule.status === "claimed",
  heir: capsule.heir?.toBytes() ?? null,
});

/** Where a kit's capsule lives: its address derives from the liveness commitment P inside the kit. */
export const kitAddress = (parsed: kit.CapsuleKit): PublicKey => capsulePda(PROGRAM_ID, parsed.commitment)[0];

/** The kit in this browser's mailbox for `address`, parsed; undefined if there is none (or it is malformed). */
export function useMailboxKit(address: PublicKey | undefined): kit.CapsuleKit | undefined {
  const mailbox = useMailbox();
  const text = address ? mailbox.kits[address.toBase58()] : undefined;
  return useMemo(() => {
    try {
      return text ? kit.decodeKit(text) : undefined;
    } catch {
      return undefined;
    }
  }, [text]);
}

/**
 * The capsules `actor` holds a share of as `role`, from the kits in this browser's mailbox. The chain stores only
 * salted commitments to heirs and guardians, so members find their capsules through the kit the owner sent them,
 * never by searching the chain for their wallet.
 */
export function useMemberCapsules(actor: Actor | undefined, role: kit.Membership["role"]) {
  const mailbox = useMailbox();
  const wallet = actor?.publicKey.toBase58();
  return useMemo(() => {
    if (!wallet) return undefined;
    const found: { address: PublicKey; member: kit.Membership }[] = [];
    for (const [address, text] of Object.entries(mailbox.kits)) {
      try {
        const member = kit.membership(kit.decodeKit(text), new PublicKey(wallet).toBytes());
        if (member?.role === role) found.push({ address: new PublicKey(address), member });
      } catch {
        /* a malformed or older kit names nobody */
      }
    }
    return found;
  }, [mailbox.kits, wallet, role]);
}

/**
 * A kit file a holder received outside this browser: accepted only if it holds a share for `wallet` and matches
 * its capsule on-chain, then filed in the mailbox under that capsule.
 */
export async function importMemberKit(text: string, wallet: PublicKey): Promise<PublicKey> {
  const parsed = kit.decodeKit(text);
  if (!kit.membership(parsed, wallet.toBytes())) throw new Error(`This kit holds no share for ${short(wallet)}`);
  const address = kitAddress(parsed);
  const capsule = await fetchCapsule(connection, address);
  if (!capsule) throw new Error(`The kit's capsule ${short(address)} does not exist on this cluster`);
  kit.verifyKit(parsed, chainState(capsule));
  postKit(address.toBase58(), text);
  return address;
}

/**
 * The capsule's kit — from this browser's mailbox or an imported file — checked against the
 * chain. Only a kit that verifies is kept in the mailbox, so a wrong file cannot shadow a good one.
 */
export function useVerifiedKit(address: PublicKey, capsule: CapsuleAccount) {
  const mailbox = useMailbox();
  const [imported, setImported] = useState<string>();
  const addressText = address.toBase58();
  const kitText = imported ?? mailbox.kits[addressText];

  const checked = useMemo((): { kit?: kit.CapsuleKit; error?: string } => {
    if (!kitText) return {};
    try {
      const parsed = kit.decodeKit(kitText);
      kit.verifyKit(parsed, chainState(capsule));
      return { kit: parsed };
    } catch (e) {
      return { error: (e as Error).message.replace(/^kit: /, "") };
    }
  }, [kitText, capsule]);

  const importKit = useCallback(
    (text: string) => {
      setImported(text);
      try {
        kit.verifyKit(kit.decodeKit(text), chainState(capsule));
        postKit(addressText, text);
      } catch {
        /* surfaced through `checked.error` */
      }
    },
    [addressText, capsule],
  );

  return { kitText, checked, importKit };
}

/** "Sari" for demo personas, the short address otherwise. */
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

import type { Actor } from "../lib/actors";
import { hex, short } from "../lib/format";
import { ActionButton, Copyable, Notice } from "./ui";

/** A holder's inbox: the encryption key their wallet vouches for, shared as a signed invite. */
export function InboxCard({
  actor,
  inbox,
  busy,
  onCreate,
  audience,
}: {
  actor?: Actor;
  inbox?: { invite: string; keyPair: { publicKey: Uint8Array } };
  busy?: string;
  onCreate: () => void;
  audience: string;
}) {
  return (
    <section className="card space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div className="eyebrow">Your inbox key</div>
        {inbox && <span className="chip border-verdigris-500/60 text-verdigris-300">ready</span>}
      </div>
      {!inbox ? (
        <>
          <p className="text-sm leading-relaxed text-bone-300">
            Your wallet signs two short messages: one derives a private X25519 key that only you can re-create, one
            certifies it. Nothing is sent on-chain.
          </p>
          <ActionButton className="btn-ghost" busy={busy} busyLabel="Creating" label="Create my inbox" onClick={onCreate} disabled={!actor} />
        </>
      ) : (
        <>
          <div className="space-y-1">
            <div className="text-xs text-bone-500">Public inbox key</div>
            <div className="mono break-all text-bone-300">{hex(inbox.keyPair.publicKey)}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-bone-500">Invite for {audience} — signed by {actor ? short(actor.publicKey) : "you"}</div>
            <Copyable text={inbox.invite} display={`${inbox.invite.slice(0, 34)}…`} />
          </div>
          <Notice tone="info">Dropped in this browser's demo mailbox. With real wallets, send the invite by any channel — it is useless to anyone else.</Notice>
        </>
      )}
    </section>
  );
}

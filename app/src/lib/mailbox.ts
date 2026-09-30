import { useSyncExternalStore } from "react";

/**
 * Off-chain delivery for the demo: invites, capsule kits and guardian releases are "sent" through
 * this browser's localStorage so all personas can play their part in one tab. With real wallets,
 * the same strings are copied, downloaded or pasted instead; nothing here is ever sent to a server.
 */
interface Mailbox {
  invites: Record<string, string>;
  kits: Record<string, string>;
  releases: Record<string, string[]>;
}

const KEY = "sikrit:mailbox:v1";
const EVENT = "sikrit:mailbox";
const empty = (): Mailbox => ({ invites: {}, kits: {}, releases: {} });

let cachedRaw: string | null = null;
let cached: Mailbox = empty();

function read(): Mailbox {
  const raw = localStorage.getItem(KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  }
  return cached;
}

function write(update: (box: Mailbox) => void): void {
  const box = structuredClone(read());
  update(box);
  localStorage.setItem(KEY, JSON.stringify(box));
  window.dispatchEvent(new Event(EVENT));
}

const subscribe = (onChange: () => void) => {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
};

export const useMailbox = (): Mailbox => useSyncExternalStore(subscribe, read);

export const postInvite = (wallet: string, invite: string) => write((box) => void (box.invites[wallet] = invite));

export const postKit = (capsule: string, kit: string) => write((box) => void (box.kits[capsule] = kit));

export const postRelease = (capsule: string, release: string) =>
  write((box) => {
    const list = box.releases[capsule] ?? [];
    if (!list.includes(release)) box.releases[capsule] = [...list, release];
  });

// Release tokens: "sikrit-release:v1:<capsule>:<hex sealed box>".
const RELEASE_PREFIX = "sikrit-release:v1:";

export const encodeRelease = (capsule: string, sealedHex: string): string => `${RELEASE_PREFIX}${capsule}:${sealedHex}`;

export function decodeRelease(token: string): { capsule: string; sealedHex: string } {
  const text = token.trim();
  if (!text.startsWith(RELEASE_PREFIX)) throw new Error("Not a SIKRIT release token");
  const [capsule, sealedHex] = text.slice(RELEASE_PREFIX.length).split(":");
  if (!capsule || !/^([0-9a-f]{2})+$/.test(sealedHex ?? "")) throw new Error("Malformed release token");
  return { capsule, sealedHex };
}

export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

import type { PublicKey } from "@solana/web3.js";

export const short = (value: PublicKey | string, head = 4, tail = 4): string => {
  const text = typeof value === "string" ? value : value.toBase58();
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
};

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** 93 → "1m 33s", 90061 → "1d 1h", used for intervals and countdowns. */
export function duration(totalSeconds: number | bigint): string {
  let s = Math.max(0, Math.floor(Number(totalSeconds)));
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Big countdown clock: "02:07:59" or "00:45". */
export function clock(totalSeconds: number | bigint): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds)));
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (days) return `${days}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const when = (unix: bigint): string =>
  unix === 0n ? "—" : new Date(Number(unix) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

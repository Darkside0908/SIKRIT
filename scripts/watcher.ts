/**
 * SIKRIT watcher: warns the owner (or a guardian) about their capsules without telling the RPC which ones.
 *
 *   npm run watcher -- <capsule address>… [--rpc URL] [--every SECONDS] [--remind SECONDS] [--notify URL] [--once]
 *
 *   --rpc     RPC endpoint (default https://api.devnet.solana.com; a local validator is http://127.0.0.1:8899)
 *   --every   seconds between scans (default 300; grace periods are days, so minutes are plenty)
 *   --remind  how long before a heartbeat is due to remind (default 86400, one day)
 *   --notify  POST each alert as plain text to this URL: an ntfy topic (https://ntfy.sh/<hard-to-guess-topic>) or any
 *             webhook. The text names a capsule only by its position in your list, never by its address.
 *   --once    scan once, print every capsule's state and exit (for cron)
 *
 * Every scan downloads all SIKRIT capsules (one getProgramAccounts) and picks yours on this machine, so the RPC learns
 * that this IP runs a SIKRIT watcher, not which capsule it cares about. Alerts fire once per liveness epoch or claim.
 * A push service still sees *when* an alert fires; self-host it if that matters.
 */
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

import { PROGRAM_ID } from "../sdk/client";
import { checkCapsule, duration, scanCapsules } from "../sdk/watch";

export interface WatcherArgs {
  capsules: PublicKey[];
  rpc: string;
  every: number;
  remind: bigint;
  notify?: string;
  once: boolean;
}

export function parseArgs(argv: string[]): WatcherArgs {
  const args: WatcherArgs = { capsules: [], rpc: "https://api.devnet.solana.com", every: 300, remind: 86_400n, once: false };
  const value = (i: number, flag: string) => {
    if (i >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rpc") args.rpc = value(++i, arg);
    else if (arg === "--every") args.every = positive(value(++i, arg), arg);
    else if (arg === "--remind") args.remind = BigInt(positive(value(++i, arg), arg));
    else if (arg === "--notify") args.notify = new URL(value(++i, arg)).toString();
    else if (arg === "--once") args.once = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else args.capsules.push(new PublicKey(arg));
  }
  if (!args.capsules.length) throw new Error("name at least one capsule address");
  return args;
}

function positive(text: string, flag: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive whole number of seconds`);
  return n;
}

/** The cluster's clock, which the program's timers follow; this machine's clock if the RPC does not answer. */
async function chainTime(connection: Connection): Promise<bigint> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY).catch(() => null);
  return clock ? clock.data.readBigInt64LE(32) : BigInt(Math.floor(Date.now() / 1000));
}

const short = (key: PublicKey) => `${key.toBase58().slice(0, 6)}…${key.toBase58().slice(-4)}`;
const stamp = () => `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;

async function push(url: string, text: string, urgent: boolean): Promise<void> {
  // ntfy reads Title and Priority; other webhooks ignore them.
  const response = await fetch(url, {
    method: "POST",
    body: text,
    headers: { "content-type": "text/plain; charset=utf-8", title: "SIKRIT", priority: urgent ? "high" : "default" },
    signal: AbortSignal.timeout(10_000), // a stuck push server must not hold up the next scan
  });
  if (!response.ok) throw new Error(`push answered HTTP ${response.status}`);
}

const USAGE =
  "usage: npm run watcher -- <capsule address>… [--rpc URL] [--every SECONDS] [--remind SECONDS] [--notify URL] [--once]";

async function main(): Promise<void> {
  let args: WatcherArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`watcher: ${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  const connection = new Connection(args.rpc, "confirmed");
  const fired = new Set<string>();
  console.log(
    `Watching ${args.capsules.length} capsule(s) through ${args.rpc}. Each scan reads every SIKRIT capsule, so the RPC` +
      ` cannot tell which are yours.${args.once ? "" : ` Scanning every ${duration(BigInt(args.every))}.`}`,
  );

  const scan = async () => {
    const [capsules, now] = await Promise.all([scanCapsules(connection, PROGRAM_ID), chainTime(connection)]);
    if (args.once) console.log(`${stamp()} scanned ${capsules.size} capsules`);
    for (const [i, address] of args.capsules.entries()) {
      const capsule = capsules.get(address.toBase58());
      const alerts = checkCapsule(capsule, now, { remindBefore: args.remind });
      if (args.once && !alerts.length && capsule) {
        console.log(`  #${i + 1} ${short(address)} ${capsule.status}: next heartbeat due in ${duration(capsule.lastHeartbeat + capsule.heartbeatInterval - now)}`);
      }
      for (const alert of alerts) {
        const key = `${address.toBase58()}:${alert.key}`;
        if (fired.has(key)) continue;
        fired.add(key);
        console.log(`${args.once ? " " : stamp()} #${i + 1} ${short(address)} ${alert.urgent ? "URGENT " : ""}${alert.kind}: ${alert.text}`);
        if (args.notify) {
          await push(args.notify, `Capsule #${i + 1}: ${alert.text}`, alert.urgent).catch((error) =>
            console.error(`  could not push the alert: ${(error as Error).message}`),
          );
        }
      }
    }
  };

  if (args.once) {
    return scan().catch((error) => {
      throw new Error(`could not scan through ${args.rpc}: ${(error as Error).message}`);
    });
  }
  for (;;) {
    await scan().catch((error) => console.error(`${stamp()} scan failed, retrying next time: ${(error as Error).message}`));
    await new Promise((resolve) => setTimeout(resolve, args.every * 1000));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`watcher: ${(error as Error).message}`);
    process.exit(1);
  });
}

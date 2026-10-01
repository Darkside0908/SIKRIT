/**
 * The demo story against the program deployed on devnet, through the production bundle:
 *
 *   npm run e2e:devnet                     fees paid by the relayer service (api/relay.ts, as on Vercel)
 *   RELAYER=browser npm run e2e:devnet     fees paid by the in-browser relayer (the GitHub Pages fallback)
 *
 * Builds the app (devnet, strict CSP), serves it with `vite preview` and runs e2e/demo-flow.mjs against it. Either
 * relayer gets a fresh key funded with 0.1 SOL from FUND_RELAYER_FROM (devnet's public faucet refuses the app), and
 * what the run does not spend is swept back: a run costs ~0.004 SOL, the capsule's rent plus fees.
 *
 *   RPC_URL            devnet endpoint (default https://api.devnet.solana.com)
 *   FUND_RELAYER_FROM  keypair file paying for the run (default ~/.config/solana/id.json)
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const APP = fileURLToPath(new URL("../", import.meta.url));
const PROGRAM_ID = new PublicKey("FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const FUNDER = process.env.FUND_RELAYER_FROM ?? `${homedir()}/.config/solana/id.json`;
const BROWSER = process.env.RELAYER === "browser";
const APP_URL = "http://localhost:4173";
// Vite's own entry point rather than `npx`, so stopping the preview server stops the server itself.
const VITE = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

const connection = new Connection(RPC, "confirmed");
if ((await connection.getAccountInfo(PROGRAM_ID))?.executable !== true) {
  console.error(`✕ program ${PROGRAM_ID.toBase58()} is not deployed on ${RPC}`);
  process.exit(1);
}

const serving = () => fetch(APP_URL).then((response) => response.ok, () => false);
if (await serving()) {
  console.error(`✕ ${APP_URL} is already in use: stop the other \`vite preview\` first`);
  process.exit(1);
}

console.log("▸ building the production bundle for devnet");
const bundleEnv = { ...process.env, VITE_CLUSTER: "devnet", ...(process.env.RPC_URL ? { VITE_RPC_URL: RPC } : {}) };
execFileSync(process.execPath, [VITE, "build", "--logLevel", "warn"], { cwd: APP, env: bundleEnv, stdio: "inherit" });

const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FUNDER, "utf8"))));
const relayer = Keypair.generate();
await transfer(funder, relayer.publicKey, 0.1 * LAMPORTS_PER_SOL);
console.log(`▸ ${BROWSER ? "in-browser relayer" : "relayer service"} ${relayer.publicKey.toBase58()} funded with 0.1 SOL`);

const preview = spawn(process.execPath, [VITE, "preview", "--port", "4173", "--strictPort"], {
  cwd: APP,
  stdio: "ignore",
  env: {
    ...bundleEnv,
    RPC_URL: RPC,
    ...(BROWSER ? { RELAYER: "browser" } : { RELAYER_SECRET_KEY: JSON.stringify(Array.from(relayer.secretKey)) }),
  },
});
const deadline = Date.now() + 30_000;
while (!(await serving())) {
  if (Date.now() > deadline) {
    preview.kill();
    throw new Error("vite preview did not come up within 30s");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.log(`▸ demo flow on devnet → ${APP_URL} (program ${PROGRAM_ID.toBase58()})\n`);
const flow = spawn(process.execPath, ["e2e/demo-flow.mjs"], {
  cwd: APP,
  stdio: "inherit",
  env: {
    ...process.env,
    BASE_URL: APP_URL,
    RPC_URL: RPC,
    ...(BROWSER ? { BROWSER_RELAYER_KEY: Buffer.from(relayer.secretKey).toString("base64") } : {}),
  },
});
flow.on("exit", async (code) => {
  preview.kill();
  // What the run did not spend goes back to the funder, closing the relayer account.
  const left = (await connection.getBalance(relayer.publicKey)) - 5000; // minus this transfer's own fee
  if (left > 0) await transfer(relayer, funder.publicKey, left).catch((error) => console.error(`sweep failed: ${error.message}`));
  process.exit(code ?? 1);
});

function transfer(from, to, lamports) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  return sendAndConfirmTransaction(connection, tx, [from]);
}

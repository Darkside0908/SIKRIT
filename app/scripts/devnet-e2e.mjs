/**
 * The demo story against the program deployed on devnet, through the production bundle:
 *
 *   npm run e2e:devnet
 *
 * Builds the app (devnet, strict CSP), serves it with `vite preview` and runs e2e/demo-flow.mjs
 * against it. The public devnet faucet rate-limits the app's own relayer top-up, so the run's
 * relayer is pre-funded with 0.1 SOL from FUND_RELAYER_FROM and what it does not spend is swept
 * back (a run costs ~0.003 SOL: the capsule's rent plus fees).
 *
 *   RPC_URL            devnet endpoint (default https://api.devnet.solana.com)
 *   FUND_RELAYER_FROM  keypair file paying for the run (default ~/.config/solana/id.json)
 */
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const PROGRAM_ID = "FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F";
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const FUNDER = process.env.FUND_RELAYER_FROM ?? `${homedir()}/.config/solana/id.json`;
const APP_URL = "http://localhost:4173";
// Vite's own entry point rather than `npx`, so stopping the preview server stops the server itself.
const VITE = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

const account = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [PROGRAM_ID, { encoding: "base64" }] }),
}).then((response) => response.json());
if (account.result?.value?.executable !== true) {
  console.error(`✕ program ${PROGRAM_ID} is not deployed on ${RPC}`);
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

const preview = spawn(process.execPath, [VITE, "preview", "--port", "4173", "--strictPort"], { cwd: APP, stdio: "ignore" });
const deadline = Date.now() + 30_000;
while (!(await serving())) {
  if (Date.now() > deadline) {
    preview.kill();
    throw new Error("vite preview did not come up within 30s");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.log(`▸ demo flow on devnet → ${APP_URL} (program ${PROGRAM_ID})\n`);
const flow = spawn(process.execPath, ["e2e/demo-flow.mjs"], {
  cwd: APP,
  stdio: "inherit",
  env: { ...process.env, BASE_URL: APP_URL, RPC_URL: RPC, FUND_RELAYER_FROM: FUNDER },
});
flow.on("exit", (code) => {
  preview.kill();
  process.exit(code ?? 1);
});

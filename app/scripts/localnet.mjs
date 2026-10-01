/**
 * One-command local demo: a solana-test-validator with the SIKRIT program preloaded at its real
 * program ID, plus the Vite dev server. Ctrl+C stops both.
 *
 *   npm run localnet         validator + app on http://localhost:5173
 *   npm run e2e              same, then drives the whole demo story in Chrome (e2e/demo-flow.mjs)
 *
 * A validator or dev server that is already running is reused instead of started.
 * Build the program first (`npm run build` in the repo root).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP = fileURLToPath(new URL("../", import.meta.url));
const PROGRAM_ID = "FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F";
const PROGRAM_SO = `${ROOT}target/deploy/sikrit.so`;
const RPC = "http://127.0.0.1:8899";
const APP_URL = "http://localhost:5173";
const e2e = process.argv.includes("--e2e");

const env = { ...process.env, PATH: `${homedir()}/.local/share/solana/install/active_release/bin:${process.env.PATH}` };
const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: APP, env, stdio: "inherit", ...options });
  children.push(child);
  return child;
}

function stop(code = 0) {
  for (const child of children) child.kill("SIGINT");
  process.exit(code);
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

async function up(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`${what} did not come up within ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const rpc = (method, params = []) =>
  fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((response) => response.json());

const programDeployed = async () => (await rpc("getAccountInfo", [PROGRAM_ID, { encoding: "base64" }])).result?.value?.executable === true;
const appServing = async () => (await fetch(APP_URL)).ok;

try {
  if (await programDeployed().catch(() => false)) {
    console.log(`▸ reusing the validator at ${RPC}`);
  } else {
    if (!existsSync(PROGRAM_SO)) throw new Error(`${PROGRAM_SO} is missing: run \`npm run build\` in the repo root first`);
    console.log("▸ starting solana-test-validator with the SIKRIT program");
    run("solana-test-validator", ["--reset", "--quiet", "--ledger", `${ROOT}test-ledger`, "--bpf-program", PROGRAM_ID, PROGRAM_SO]);
    await up(programDeployed, "solana-test-validator");
  }

  if (await appServing().catch(() => false)) {
    console.log(`▸ reusing the app at ${APP_URL}`);
  } else {
    console.log("▸ starting the app");
    run("npx", ["vite", "--port", "5173", "--strictPort"], { env: { ...env, VITE_CLUSTER: "localnet" } });
    await up(appServing, "vite");
  }
  console.log(`\n  SIKRIT demo ready → ${APP_URL}  (cluster ${RPC}, program ${PROGRAM_ID})\n`);

  if (e2e) {
    const flow = run("node", ["e2e/demo-flow.mjs"], { env: { ...env, BASE_URL: APP_URL, RPC_URL: RPC } });
    flow.on("exit", (code) => stop(code ?? 1));
  }
} catch (error) {
  console.error(`✕ ${error.message}`);
  stop(1);
}

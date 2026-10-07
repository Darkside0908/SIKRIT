/**
 * The inheritance with real wallets instead of the demo cast: owner, heir and guardian each connect through the wallet
 * adapter, derive their keys by signing messages, and co-sign their own on-chain actions.
 *
 * The wallet is a Wallet Standard wallet injected into the page, the way Phantom, Solflare and Backpack announce
 * themselves; its three accounts' keys stay in this script. It follows Phantom's documented signing rule: a transaction that carries no signature yet and no compute-budget
 * instruction gets priority-fee instructions added before it is signed
 * (https://docs.phantom.com/developer-powertools/solana-priority-fees, "applies to all Phantom provider methods").
 * The relayer pays for exactly one SIKRIT instruction, so heir and guardian actions must reach the wallet already
 * signed by the relayer (SIK-23).
 *
 *   BASE_URL     app under test        (default http://localhost:5173)
 *   RPC_URL      cluster it talks to   (default http://127.0.0.1:8899)
 *   CHROME_PATH  Chrome/Chromium binary (default /usr/bin/google-chrome)
 *   HEADED=1     watch it run
 *
 * Picks capsule timers of 60 s, so a run takes ~3 min.
 */
import { mkdirSync } from "node:fs";

import { ed25519 } from "@noble/curves/ed25519";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const OUT = new URL("./out/", import.meta.url).pathname;
const PROGRAM_ID = new PublicKey("FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F");
const SAMPLE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const MINUTE = 60_000;

// --- The wallet's side, in Node: three accounts and Phantom's signing rule ---------------------------------------

const accounts = { owner: Keypair.generate(), heir: Keypair.generate(), guardian: Keypair.generate() };
let current = "heir";
/** Every transaction the wallet was asked to sign. */
const signed = [];

function signTransaction(bytes) {
  const tx = Transaction.from(Buffer.from(bytes));
  const presigned = tx.signatures.some(({ signature }) => signature !== null);
  const budgeted = tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  const augmented = !presigned && !budgeted;
  if (augmented) {
    tx.instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...tx.instructions,
    ];
  }
  tx.partialSign(accounts[current]);
  signed.push({ account: current, presigned, augmented });
  return Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

// --- The wallet's side, in the page: Wallet Standard registration (as @wallet-standard/wallet does it) -----------

function injectWallet() {
  const chains = ["solana:localnet", "solana:devnet"];
  const features = ["solana:signTransaction", "solana:signMessage"];
  let connected = [];
  const account = async () => {
    const { address, publicKey } = await window.__testWalletAccount();
    return { address, publicKey: new Uint8Array(publicKey), chains, features, label: "Test Wallet" };
  };
  const wallet = {
    version: "1.0.0",
    name: "Test Wallet",
    icon: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#ab9ff2"/></svg>')}`,
    chains,
    get accounts() {
      return connected;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ((connected = [await account()]), { accounts: connected }),
      },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => void (connected = []) },
      // Required by the adapter; this wallet never changes accounts on its own.
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signTransaction: (...inputs) =>
          Promise.all(
            inputs.map(async ({ transaction }) => ({
              signedTransaction: new Uint8Array(await window.__testWalletSignTransaction(Array.from(transaction))),
            })),
          ),
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: (...inputs) =>
          Promise.all(
            inputs.map(async ({ message }) => ({
              signedMessage: message,
              signature: new Uint8Array(await window.__testWalletSignMessage(Array.from(message))),
            })),
          ),
      },
    },
  };
  const register = ({ register }) => register(wallet);
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  window.addEventListener("wallet-standard:app-ready", ({ detail }) => register(detail));
}

// --- The run -------------------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.exposeFunction("__testWalletAccount", () => ({
  address: accounts[current].publicKey.toBase58(),
  publicKey: Array.from(accounts[current].publicKey.toBytes()),
}));
await context.exposeFunction("__testWalletSignMessage", (message) =>
  Array.from(ed25519.sign(Uint8Array.from(message), accounts[current].secretKey.slice(0, 32))),
);
await context.exposeFunction("__testWalletSignTransaction", signTransaction);
await context.addInitScript(injectWallet);
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/\b429\b/.test(m.text())) problems.push(`console.error: ${m.text()}`);
});

const started = Date.now();
async function step(name, run) {
  const t0 = Date.now();
  process.stdout.write(`• ${name} … `);
  await run();
  console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
const short = (key) => `${key.toBase58().slice(0, 4)}…${key.toBase58().slice(-4)}`;
const button = (name) => page.getByRole("button", { name });
const text = (value) => page.getByText(value).first();
const nav = (label) => page.locator("header nav a", { hasText: new RegExp(`^${label}$`) }).first().click();

async function enabled(locator, timeout) {
  const deadline = Date.now() + timeout;
  await locator.waitFor({ timeout });
  while (!(await locator.isEnabled())) {
    if (Date.now() > deadline) throw new Error(`still disabled after ${timeout / 1000}s`);
    await page.waitForTimeout(500);
  }
  return locator;
}

/** Waits for `success`, failing at once with the app's own message if an error notice shows up instead. */
async function outcome(success, timeout = MINUTE) {
  const alert = page.getByRole("alert").first();
  const done = success.waitFor({ timeout }).then(() => "done");
  // A little longer, so a run that times out reports the success it waited for.
  const failed = alert.waitFor({ timeout: timeout + 1000 }).then(() => "failed");
  done.catch(() => {});
  failed.catch(() => {});
  if ((await Promise.race([done, failed])) === "failed") throw new Error(`the app reported: ${(await alert.innerText()).trim()}`);
}

/** Connects the wallet's account `name` from the header menu. */
async function connect(name) {
  current = name;
  await button("Connect wallet").click();
  await button("Test Wallet").click();
  await text(`Test Wallet · ${short(accounts[name].publicKey)}`).waitFor();
}

/**
 * Disconnects and connects another account. (Switching accounts inside the wallet would not reach a dev build: in
 * React's StrictMode the wallet adapter drops its listener for wallet events. Production builds follow such switches.)
 */
async function switchTo(name) {
  await page.getByRole("banner").getByRole("button", { name: /^Test Wallet · / }).click();
  await button("Disconnect").click();
  await connect(name);
}

/** "My wallet" for this page's role, then the inbox key that wallet derives (three message signatures). */
async function inboxFor(name) {
  await button(/^My wallet/).click();
  await button("Create my inbox").click();
  await outcome(page.getByText("ready", { exact: true }));
  const mailbox = await page.evaluate(() => JSON.parse(localStorage.getItem("sikrit:mailbox:v1") ?? "{}"));
  const invite = mailbox.invites?.[accounts[name].publicKey.toBase58()];
  if (!invite) throw new Error(`no invite from the ${name}'s wallet in the mailbox`);
  return invite;
}

let capsule;
const invites = {};

try {
  await step("heir connects a wallet and creates an inbox (message signatures only)", async () => {
    await page.goto(`${BASE}/#/heir`);
    await connect("heir");
    invites.heir = await inboxFor("heir");
  });

  await step("guardian switches account in the wallet and creates an inbox", async () => {
    await switchTo("guardian");
    await nav("Guardian");
    invites.guardian = await inboxFor("guardian");
  });

  await step("owner derives the liveness key from the wallet and seals the capsule", async () => {
    await switchTo("owner");
    await nav("Owner");
    await button(/^My wallet/).click();
    await button("Derive my liveness key").click();
    const fields = page.getByPlaceholder("sikrit-invite:v1:…");
    await fields.first().waitFor();
    await fields.nth(0).fill(invites.heir);
    await fields.nth(1).fill(invites.guardian);
    await text(`✓ signed by ${short(accounts.heir.publicKey)}`).waitFor();
    await text(`✓ signed by ${short(accounts.guardian.publicKey)}`).waitFor();
    await button("Use a sample seed phrase").click();
    await page.getByLabel("Heartbeat every").selectOption("60");
    await page.getByLabel("Grace period").selectOption("60");
    await button("Seal the capsule").click();
    await outcome(button("Send ZK heartbeat"));
    const mailbox = await page.evaluate(() => JSON.parse(localStorage.getItem("sikrit:mailbox:v1") ?? "{}"));
    capsule = new PublicKey(Object.keys(mailbox.kits)[0]);
    await button("Send ZK heartbeat").click();
    await outcome(text("R = k·G"));
    if (signed.length) throw new Error("the owner's wallet was asked to sign a transaction");
  });

  await step("owner falls silent; the heir opens the claim", async () => {
    await switchTo("heir");
    await nav("Heir");
    await (await enabled(button("Open the claim"), 2 * MINUTE)).click();
    await outcome(button("Claim the capsule"));
  });

  await step("guardian confirms, co-signing in the wallet", async () => {
    await switchTo("guardian");
    await nav("Guardian");
    await (await enabled(button("Confirm the claim"), MINUTE)).click();
    await outcome(button("Confirmed"));
  });

  await step("heir claims once the grace period ends, co-signing in the wallet", async () => {
    await switchTo("heir");
    await nav("Heir");
    await (await enabled(button("Claim the capsule"), 2 * MINUTE)).click();
    await outcome(text("Sealed no more."));
  });

  await step("guardian releases the share to the heir's inbox", async () => {
    await switchTo("guardian");
    await nav("Guardian");
    await button("Release my share to the heir").click();
    await outcome(text(`Released to ${short(accounts.heir.publicKey)}'s inbox`));
  });

  await step("heir reassembles the seed phrase in the browser", async () => {
    await switchTo("heir");
    await nav("Heir");
    await (await enabled(button("Unseal the secret"), MINUTE)).click();
    await outcome(text("Recovered secret"));
    const words = await page.locator("ol li").evaluateAll((items) => items.map((li) => li.lastChild?.textContent?.trim() ?? ""));
    if (words.join(" ") !== SAMPLE_SEED) throw new Error(`recovered "${words.join(" ")}"`);
  });

  await step("chain check: one SIKRIT instruction per transaction; each wallet only where it acts", async () => {
    // The wallet co-signed exactly the confirmation and the claim, each already signed by the relayer, so Phantom's
    // rule never applied and nothing was added.
    const expectedSigned = [
      { account: "guardian", presigned: true, augmented: false },
      { account: "heir", presigned: true, augmented: false },
    ];
    if (JSON.stringify(signed) !== JSON.stringify(expectedSigned)) throw new Error(`wallet signed ${JSON.stringify(signed)}`);
    const connection = new Connection(RPC, "confirmed");
    const service = await fetch(new URL("api/relay", `${BASE}/`))
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined);
    const relayer = service?.relayer ? new PublicKey(service.relayer) : undefined;
    const signatures = await connection.getSignaturesForAddress(capsule);
    // create, heartbeat, trigger, confirm, claim
    if (signatures.length < 5) throw new Error(`expected ≥ 5 capsule transactions, found ${signatures.length}`);
    const seen = Object.fromEntries(Object.keys(accounts).map((name) => [name, []]));
    for (const { signature } of signatures) {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const message = tx.transaction.message;
      const keys = message.staticAccountKeys ?? message.accountKeys;
      const programs = message.compiledInstructions.map((ix) => keys[ix.programIdIndex].toBase58());
      if (programs.length !== 1 || programs[0] !== PROGRAM_ID.toBase58()) {
        throw new Error(`${signature} runs [${programs.join(", ")}], expected only the SIKRIT program`);
      }
      const data = Buffer.from(message.compiledInstructions[0].data);
      const name = tx.meta.logMessages.find((l) => l.startsWith("Program log: Instruction: "))?.slice(26) ?? "?";
      for (const [who, keypair] of Object.entries(accounts)) {
        if (keys.some((key) => key.equals(keypair.publicKey)) || data.includes(keypair.publicKey.toBuffer())) seen[who].push(name);
      }
      if (relayer && !keys[0].equals(relayer)) throw new Error(`fee payer of ${signature} is not the relayer service`);
    }
    const expected = { owner: [], heir: ["Claim"], guardian: ["GuardianConfirm"] };
    if (JSON.stringify(seen) !== JSON.stringify(expected)) throw new Error(`wallets appear in ${JSON.stringify(seen)}`);
    console.log(`\n  capsule ${capsule.toBase58()}: ${signatures.length} transactions, one SIKRIT instruction each`);
    console.log(`  owner wallet ${accounts.owner.publicKey.toBase58()} in none · heir only in the claim · guardian only in the confirmation`);
    console.log(`  fee payer: ${relayer ? `relayer service ${relayer.toBase58()}` : "the in-browser relayer"}`);
  });

  if (problems.length) throw new Error(`browser reported errors:\n  ${problems.join("\n  ")}`);
  console.log(`\nE2E wallet flow passed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} catch (error) {
  await page.screenshot({ path: `${OUT}wallet-failure.png`, fullPage: true }).catch(() => {});
  console.error(`\nFAILED: ${error.message}`);
  if (signed.length) console.error(`wallet signed: ${JSON.stringify(signed)}`);
  if (problems.length) console.error(`browser errors:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

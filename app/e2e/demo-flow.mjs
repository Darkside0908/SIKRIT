/**
 * End-to-end run of the demo story in a real browser against a real cluster:
 * Pak Arif seals a seed phrase → ZK heartbeat → re-seals it without Rizal (update_capsule) → falls silent →
 * Sari opens the claim → Budi and Dewi confirm → grace period → Sari claims → guardians release → Sari recovers the seed.
 *
 * Afterwards it checks the privacy claims on the chain itself: the owner's wallet appears in none of
 * the capsule's transactions, and each family member appears only in the transaction where they act
 * (Sari in the claim, Budi and Dewi in their confirmations), never in the capsule's data before that;
 * Rizal, a guardian who never acts, appears nowhere.
 *
 *   BASE_URL     app under test        (default http://localhost:5173)
 *   RPC_URL      cluster it talks to   (default http://127.0.0.1:8899)
 *   CHROME_PATH  Chrome/Chromium binary (default /usr/bin/google-chrome)
 *   HEADED=1     watch it run
 *   SHOTS_DIR    also save curated element screenshots there (docs/screenshots)
 *   RECORD_DIR   also record the run as demo-flow.mp4 there (B-roll for the demo video; the two
 *                60-second waits are cut out). Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg)
 *   SLOWMO=ms    pause between browser actions (makes a recording watchable)
 *   BROWSER_RELAYER_KEY  base64 secret key the app's in-browser relayer starts with (scripts/devnet-e2e.mjs
 *                funds it when it tests the static-host fallback on devnet, whose faucet refuses the app)
 *   LOSE_CONFIRMATION=0  register and re-seal the capsule normally. By default (unless recording or curating
 *                screenshots) the run lets both transactions land but drops their replies, as a relayer timeout
 *                would: the app must still end up with the capsule and the kit that matches it (SIK-22)
 *
 * When the host runs the relayer service (api/relay.ts: vite dev/preview, Vercel), the chain check also
 * confirms it paid for every capsule transaction.
 *
 * Picks capsule timers of 60 s in the create form, so a run takes ~3 min.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const OUT = new URL("./out/", import.meta.url).pathname;
const SHOTS = process.env.SHOTS_DIR;
const RECORD = process.env.RECORD_DIR;
const BROWSER_RELAYER = process.env.BROWSER_RELAYER_KEY;
const LOSE_CONFIRMATION = (process.env.LOSE_CONFIRMATION ?? (SHOTS || RECORD ? "0" : "1")) !== "0";
const SAMPLE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const MINUTE = 60_000;

mkdirSync(OUT, { recursive: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED, slowMo: Number(process.env.SLOWMO ?? 0) });
const viewport = { width: 1440, height: 900 };
const context = await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1 });
if (BROWSER_RELAYER) {
  // Same storage format as app/src/lib/actors.ts; set before the app's own scripts run.
  await context.addInitScript((secret) => {
    if (!localStorage.getItem("sikrit:relayer:v1")) localStorage.setItem("sikrit:relayer:v1", JSON.stringify({ relayer: secret }));
  }, BROWSER_RELAYER);
}
const page = await context.newPage();
const recorder = RECORD ? await record(page, RECORD) : undefined;
const problems = [];
let rateLimited = 0;
/** While a failure is injected on purpose, the errors it causes are expected. */
let injecting = false;
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() !== "error" || injecting) return;
  // A public RPC's 429s are retried by web3.js; they fail the run only if a step stalls because of them.
  if (/\b429\b/.test(m.text())) rateLimited++;
  else problems.push(`console.error: ${m.text()}`);
});

/**
 * Screencast over CDP, assembled with ffmpeg (Playwright's own recorder needs a separate
 * ffmpeg download). `pause()` drops frames, so long waits become jump cuts.
 */
async function record(target, dir) {
  const cdp = await target.context().newCDPSession(target);
  const frames = [];
  let paused = false;
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    if (!paused) frames.push({ data, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: viewport.width, maxHeight: viewport.height });
  let gapFrom;
  return {
    pause: () => ((paused = true), (gapFrom = frames.length)),
    // Frames after a pause continue right after the last kept frame.
    resume: () => ((paused = false), frames.length > gapFrom && (frames[gapFrom].cut = true)),
    async save() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      mkdirSync(dir, { recursive: true });
      const lines = [];
      frames.forEach((frame, i) => {
        const name = `frame-${String(i).padStart(6, "0")}.jpg`;
        writeFileSync(`${dir}/${name}`, Buffer.from(frame.data, "base64"));
        const next = frames[i + 1];
        const duration = !next ? 1 : next.cut ? 0.6 : Math.min(next.t - frame.t, 2);
        lines.push(`file '${name}'`, `duration ${Math.max(duration, 0.001).toFixed(3)}`);
      });
      lines.push(`file 'frame-${String(frames.length - 1).padStart(6, "0")}.jpg'`);
      writeFileSync(`${dir}/frames.txt`, lines.join("\n"));
      execFileSync(process.env.FFMPEG ?? "ffmpeg", [
        "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.txt",
        "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", "demo-flow.mp4",
      ], { cwd: dir });
      return `${dir}/demo-flow.mp4`;
    },
  };
}


const started = Date.now();
async function step(name, run) {
  const t0 = Date.now();
  process.stdout.write(`• ${name} … `);
  await run();
  console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
/** Curated screenshot of one element (or the viewport) for the docs; no-op without SHOTS_DIR. */
async function curate(name, target) {
  if (!SHOTS) return;
  await page.waitForTimeout(900); // let entrance animations settle
  const path = `${SHOTS}/${name}.png`;
  await (target ? target.screenshot({ path }) : page.screenshot({ path }));
}
const section = (text) => page.locator("section", { hasText: text }).last();
/** Holds a key screen in recordings (no-op otherwise), optionally scrolled to `target`. */
async function dwell(ms, target) {
  if (!RECORD) return;
  if (target) await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(ms);
}
const go = (hash) => page.goto(`${BASE}/#/${hash}`);
const button = (name) => page.getByRole("button", { name });
const actAs = (name) => button(new RegExp(`${name}$`)).click();
const text = (value) => page.getByText(value).first();

async function enabled(locator, timeout) {
  const deadline = Date.now() + timeout;
  await locator.waitFor({ timeout });
  while (!(await locator.isEnabled())) {
    if (Date.now() > deadline) throw new Error(`still disabled after ${timeout / 1000}s`);
    await page.waitForTimeout(500);
  }
  return locator;
}

/**
 * Lets the next transaction the app submits reach the chain but never answers it, as when a relayer function times
 * out or the connection drops after the broadcast. Returns a function that stops intercepting.
 */
async function loseNextConfirmation() {
  let lost = false;
  const handler = async (route) => {
    const request = route.request();
    const post = request.method() === "POST";
    const relayed = post && new URL(request.url()).pathname.endsWith("/api/relay");
    const broadcast = post && /"method":\s*"sendTransaction"/.test(request.postData() ?? "");
    if (lost || !(relayed || broadcast)) return route.fallback();
    lost = true;
    await route.fetch(); // the transaction goes out…
    await route.abort("timedout"); // …and the app never hears back
  };
  injecting = true;
  await page.route("**/*", handler);
  return async () => {
    await page.unroute("**/*", handler);
    injecting = false;
    if (!lost) throw new Error("the registration was never intercepted");
  };
}

let capsule;
/** Demo personas by id (arif, sari, budi, dewi, rizal) → wallet. */
let cast;

try {
  await step("owner derives the liveness key from a wallet signature", async () => {
    if (SHOTS || RECORD) {
      await go("");
      await page.getByText("Don't take your keys").waitFor();
      await curate("home");
      await dwell(3500);
    }
    await go("owner");
    await dwell(1500);
    await button("Derive my liveness key").click();
    await button("Invite the demo family").waitFor();
  });

  await step("heir and guardians send signed invites", async () => {
    await button("Invite the demo family").click();
    await text("✓ signed by Sari").waitFor();
    await dwell(2500);
    await button("Use a sample seed phrase").click();
    // 60 s timers on every cluster (a devnet build defaults to a 3-minute heartbeat).
    await page.getByLabel("Heartbeat every").selectOption("60");
    await page.getByLabel("Grace period").selectOption("60");
    await dwell(2000, button("Seal the capsule"));
    await shot("01-create");
    await curate("create", page.locator("main"));
  });

  await step(`owner seals the seed phrase and registers the capsule${LOSE_CONFIRMATION ? " (its confirmation lost)" : ""}`, async () => {
    const restore = LOSE_CONFIRMATION ? await loseNextConfirmation() : undefined;
    await button("Seal the capsule").click();
    await button("Send ZK heartbeat").waitFor({ timeout: MINUTE });
    if (restore) {
      // The app never heard that the registration landed; the dashboard must still hold the kit, adopted from the
      // copy filed before broadcasting.
      await text("Delivered to the family's inboxes").waitFor({ timeout: MINUTE });
      await restore();
    } else {
      await text("create_capsule").waitFor();
    }
    await dwell(3000, section("What the chain sees"));
    await shot("02-sealed");
    const state = await page.evaluate(() => ({
      mailbox: JSON.parse(localStorage.getItem("sikrit:mailbox:v1") ?? "{}"),
      cast: JSON.parse(localStorage.getItem("sikrit:cast:v1") ?? "{}"),
    }));
    capsule = new PublicKey(Object.keys(state.mailbox.kits)[0]);
    cast = Object.fromEntries(
      Object.entries(state.cast).map(([id, secret]) => [id, Keypair.fromSecretKey(Buffer.from(secret, "base64")).publicKey]),
    );
    // Before anyone in the family has acted, the capsule's data names none of them.
    const data = (await new Connection(RPC, "confirmed").getAccountInfo(capsule)).data;
    const named = Object.entries(cast).filter(([, wallet]) => data.includes(wallet.toBuffer())).map(([id]) => id);
    if (named.length) throw new Error(`capsule data names ${named.join(", ")} right after creation`);
  });

  await step("owner sends a ZK heartbeat; the inspector shows no owner wallet", async () => {
    await button("Send ZK heartbeat").click();
    await text("R = k·G").waitFor({ timeout: MINUTE });
    await text("Not present").waitFor();
    if (await page.getByText("Present!").count()) throw new Error("owner wallet present in heartbeat");
    await shot("03-heartbeat");
    await curate("heartbeat", page.locator("section", { has: button("Send ZK heartbeat") }));
    await curate("inspector", section("What the chain sees"));
    await dwell(5000, section("What the chain sees"));
  });

  await step(`owner re-seals the capsule without Rizal${LOSE_CONFIRMATION ? " (its confirmation lost too)" : ""}`, async () => {
    await button("Change heir, guardians or rules").click();
    // The editor starts from the current kit: Sari, then Budi, Dewi and Rizal.
    await text("✓ signed by Rizal").waitFor();
    await page.getByPlaceholder("sikrit-invite:v1:…").nth(3).fill("");
    await page.getByLabel("Guardian quorum").selectOption("2");
    await button("Use a sample seed phrase").click();
    await dwell(2000, button("Re-seal and update"));
    const restore = LOSE_CONFIRMATION ? await loseNextConfirmation() : undefined;
    await button("Re-seal and update").click();
    // The editor closes once the chain shows the new kit's share hashes, whether or not the reply arrived.
    await button("Change heir, guardians or rules").waitFor({ timeout: MINUTE });
    await text("2 of 2").waitFor();
    await restore?.();
    if (!restore) await text("update_capsule").waitFor();
    if (await page.getByText("Rizal").count()) throw new Error("Rizal is still listed after the re-seal");
    await text("Delivered to the family's inboxes").waitFor();
    await dwell(2500);
  });

  await step("owner falls silent past the interval", async () => {
    recorder?.pause();
    await text("Overdue — anyone may open a claim now").waitFor({ timeout: 2 * MINUTE });
    recorder?.resume();
  });

  await step("heir opens the claim", async () => {
    await go("heir");
    await (await enabled(button("Open the claim"), MINUTE)).click();
    await button("Claim the capsule").waitFor({ timeout: MINUTE });
    await dwell(2500);
    await shot("04-claim-open");
  });

  await step("both remaining guardians confirm", async () => {
    await go("guardian");
    for (const guardian of ["Budi", "Dewi"]) {
      await actAs(guardian);
      await (await enabled(button("Confirm the claim"), MINUTE)).click();
      await button("Confirmed").waitFor({ timeout: MINUTE });
      await dwell(1500);
    }
    await shot("05-confirmed");
    await curate("guardian", page.locator("article").first());
  });

  await step("heir claims once the grace period ends", async () => {
    await go("heir");
    recorder?.pause();
    const claim = await enabled(button("Claim the capsule"), 2 * MINUTE);
    recorder?.resume();
    await page.waitForTimeout(800);
    await claim.click();
    await text("Sealed no more.").waitFor({ timeout: MINUTE });
    await dwell(2500);
    await shot("06-claimed");
  });

  await step("guardians release their shares to the heir's inbox", async () => {
    await go("guardian");
    for (const guardian of ["Budi", "Dewi"]) {
      await actAs(guardian);
      await button("Release my share to the heir").click();
      await text("Released to Sari's inbox").waitFor({ timeout: MINUTE });
      await dwell(1500);
    }
  });

  await step("heir reassembles the seed phrase in the browser", async () => {
    await go("heir");
    await (await enabled(button("Unseal the secret"), MINUTE)).click();
    await text("Recovered secret").waitFor({ timeout: MINUTE });
    const words = await page.locator("ol li").evaluateAll((items) =>
      items.map((li) => li.lastChild?.textContent?.trim() ?? ""),
    );
    if (words.join(" ") !== SAMPLE_SEED) throw new Error(`recovered "${words.join(" ")}"`);
    const hold = button("Hold to reveal");
    const recovery = section("Your key to this capsule");
    await recovery.scrollIntoViewIfNeeded();
    await hold.hover();
    await page.mouse.down();
    await page.waitForTimeout(400);
    await shot("07-recovered");
    await curate("recovered", recovery);
    await dwell(4500);
    await page.mouse.up();
  });

  await step("public capsule page", async () => {
    await go(`capsule/${capsule.toBase58()}`);
    await text("Public record").waitFor();
    await shot("08-public");
    await curate("public", page.locator("main"));
    await dwell(2500);
    await dwell(3000, section("Not on-chain, anywhere"));
  });

  await step("chain check: no owner wallet; each family member only where they act", async () => {
    const connection = new Connection(RPC, "confirmed");
    const service = await fetch(new URL("api/relay", `${BASE}/`))
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined);
    const relayer = service?.relayer ? new PublicKey(service.relayer) : undefined;
    const signatures = await connection.getSignaturesForAddress(capsule);
    // create, heartbeat, update, trigger, 2 × confirm, claim
    if (signatures.length < 7) throw new Error(`expected ≥ 7 capsule transactions, found ${signatures.length}`);
    /** Where each persona's wallet shows up: instruction names of the transactions that carry it. */
    const seen = Object.fromEntries(Object.keys(cast).map((id) => [id, []]));
    for (const { signature } of signatures) {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const message = tx.transaction.message;
      const keys = message.staticAccountKeys ?? message.accountKeys;
      const data = Buffer.concat(message.compiledInstructions.map((ix) => Buffer.from(ix.data)));
      const name = tx.meta.logMessages.find((l) => l.startsWith("Program log: Instruction: "))?.slice(26) ?? "?";
      for (const [id, wallet] of Object.entries(cast)) {
        if (keys.some((key) => key.equals(wallet)) || data.includes(wallet.toBuffer())) seen[id].push(name);
      }
      if (relayer && !keys[0].equals(relayer)) throw new Error(`fee payer of ${signature} is not the relayer service`);
    }
    const expected = { arif: [], sari: ["Claim"], budi: ["GuardianConfirm"], dewi: ["GuardianConfirm"], rizal: [] };
    for (const [id, names] of Object.entries(expected)) {
      if (JSON.stringify(seen[id]) !== JSON.stringify(names)) {
        throw new Error(`${id} appears in [${seen[id].join(", ")}], expected [${names.join(", ")}]`);
      }
    }
    // After the claim the capsule stores the heir it revealed, and still no guardian or owner.
    const data = (await connection.getAccountInfo(capsule)).data;
    const named = Object.entries(cast).filter(([, wallet]) => data.includes(wallet.toBuffer())).map(([id]) => id);
    if (JSON.stringify(named) !== JSON.stringify(["sari"])) throw new Error(`capsule data names [${named.join(", ")}], expected [sari]`);
    console.log(`\n  capsule ${capsule.toBase58()}: ${signatures.length} transactions`);
    console.log(`  owner ${cast.arif.toBase58()} in none · Sari only in her claim · Budi and Dewi only in their confirmations · Rizal in none`);
    console.log(`  fee payer: ${relayer ? `relayer service ${relayer.toBase58()}` : "the in-browser relayer"}`);
  });

  if (rateLimited) console.log(`  ${rateLimited} rate-limited RPC responses (HTTP 429), retried by web3.js`);
  if (problems.length) throw new Error(`browser reported errors:\n  ${problems.join("\n  ")}`);
  console.log(`\nE2E demo flow passed in ${((Date.now() - started) / 1000).toFixed(0)}s · screenshots in ${OUT}`);
} catch (error) {
  await shot("failure").catch(() => {});
  console.error(`\nFAILED: ${error.message}`);
  if (problems.length) console.error(`browser errors:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} finally {
  if (recorder) console.log(`recording saved: ${await recorder.save()}`);
  await context.close();
  await browser.close();
}

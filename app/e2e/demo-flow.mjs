/**
 * End-to-end run of the demo story in a real browser against a real cluster:
 * Pak Arif seals a seed phrase → ZK heartbeat → falls silent → Sari opens the claim →
 * Budi and Dewi confirm → grace period → Sari claims → guardians release → Sari recovers the seed.
 *
 * Afterwards it checks the privacy claim on the chain itself: the owner's wallet appears in none
 * of the capsule's transactions.
 *
 *   BASE_URL     app under test        (default http://localhost:5173)
 *   RPC_URL      cluster it talks to   (default http://127.0.0.1:8899)
 *   CHROME_PATH  Chrome/Chromium binary (default /usr/bin/google-chrome)
 *   HEADED=1     watch it run
 *   SHOTS_DIR    also save curated element screenshots there (docs/screenshots)
 *   RECORD_DIR   also record the run as demo-flow.mp4 there (B-roll for the demo video; the two
 *                60-second waits are cut out). Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg)
 *   SLOWMO=ms    pause between browser actions (makes a recording watchable)
 *
 * Needs capsule timers of 60 s (the localnet defaults in the create form), so a run takes ~3 min.
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
const SAMPLE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const MINUTE = 60_000;

mkdirSync(OUT, { recursive: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED, slowMo: Number(process.env.SLOWMO ?? 0) });
const viewport = { width: 1440, height: 900 };
const context = await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1 });
const page = await context.newPage();
const recorder = RECORD ? await record(page, RECORD) : undefined;
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console.error: ${m.text()}`));

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

let capsule;
let owner;

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
    await dwell(2000, button("Seal the capsule"));
    await shot("01-create");
    await curate("create", page.locator("main"));
  });

  await step("owner seals the seed phrase and registers the capsule", async () => {
    await button("Seal the capsule").click();
    await button("Send ZK heartbeat").waitFor({ timeout: MINUTE });
    await text("create_capsule").waitFor();
    await dwell(3000, section("What the chain sees"));
    await shot("02-sealed");
    const state = await page.evaluate(() => ({
      mailbox: JSON.parse(localStorage.getItem("sikrit:mailbox:v1") ?? "{}"),
      cast: JSON.parse(localStorage.getItem("sikrit:cast:v1") ?? "{}"),
    }));
    capsule = new PublicKey(Object.keys(state.mailbox.kits)[0]);
    owner = Keypair.fromSecretKey(Buffer.from(state.cast.arif, "base64")).publicKey;
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

  await step("two of three guardians confirm", async () => {
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

  await step("chain check: owner wallet absent from every capsule transaction", async () => {
    const connection = new Connection(RPC, "confirmed");
    const signatures = await connection.getSignaturesForAddress(capsule);
    // create, heartbeat, trigger, 2 × confirm, claim
    if (signatures.length < 6) throw new Error(`expected ≥ 6 capsule transactions, found ${signatures.length}`);
    for (const { signature } of signatures) {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys;
      if (keys.some((key) => key.equals(owner))) throw new Error(`owner wallet appears in ${signature}`);
    }
    console.log(`\n  ${signatures.length} capsule transactions, owner ${owner.toBase58()} in none of them`);
  });

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

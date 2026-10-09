import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const OUT = "/home/igan/Projects/SIKRIT/docs/video/demo/";
const AUDIO_DIR = "/home/igan/Projects/SIKRIT/docs/video/demo_audio/";
const SAMPLE_SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const MINUTE = 60_000;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const viewport = { width: 1440, height: 900 };
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
const page = await context.newPage();

const frames = [];
let paused = false;
let gapFrom;

const cdp = await context.newCDPSession(page);
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  if (!paused) frames.push({ data, t: metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: viewport.width, maxHeight: viewport.height });

function pauseRecording() {
  paused = true;
  gapFrom = frames.length;
}

function resumeRecording() {
  paused = false;
  if (frames.length > gapFrom) frames[gapFrom].cut = true;
}

// Audio cues timeline: { name, file, startSec }
const audioCues = [];

function recordCue(name, file) {
  const currentElapsed = getCurrentVideoTime();
  audioCues.push({ name, file, startSec: currentElapsed });
  console.log(`[CUE] ${name} (${file}) at ${currentElapsed.toFixed(2)}s`);
}

function getCurrentVideoTime() {
  if (frames.length === 0) return 0;
  let totalSec = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const frame = frames[i];
    const next = frames[i + 1];
    const dur = next.cut ? 0.6 : Math.min(next.t - frame.t, 2);
    totalSec += Math.max(dur, 0.001);
  }
  return totalSec;
}

async function showTitleCard(title, subtitle, durationMs = 2500) {
  await page.evaluate(({ title, subtitle }) => {
    let el = document.getElementById("sikrit-title-card");
    if (!el) {
      el = document.createElement("div");
      el.id = "sikrit-title-card";
      el.style.position = "fixed";
      el.style.inset = "0";
      el.style.backgroundColor = "rgba(15, 13, 11, 0.95)";
      el.style.color = "#f4efe6";
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.zIndex = "999999";
      el.style.fontFamily = "sans-serif";
      el.style.transition = "opacity 0.3s ease";
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div style="font-size: 32px; font-weight: 700; color: #f59e0b; margin-bottom: 12px; letter-spacing: -0.5px;">${title}</div>
      <div style="font-size: 20px; color: #a8a29e;">${subtitle}</div>
    `;
    el.style.opacity = "1";
    el.style.display = "flex";
  }, { title, subtitle });
  
  await page.waitForTimeout(durationMs);
  
  await page.evaluate(() => {
    const el = document.getElementById("sikrit-title-card");
    if (el) {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }
  });
  await page.waitForTimeout(400);
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
let cast;

console.log("=== STARTING SYNCED DEMO RECORDING ===");

// 1. Home
await go("");
await page.getByText("Don't take your keys").waitFor();
recordCue("intro", "demo-01-intro.mp3");
await page.waitForTimeout(12500); // 12.5s for intro

// 2. Owner derive
await go("owner");
await page.waitForTimeout(1500);
recordCue("derive", "demo-02-derive.mp3");
await button("Derive my liveness key").click();
await button("Invite the demo family").waitFor();
await page.waitForTimeout(12000); // 12s for derive audio

// 3. Invite family
recordCue("invite", "demo-03-invite.mp3");
await button("Invite the demo family").click();
await text("✓ signed by Sari").waitFor();
await page.waitForTimeout(11000); // 11s for invite audio

// 4. Split & sample seed
recordCue("split", "demo-04-split.mp3");
await button("Use a sample seed phrase").click();
await page.getByLabel("Heartbeat every").selectOption("60");
await page.getByLabel("Grace period").selectOption("60");
await page.waitForTimeout(11000); // 11s for split audio

// 5. Seal capsule
recordCue("seal", "demo-05-seal.mp3");
await button("Seal the capsule").click();
await button("Send ZK heartbeat").waitFor({ timeout: MINUTE });
await text("create_capsule").waitFor();
await page.waitForTimeout(13500); // 13.5s for seal audio

// 6. Send ZK Heartbeat
recordCue("heartbeat", "demo-06-heartbeat.mp3");
await button("Send ZK heartbeat").click();
await text("R = k·G").waitFor({ timeout: MINUTE });
await text("Not present").waitFor();
await page.waitForTimeout(21000); // 21s for heartbeat audio & inspector view

// 7. Re-seal without Rizal (quick update)
await button("Change heir, guardians or rules").click();
await text("✓ signed by Rizal").waitFor();
await page.getByPlaceholder("sikrit-invite:v1:…").nth(3).fill("");
await page.getByLabel("Guardian quorum").selectOption("2");
await button("Use a sample seed phrase").click();
await button("Re-seal and update").click();
await button("Change heir, guardians or rules").waitFor({ timeout: MINUTE });
await text("2 of 2").waitFor();
await page.waitForTimeout(3000);

// Transition 1: Silence
pauseRecording();
await text("Overdue — anyone may open a claim now").waitFor({ timeout: 2 * MINUTE });
resumeRecording();
await showTitleCard("+60 s · Owner Falls Silent", "Heartbeat timer expired · Capsule becomes claimable");

// 8. Heir opens claim
recordCue("claim_open", "demo-07-claim-open.mp3");
await go("heir");
await (await enabled(button("Open the claim"), MINUTE)).click();
await button("Claim the capsule").waitFor({ timeout: MINUTE });
await page.waitForTimeout(7000); // 7s for claim open audio

// 9. Guardians confirm
recordCue("confirm", "demo-08-confirm.mp3");
await go("guardian");
for (const guardian of ["Budi", "Dewi"]) {
  await actAs(guardian);
  await (await enabled(button("Confirm the claim"), MINUTE)).click();
  await button("Confirmed").waitFor({ timeout: MINUTE });
  await page.waitForTimeout(3000);
}
await page.waitForTimeout(7000); // remaining confirm audio

// Transition 2: Grace period
pauseRecording();
await page.waitForTimeout(500);
// Wait for grace period in background
const waitGrace = Date.now() + 60_000;
while (Date.now() < waitGrace) {
  await new Promise(r => setTimeout(r, 1000));
}
resumeRecording();
await showTitleCard("+60 s · Grace Period Ended", "Quorum verified (2 of 2) · Secret ready to claim");

// 10. Heir claims
recordCue("claimed", "demo-09-claimed.mp3");
await go("heir");
const claimBtn = await enabled(button("Claim the capsule"), 2 * MINUTE);
await claimBtn.click();
await text("Sealed no more.").waitFor({ timeout: MINUTE });
await page.waitForTimeout(8000); // 8s for claimed audio

// 11. Guardians release shares
recordCue("release", "demo-10-release.mp3");
await go("guardian");
for (const guardian of ["Budi", "Dewi"]) {
  await actAs(guardian);
  await button("Release my share to the heir").click();
  await text("Released to Sari's inbox").waitFor({ timeout: MINUTE });
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(5000);

// 12. Heir recovers seed phrase
recordCue("unseal", "demo-11-unseal.mp3");
await go("heir");
await (await enabled(button("Unseal the secret"), MINUTE)).click();
await text("Recovered secret").waitFor({ timeout: MINUTE });
const hold = button("Hold to reveal");
await hold.hover();
await page.mouse.down();
await page.waitForTimeout(5000);
await page.mouse.up();
await page.waitForTimeout(5000);

// Finish screencast
await cdp.send("Page.stopScreencast").catch(() => {});
await browser.close();

console.log("=== SCREENCAST CAPTURED, PROCESSING FRAMES ===");
const rawDir = `${OUT}/synced_frames`;
mkdirSync(rawDir, { recursive: true });

const lines = [];
frames.forEach((frame, i) => {
  const name = `frame-${String(i).padStart(6, "0")}.jpg`;
  writeFileSync(`${rawDir}/${name}`, Buffer.from(frame.data, "base64"));
  const next = frames[i + 1];
  const duration = !next ? 1 : next.cut ? 0.6 : Math.min(next.t - frame.t, 2);
  lines.push(`file '${name}'`, `duration ${Math.max(duration, 0.001).toFixed(3)}`);
});
lines.push(`file 'frame-${String(frames.length - 1).padStart(6, "0")}.jpg'`);
writeFileSync(`${rawDir}/frames.txt`, lines.join("\n"));

const silentVideo = `${OUT}/demo_silent.mp4`;
console.log(`Encoding silent video to ${silentVideo}...`);
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${rawDir}/frames.txt`,
  "-vf", "fps=30,scale=1440:900,format=yuv420p", "-c:v", "libx264", "-crf", "18", silentVideo
]);

// Build final audio track with precise delays
console.log("Multiplexing audio cues...");
writeFileSync(`${OUT}/cues.json`, JSON.stringify(audioCues, null, 2));


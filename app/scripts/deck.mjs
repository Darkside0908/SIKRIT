/**
 * Renders the pitch deck (docs/deck/index.html) to docs/deck/SIKRIT-deck.pdf with headless Chrome.
 *
 *   npm run deck                      PDF only
 *   npm run deck -- --png <dir>       also one 1920×1080 PNG per slide (for video editing)
 *   npm run deck -- --brand           also docs/brand/: square logo (1024 px) + cover image (slide 1)
 *   REPO_URL=github.com/you/SIKRIT    override the repository link printed on the last slide
 */
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const query = process.env.REPO_URL ? `?repo=${encodeURIComponent(process.env.REPO_URL)}` : "";
const pngIndex = process.argv.indexOf("--png");
const pngDir = pngIndex > 0 ? process.argv[pngIndex + 1] : undefined;
const brand = process.argv.includes("--brand");

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`file://${ROOT}docs/deck/index.html${query}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));

  const pdf = `${ROOT}docs/deck/SIKRIT-deck.pdf`;
  await page.pdf({ path: pdf, width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
  console.log(`✓ ${pdf}`);

  if (pngDir) {
    mkdirSync(pngDir, { recursive: true });
    await page.emulateMedia({ media: "print" });
    const slides = page.locator(".slide");
    const count = await slides.count();
    for (let i = 0; i < count; i++) {
      const path = `${pngDir}/slide-${String(i + 1).padStart(2, "0")}.png`;
      await slides.nth(i).screenshot({ path });
    }
    console.log(`✓ ${count} slide PNGs in ${pngDir}`);
  }

  if (brand) {
    const dir = `${ROOT}docs/brand`;
    mkdirSync(dir, { recursive: true });
    await page.emulateMedia({ media: "print" });
    await page.locator(".slide").first().screenshot({ path: `${dir}/sikrit-cover.png` });
    const logo = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    const seal = readFileSync(`${ROOT}app/public/seal.svg`, "utf8").replace("<svg ", '<svg width="820" height="820" ');
    await logo.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0f0d0b">${seal}</body>`);
    await logo.screenshot({ path: `${dir}/sikrit-logo-1024.png` });
    console.log(`✓ logo + cover in ${dir}`);
  }
} finally {
  await browser.close();
}

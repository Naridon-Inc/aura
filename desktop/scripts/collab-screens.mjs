// Capture a harness page's scenes, in both themes.
//
//   node scripts/collab-screens.mjs            # assumes vite on :1431
//   PORT=1420 OUT=/tmp/shots node scripts/collab-screens.mjs
//   PAGE=chrome-harness.html OUT=/tmp/chrome node scripts/collab-screens.mjs
//
// The page it drives mounts real components with real state — the collab
// surface from a recorded wire (src/components/collab/__harness__/main.tsx), or
// the shell's own chrome (src/components/ui/__harness__/main.tsx). This script
// only points a browser at whichever one `PAGE` names and writes one PNG per
// scene, plus a full-page sheet, so a rendering fault is caught by looking
// rather than by a selector that happens to match an empty box.
//
// It also fails loudly on a console error or an empty scene: a component that
// throws still leaves a screenshot behind, and a green run that quietly shot a
// blank rectangle is worse than no run at all.

import { chromium } from "/Users/muhammed/Documents/naridonmarketer/node_modules/playwright-core/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.PORT ?? "1431";
const PAGE = process.env.PAGE ?? "collab-harness.html";
// `localhost`, not `127.0.0.1`: vite binds ::1 by default on this machine, and
// dialling the v4 literal is refused by a server that is up and serving.
const URL = `http://localhost:${PORT}/${PAGE}`;
const OUT = process.env.OUT ?? "/tmp/collab-screens";

const THEMES = ["dark", "light"];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const problems = [];

  for (const theme of THEMES) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 1400 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`[${theme}] console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${theme}] threw: ${e.message}`));

    await page.goto(URL, { waitUntil: "networkidle" });
    // How the app itself switches: `themeStore` puts a `.light` class on <html>
    // and the palette lives in a `.light` scope in styles.css. Setting only the
    // browser's colour-scheme (or a `data-theme` attribute, which nothing here
    // reads) left every "light" capture a byte-identical copy of the dark one —
    // a harness quietly shooting the same screen twice and reporting two.
    await page.evaluate((t) => {
      document.documentElement.classList.toggle("light", t === "light");
      document.documentElement.setAttribute("data-theme", t);
    }, theme);
    await page.waitForSelector("[data-scene]", { timeout: 15000 });

    const scenes = await page.$$("[data-scene]");
    for (const scene of scenes) {
      const id = await scene.getAttribute("data-scene");
      const box = await scene.boundingBox();
      if (!box || box.height < 12) {
        problems.push(`[${theme}] scene "${id}" rendered nothing (${box?.height ?? 0}px tall)`);
        continue;
      }
      const file = join(OUT, `${id}-${theme}.png`);
      await scene.screenshot({ path: file });
      console.log(`  ${String(Math.round(box.height)).padStart(4)}px  ${file}`);
    }

    const sheet = join(OUT, `all-${theme}.png`);
    await page.screenshot({ path: sheet, fullPage: true });
    console.log(`         ${sheet}`);
    await page.close();
  }

  await browser.close();

  if (problems.length) {
    console.log(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`   ${p}`);
    process.exit(1);
  }
  console.log("\n✓ every scene rendered, both themes, no console errors");
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

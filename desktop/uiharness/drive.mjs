// Headless UI harness for the real aura-shell frontend.
//
// Drives the live Vite app at http://localhost:1420 inside its OWN Chrome
// (channel: "chrome", no browser download) with a Tauri IPC shim injected
// before the bundle loads. Because it's a separate browser process driving
// its own page events, it NEVER touches the user's mouse or keyboard — they
// can keep working while this runs.
//
// Usage:  node drive.mjs [scenario]
//   scenario ∈ { boot, palette, crew, all }   (default: all)
//
// Output: PNG screenshots in ./shots, plus a console/error/unmocked-invoke
// report printed to stdout. The process force-exits at the end so a wedged
// browser subprocess can never leave it hanging.
//
// Scope: this verifies UI + flow (does the Definitions group render, does a
// click fire aura:scroll-to-line, does Crew show its tabs/graph/proof). The
// backend is mocked from data.json — real search/grep correctness is proven
// separately at the shell.

import { chromium } from "playwright-core";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = process.env.AURA_URL || "http://localhost:1420";
const SCENARIO = process.argv[2] || "all";
const SHOTS = join(HERE, "shots");

const shimSource = await readFile(join(HERE, "shim.js"), "utf8");
const data = JSON.parse(await readFile(join(HERE, "data.json"), "utf8"));

const consoleErrors = [];
const pageErrors = [];
const events = []; // lifecycle breadcrumbs (crash/close/goto status)

function log(...a) {
  console.log("[harness]", ...a);
}

// Wrap any async step so a throw is logged and swallowed — one broken scene
// or locator must never abort the rest of the run or the report.
async function safe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).split("\n")[0];
    log(`✗ ${label}: ${msg}`);
    events.push(`${label} threw: ${msg}`);
    return undefined;
  }
}

async function newPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1320, height: 860 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("crash", () => events.push("PAGE CRASHED"));
  page.on("close", () => events.push("page closed"));
  // Inject fixtures first, then the shim — both run before any page script.
  await page.addInitScript(`window.__AURA_DATA__ = ${JSON.stringify(data)};`);
  await page.addInitScript({ content: shimSource });
  // Seed localStorage so the app boots straight into the workspace, not the
  // first-run onboarding gate: mark onboarding complete, open the repo as the
  // last workspace, force the v2 ADE, and land on the Build rail (where ⌘K
  // search + Crew live). Without onboarding.complete the SignIn screen covers
  // everything and ⌘K/Crew never reach the surface.
  const root = data.repoRoot || "/";
  await page.addInitScript((repoRoot) => {
    try {
      localStorage.setItem("aura.onboarding.complete", "1");
      localStorage.setItem("aura.ade.v2", "1");
      localStorage.setItem("aura.ade.section", "build");
      localStorage.setItem("aura.lastWorkspace", repoRoot);
      localStorage.setItem("aura.recents", JSON.stringify([repoRoot]));
    } catch (e) {}
  }, root);
  return { ctx, page };
}

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
}

async function shot(page, name) {
  const path = join(SHOTS, name);
  await safe(`screenshot ${name}`, async () => {
    await page.screenshot({ path, timeout: 12000, animations: "disabled" });
    log("shot →", path);
  });
}

// ── scenarios ──────────────────────────────────────────────────────────────

async function sceneBoot(page) {
  const resp = await safe("goto", () => page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 }));
  events.push("goto status: " + (resp ? resp.status() : "no-response"));
  // Early probe shot — confirms screenshots work before the long settle.
  await settle(page, 600);
  await shot(page, "00-probe.png");
  await settle(page, 1600);
  await shot(page, "01-boot.png");
}

async function scenePalette(page) {
  // Open ⌘K. The app binds metaKey+k; a real page keydown fires the handler.
  await safe("open palette", async () => {
    await page.keyboard.press("Meta+KeyK");
    await settle(page, 500);
    await page.keyboard.type("agent", { delay: 40 });
    await settle(page, 300); // debounce (140ms)
  });
  // The symbol lane (fs_grep_symbol → "Definitions" group) resolves async,
  // ~1s after the query. Wait for that group header so the screenshot proves
  // the Definitions results render — not the pre-symbol frame.
  await safe("await Definitions group", () =>
    page.locator('text=Definitions').first().waitFor({ state: "visible", timeout: 5000 }),
  );
  await settle(page, 250);
  await shot(page, "02-palette-agent.png");

  // Observe click-to-open: listen for the aura:scroll-to-line CustomEvent the
  // app dispatches when a symbol/match/intent result is picked.
  await safe("arm scroll listener", () =>
    page.evaluate(() => {
      window.__SCROLLED__ = null;
      window.addEventListener(
        "aura:scroll-to-line",
        (e) => {
          window.__SCROLLED__ = e.detail || true;
        },
        { once: true },
      );
    }),
  );
  await safe("click symbol row", async () => {
    const sym = page.locator('li:has-text("AgentPicker"), li:has-text("spawnAgent")').first();
    if (await sym.count()) {
      await sym.click({ timeout: 2000 });
      await settle(page, 400);
    } else {
      events.push("no symbol row found in palette");
    }
  });
  const scrolled = await safe("read scroll detail", () => page.evaluate(() => window.__SCROLLED__));
  log("click-to-open dispatched aura:scroll-to-line →", JSON.stringify(scrolled));
}

async function sceneCrew(page) {
  await safe("close palette", async () => {
    await page.keyboard.press("Escape");
    await settle(page, 300);
  });
  // Open Crew via the wired app event (more robust than hunting a rail row).
  await safe("open crew", async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("aura:open-crew")));
    await settle(page, 1400);
  });
  await shot(page, "03-crew.png");
  // Capture the Activity tab too. WizardStepTabs renders role="tab" buttons —
  // target by role so we hit the real tab, not stray "Activity" text elsewhere.
  await safe("crew activity tab", async () => {
    const activity = page.getByRole("tab", { name: /Activity/ }).first();
    if (await activity.count()) {
      await activity.click({ timeout: 4000 });
      await settle(page, 900);
      await shot(page, "04-crew-activity.png");
    } else {
      events.push("no Activity tab found");
    }
  });
}

// ── runner ───────────────────────────────────────────────────────────────

async function main() {
  await mkdir(SHOTS, { recursive: true });

  // NB: do NOT pass --disable-gpu. On macOS headless Chrome it forces the
  // SwiftShader software path, whose compositor can wedge so Page.captureScreenshot
  // never returns a frame (page JS stays responsive — only screenshots hang).
  const launchArgs = ["--no-sandbox", "--disable-dev-shm-usage"];
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, args: launchArgs });
  } catch (e) {
    log("chrome launch failed, trying default chromium…", String(e).split("\n")[0]);
    browser = await chromium.launch({ headless: true, args: launchArgs });
  }
  const { ctx, page } = await newPage(browser);

  await safe("sceneBoot", () => sceneBoot(page));
  if (SCENARIO === "all" || SCENARIO === "palette") await safe("scenePalette", () => scenePalette(page));
  if (SCENARIO === "all" || SCENARIO === "crew") await safe("sceneCrew", () => sceneCrew(page));

  // Diagnostics: what did the app ask the backend that we didn't mock?
  const unmocked = await safe("read invoke log", () =>
    page.evaluate(() => {
      const seen = new Set(window.__AURA_INVOKE_LOG__ || []);
      const known = new Set([
        "current_dir", "home_dir", "aura_status", "git_status", "git_branch",
        "fs_find_files", "fs_grep_symbol", "fs_grep_content", "aura_intent_recent",
        "loop_ready_view", "loop_review", "loop_sync_board", "loop_run_native", "loop_set_status",
        "read_atlas", "tasks_list", "aura_cli",
        "plugin:event|listen", "plugin:event|unlisten", "plugin:event|emit", "plugin:event|emit_to",
      ]);
      return [...seen].filter((c) => !known.has(c));
    }),
  );
  const shimErr = (await safe("read shim errors", () => page.evaluate(() => window.__AURA_INVOKE_ERR__ || []))) || [];

  console.log("\n===== harness report =====");
  console.log("scenario           :", SCENARIO);
  console.log("console errors     :", consoleErrors.length);
  consoleErrors.slice(0, 8).forEach((e) => console.log("   ⚠︎", e.slice(0, 160)));
  console.log("page errors        :", pageErrors.length);
  pageErrors.slice(0, 8).forEach((e) => console.log("   ✗", e.slice(0, 160)));
  console.log("unmocked invokes   :", unmocked && unmocked.length ? unmocked.join(", ") : "(none)");
  if (shimErr.length) console.log("shim handler errors:", shimErr.slice(0, 6).join(" | "));
  console.log("lifecycle          :", events.length ? events.join(" · ") : "(clean)");
  console.log("==========================\n");

  // Best-effort teardown — each guarded so a wedged page can't block exit.
  await safe("ctx.close", () => ctx.close());
  await safe("browser.close", () => browser.close());
}

// Hard backstop: whatever happens, exit within 90s so we never become a zombie.
const watchdog = setTimeout(() => {
  console.error("[harness] watchdog fired — forcing exit");
  process.exit(2);
}, 90000);
watchdog.unref();

main()
  .then(() => {
    log("done");
    process.exit(0);
  })
  .catch((e) => {
    console.error("[harness] fatal:", e);
    process.exit(1);
  });

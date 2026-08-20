// Why every dropdown in the app was dead, and the one rule that fixed them.
//
//   bun test tests/overlayStacking.test.ts
//
// Settings › Brain & models › Provider, the Tasks rail's Filters and Display,
// the second sidebar's project picker: all reported as "clicking does nothing".
// They are one bug, not several. Radix portals a menu out to <body> and
// positions it `fixed`, but never gives it a z-index. Measured in the running
// WKWebView, `[data-radix-popper-content-wrapper]` computed to `z-index: auto`
// — and a positioned element with `auto` paints in the z-index: 0 layer, which
// is BELOW every positioned element that names a number. This app names
// numbers everywhere; the Settings surface alone is `z-40`.
//
// So the menus were opening, painting, and going behind the surface they were
// opened from. The probe put a `z-40` overlay next to a portalled panel and
// asked `elementFromPoint` which one owned the panel's own centre:
//
//   before   stacking: { overlayZ: "40", hitIsPanel: false, hitIsOverlay: true }
//   after    stacking: { overlayZ: "40", hitIsPanel: true,  hitIsOverlay: false }
//
// The click was landing on the overlay. Nothing was wrong with the wiring, the
// handlers, or the Select adapter — which is why "wire it up" commits kept not
// fixing it.
//
// The load-bearing test here is the second one. The fix only holds while the
// menu layer outranks EVERY number the app draws, so this file computes the
// app's own ceiling from source rather than trusting the constant. Write
// `z-[200000]` on a pane six months from now and this fails, loudly, instead of
// the dropdowns quietly dying again.

import { describe, expect, test } from "bun:test";

const SRC = `${import.meta.dir}/../src`;

const css = await Bun.file(`${SRC}/styles.css`).text();

/** The `z-index: …` rule that lifts portalled menus above the app. */
function menuLayerRule(): string {
  const start = css.indexOf("\n[data-radix-popper-content-wrapper],");
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}

// Styles this file writes are injected into a DIFFERENT document — the page
// loaded in the in-app browser's webview — so its INT_MAX pins can't paint over
// anything of ours. It is the only source of z-index in `src` that isn't about
// our own DOM; anything else appearing here should be a deliberate decision.
const FOREIGN_DOCUMENT = ["lib/browserEngine.ts"];

/** Every z-index this app asks for, by hand, in its own document. */
async function appZIndexes(): Promise<{ value: number; where: string }[]> {
  const found: { value: number; where: string }[] = [];
  for await (const rel of new Bun.Glob("**/*.{ts,tsx,css}").scan({ cwd: SRC })) {
    if (FOREIGN_DOCUMENT.includes(rel)) continue;
    const text = await Bun.file(`${SRC}/${rel}`).text();
    // Tailwind's scale (`z-40`) and its arbitrary escape (`z-[60]`), plus raw
    // CSS. `z-index: var(…)` carries no number and is skipped by all three.
    for (const re of [/\bz-\[(\d+)\]/g, /\bz-(\d+)\b/g, /z-index:\s*(\d+)/g]) {
      for (const m of text.matchAll(re)) {
        found.push({ value: Number(m[1]), where: rel });
      }
    }
  }
  return found;
}

describe("a menu opens on top of the app", () => {
  test("the portal layer is given a z-index. Radix gives it none", () => {
    const rule = menuLayerRule();
    expect(rule).toContain("z-index: var(--z-menu-portal) !important");
    expect(css).toContain("--z-menu-portal:");
  });

  test("it outranks every number the app draws", async () => {
    const declared = css.match(/--z-menu-portal:\s*(\d+)/);
    expect(declared).not.toBeNull();
    const menu = Number(declared![1]);

    const app = (await appZIndexes()).filter((z) => z.value !== menu);
    expect(app.length).toBeGreaterThan(20); // the scan is actually finding them

    // Asserted as a list rather than a max, so a failure names the file that
    // out-climbed the menus instead of just printing a number.
    //
    // `>=`, not `>`: a tie resolves by DOM order, and #root is mounted BEFORE
    // the portal containers, so a tie holds today and breaks the first time
    // someone portals something. Beat the app outright.
    expect(app.filter((z) => z.value >= menu)).toEqual([]);
  });

  test("both of Radix's positioning shapes are covered", () => {
    const rule = menuLayerRule();
    // `position="popper"` wraps the panel…
    expect(rule).toContain("[data-radix-popper-content-wrapper]");
    // …`position="item-aligned"` does not, so the panel is portalled bare.
    expect(rule).toContain('#root ~ * > [data-state="open"]');
    expect(rule).toContain('#root ~ [data-state="open"]');
  });

  test("the rule asserts z-index and nothing else", () => {
    // Forcing `position` here would relocate an item-aligned Select, which
    // positions itself by putting the CHOSEN row over the trigger. On a static
    // element z-index is simply inert, so the broad match stays safe.
    const rule = menuLayerRule();
    expect(rule).not.toContain("position:");
    expect(rule).not.toContain("inset:");
    expect(rule).not.toContain("transform:");
  });

  test("and it still opens instantly. The parked-clock fix survives", () => {
    // The other half of the same failure: WKWebView parks the document clock
    // when it thinks the window is occluded, so Medusa's entrance keyframe
    // never runs and the panel paints its first frame — `opacity: 0`. Measured:
    // `clock0 === clock1` across 1.2s, `document.hidden === true`.
    const anim = css.slice(css.indexOf('#root ~ .animate-in'));
    const block = anim.slice(0, anim.indexOf("}") + 1);
    expect(block).toContain("animation: none !important");
    expect(block).toContain("opacity: 1 !important");
  });
});

describe("the diagnostic that found it is gone", () => {
  test("no probe is imported into the app", async () => {
    const main = await Bun.file(`${SRC}/main.tsx`).text();
    expect(main).not.toContain("__overlayProbe");
  });

  test("and its files are not in the tree", async () => {
    for (const rel of ["lib/__overlayProbe.ts", "probe2.tsx"]) {
      expect(await Bun.file(`${SRC}/${rel}`).exists()).toBe(false);
    }
    expect(await Bun.file(`${SRC}/../probe2.html`).exists()).toBe(false);
  });
});

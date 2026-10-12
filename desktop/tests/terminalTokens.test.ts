// The terminal's colors come from the theme, and this is what keeps them there.
//
//   bun test tests/terminalTokens.test.ts
//
// Background: the native terminal's palette used to be a Rust constant, so
// switching theme recolored the whole app except the one surface agent users
// watch all day. The fix made `--term-*` in styles.css the single source, read
// at runtime with getComputedStyle and handed to whichever renderer is live.
//
// The first version of that fix did not work, and looked perfect in source.
// The tokens were declared in the `@theme` block with every other color, but
// Tailwind v4 emits a theme variable only when something references it — and
// nothing references these, because they are read by script rather than written
// as utility classes. All twenty were tree-shaken out of the compiled sheet.
// Every token resolved to "", both renderers kept their compiled-in fallbacks,
// and the terminal went on ignoring the theme exactly as before.
//
// That is why the test that matters here compiles the stylesheet instead of
// reading it. Source-level checks cannot see a variable that exists in the
// author's file and not in the browser's. The rest guard the other three ways
// this rots:
//
//   - A new theme pack overrides none of the `--color-*` names the terminal
//     aliases. The app recolors, the terminal does not, and nobody notices
//     because the other packs still work.
//   - A token the frontend reads stops being declared: one slot silently falls
//     back to a hardcoded color.
//   - Someone "tidies" the ANSI slots into the UI accent tokens. That reads as
//     consistency and is a real bug: an ANSI color's meaning is assigned by the
//     program printing it, so pointing slot 3 at `--color-amber` — a cool
//     dirty-state marker here, not a yellow — paints every compiler warning
//     slate-cyan.
//
// What none of this proves is that the result looks right. It proves the values
// reach the renderer; whether they read well on screen still wants eyes.

import { describe, expect, test } from "bun:test";

const SRC = `${import.meta.dir}/../src`;

const css = await Bun.file(`${SRC}/styles.css`).text();
const appearanceTs = await Bun.file(`${SRC}/lib/terminalAppearance.ts`).text();

/** The theme-pack selectors a user can actually be in, in styles.css order. */
const PACKS = [
  ".light",
  ".theme-modal",
  ".theme-ember",
  ".theme-emerald",
  ".theme-amber",
  ".light.theme-amber",
];

/** The block that holds the `--term-*` declarations. */
function termBlock(): string {
  const anchor = css.indexOf("--term-bg:");
  expect(anchor).toBeGreaterThan(-1);
  const open = css.lastIndexOf("{", anchor);
  const close = css.indexOf("\n}", anchor);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(anchor);
  return css.slice(open, close);
}

/** The selector that owns the `--term-*` declarations. */
function termBlockSelector(): string {
  const anchor = css.indexOf("--term-bg:");
  const open = css.lastIndexOf("{", anchor);
  // The selector starts after whichever came last: the previous rule's `}` or
  // a comment's `*/`. Each delimiter has to be stepped over by its own length —
  // taking the max of the two indices and adding one clears the brace but
  // leaves the comment's trailing slash sitting in front of the selector.
  const afterComment = css.lastIndexOf("*/", open);
  const afterRule = css.lastIndexOf("}", open);
  const prevBrace = Math.max(
    afterComment < 0 ? -1 : afterComment + 1,
    afterRule < 0 ? -1 : afterRule,
  );
  return css.slice(prevBrace + 1, open).trim();
}

/**
 * The `--color-*` names the `--term-*` tokens are defined in terms of.
 *
 * Read out of the stylesheet rather than listed by hand: the claim under test
 * is that every pack reaches the terminal, and that has to be checked against
 * whatever the aliases say today, not what they said when this was written.
 */
function aliasedColorTokens(): string[] {
  const names = new Set<string>();
  for (const m of termBlock().matchAll(/var\((--color-[a-z0-9-]+)/g)) names.add(m[1]);
  return [...names].sort();
}

/** A named pack's declaration block, or null when the selector is gone. */
function packBlock(selector: string): string | null {
  const i = css.indexOf(`\n${selector} {`);
  if (i < 0) return null;
  const j = css.indexOf("\n}", i);
  return j < 0 ? null : css.slice(i, j);
}

/** Every `--term-*` custom property the frontend reads at runtime. */
function tokensReadByFrontend(): string[] {
  const names = new Set<string>();
  for (const m of appearanceTs.matchAll(/"(--term-[a-z0-9-]+)"/g)) names.add(m[1]);
  // The sixteen ANSI slots are built from a template, so the literal names
  // never appear in the source. Expand them only while that template is there —
  // if it is replaced by spelled-out literals, the regex above catches those.
  if (/`--term-ansi-\$\{/.test(appearanceTs)) {
    for (let i = 0; i < 16; i++) names.add(`--term-ansi-${i}`);
  }
  return [...names];
}

/** The stylesheet as the browser receives it. */
async function compiled(): Promise<string> {
  const { compile } = await import("@tailwindcss/node");
  const compiler = await compile(css, { base: SRC, onDependency() {} });
  // No candidates: whatever survives is emitted unconditionally, which is the
  // only thing a getComputedStyle read can rely on.
  return compiler.build([]);
}

describe("selectionWash", () => {
  // The alpha moved out of the stylesheet and into this function, so the shape
  // it emits is now part of the contract with the Rust parser on the other
  // side of the IPC — `parse_rgb_fn` has to accept what comes out of here.
  test("puts the alpha back on a resolved color", async () => {
    const { selectionWash } = await import(`${SRC}/lib/terminalAppearance`);
    expect(selectionWash("rgb(77, 193, 164)")).toBe("rgb(77 193 164 / 0.3)");
    expect(selectionWash("rgb(77 193 164)")).toBe("rgb(77 193 164 / 0.3)");
  });

  test("replaces an alpha that is already there rather than stacking one", async () => {
    const { selectionWash } = await import(`${SRC}/lib/terminalAppearance`);
    expect(selectionWash("rgba(77, 193, 164, 0.8)")).toBe("rgb(77 193 164 / 0.3)");
  });

  test("passes through what it cannot read, and absence stays absence", async () => {
    const { selectionWash } = await import(`${SRC}/lib/terminalAppearance`);
    // A too-solid selection is a much better failure than none at all, and an
    // undefined token has to stay undefined so the backend keeps its fallback.
    expect(selectionWash("oklch(0.7 0.1 160)")).toBe("oklch(0.7 0.1 160)");
    expect(selectionWash(undefined)).toBeUndefined();
  });
});

describe("terminal color tokens", () => {
  // The one that caught the dead feature. Everything else here reads the
  // author's file; this reads what the browser would actually get.
  test("every token the frontend reads survives compilation", async () => {
    const out = await compiled();
    const missing = tokensReadByFrontend().filter(
      (t) => !new RegExp(`${t}\\s*:`).test(out),
    );
    expect(missing).toEqual([]);
  });

  // `@theme` prunes what nothing references, and nothing references these.
  test("the tokens are in a plain :root, not in @theme", () => {
    expect(termBlockSelector()).toBe(":root");
  });

  test("the chrome tokens stay live after compilation, not folded to literals", async () => {
    const out = await compiled();
    // A folded value is a token that has silently left the cascade: it will
    // keep the color it had at build time whatever theme the user picks. This
    // is how `color-mix(…, var(--color-accent-green) 30%, transparent)` broke.
    const frozen: string[] = [];
    for (const name of ["--term-bg", "--term-fg", "--term-cursor", "--term-selection"]) {
      const m = out.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      expect(m, `${name} is not in the compiled sheet`).not.toBeNull();
      if (!m![1].includes("var(")) frozen.push(`${name} = ${m![1].trim()}`);
    }
    expect(frozen).toEqual([]);
  });

  test("every token the frontend reads is declared", () => {
    const declared = termBlock();
    const missing = tokensReadByFrontend().filter(
      (t) => !new RegExp(`${t}\\s*:`).test(declared),
    );
    expect(missing).toEqual([]);
  });

  test("the aliases point at color tokens that exist", () => {
    const aliases = aliasedColorTokens();
    expect(aliases.length).toBeGreaterThan(0);
    const dangling = aliases.filter((t) => !new RegExp(`${t}\\s*:`).test(css));
    expect(dangling).toEqual([]);
  });

  // Checks the plumbing carries water for each theme a user can actually pick.
  test("every theme pack moves at least one color the terminal aliases", () => {
    const aliases = aliasedColorTokens();
    const inert: string[] = [];
    for (const pack of PACKS) {
      const block = packBlock(pack);
      expect(block, `${pack} is gone from styles.css — update PACKS`).not.toBeNull();
      if (!aliases.some((a) => new RegExp(`${a}\\s*:`).test(block!))) inert.push(pack);
    }
    // A pack listed here recolors the app and leaves the terminal alone.
    expect(inert).toEqual([]);
  });

  test("no pack redefines --term-*, so :root stays the single source", () => {
    const overriding = PACKS.filter((p) => (packBlock(p) ?? "").includes("--term-"));
    expect(overriding).toEqual([]);
  });

  // See the note at the top. This is the one that will look wrong to whoever
  // trips it, which is why the reason is written down twice.
  test("the ANSI slots are literal colors, not UI accent aliases", () => {
    const block = termBlock();
    const aliased: string[] = [];
    for (let i = 0; i < 16; i++) {
      const m = block.match(new RegExp(`--term-ansi-${i}\\s*:\\s*([^;]+);`));
      expect(m, `--term-ansi-${i} is not declared`).not.toBeNull();
      if (/var\(/.test(m![1])) aliased.push(`--term-ansi-${i}`);
    }
    // An ANSI slot's meaning belongs to the program printing it. Pointing one
    // at a UI accent makes the app's palette overrule the program's intent.
    expect(aliased).toEqual([]);
  });
});

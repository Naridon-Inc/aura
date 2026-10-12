/**
 * One source of terminal colors, for both terminal paths.
 *
 * Before this module there were three hardcoded palettes that had drifted
 * apart: `ANSI_16` in `aura-term-core`, and a `THEME` constant in each of the
 * two xterm views. None of them moved when the theme did, and since the GPU
 * path became the default the palette people actually saw lived in Rust where
 * no theme could reach it. Switching theme recolored the whole app except the
 * terminal.
 *
 * The tokens are the source now (`--term-*` in `styles.css`). Only the
 * frontend can resolve a CSS custom property, so it reads them and hands the
 * result to whichever renderer is in use: the GPU terminal over
 * `native_term_set_appearance`, xterm.js as its `theme` object.
 */

import { invoke } from "@tauri-apps/api/core";

import { webviewZoom } from "./nativeSurfacePlacement";

/** The sixteen ANSI slots, in the order the renderers index them. */
const ANSI_TOKENS = Array.from({ length: 16 }, (_, i) => `--term-ansi-${i}`);

/** Colors as resolved from the document, in the shape Rust deserializes. */
export type TerminalAppearance = {
  foreground?: string;
  background?: string;
  cursor?: string;
  selection?: string;
  ansi?: string[];
  fontPx?: number;
  /** App zoom, as a multiplier on `fontPx`. Set by the push, not by the read:
   *  it is a property of the window rather than of the theme. */
  zoom?: number;
};

/**
 * Read one custom property off the document root.
 *
 * Returns `undefined` rather than `""` for a token nobody defined, because the
 * two have to stay distinguishable all the way down: Rust treats an absent
 * field as "keep the fallback" and would have to treat an empty string as a
 * parse failure. Collapsing them here means a missing token silently becomes a
 * black terminal.
 */
function token(style: CSSStyleDeclaration, name: string): string | undefined {
  const v = style.getPropertyValue(name).trim();
  return v === "" ? undefined : v;
}

/** How much of the selection color shows through over the cell behind it. */
const SELECTION_ALPHA = 0.3;

/**
 * Turn the resolved selection color into the wash the renderers want.
 *
 * The alpha lives here rather than in the stylesheet because a CSS
 * `color-mix()` over a theme variable is constant-folded at build time, which
 * froze the color and took that token out of the cascade. `--term-selection`
 * therefore carries a live, opaque color and this puts the transparency back.
 *
 * getComputedStyle hands back `rgb(r, g, b)` or `rgb(r g b / a)`, so the
 * numbers are already resolved — this only has to re-emit them with an alpha.
 * Anything it does not recognise is returned unchanged: a terminal with a
 * too-solid selection is a far better failure than one with none.
 */
export function selectionWash(color: string | undefined): string | undefined {
  if (!color) return color;
  const m = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (!m) return color;
  return `rgb(${m[1]} ${m[2]} ${m[3]} / ${SELECTION_ALPHA})`;
}

/**
 * Resolve the terminal tokens against the live document.
 *
 * `getComputedStyle` is what makes this work at all: the tokens are authored
 * as `var(--color-bg-0)` and `color-mix(…)`, and computed style collapses them
 * to the concrete `rgb(…)` the theme currently resolves to. Reading the
 * authored text instead would hand the renderer a string like
 * "var(--color-bg-0)", which nothing downstream can parse.
 */
export function readTerminalAppearance(fontPx?: number | null): TerminalAppearance {
  // Guard for the non-DOM paths (tests, SSR-ish tooling): callers higher up
  // treat an empty object as "no opinion", which is the right default.
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return typeof fontPx === "number" ? { fontPx } : {};
  }
  const style = getComputedStyle(document.documentElement);
  const ansi = ANSI_TOKENS.map((t) => token(style, t) ?? "");
  const out: TerminalAppearance = {
    foreground: token(style, "--term-fg"),
    background: token(style, "--term-bg"),
    cursor: token(style, "--term-cursor"),
    selection: selectionWash(token(style, "--term-selection")),
    // Sent whole only if at least one slot resolved; an all-empty list would
    // be sixteen parse failures the backend has to shrug off one by one.
    ansi: ansi.some((c) => c !== "") ? ansi : undefined,
  };
  if (typeof fontPx === "number" && Number.isFinite(fontPx)) out.fontPx = fontPx;
  return out;
}

/**
 * Push the current appearance to the native terminals.
 *
 * Resolves to the number of live terminals that were told, so a caller can
 * tell "no terminal open" from "the wiring is broken". Rejections are
 * swallowed: this is called from theme-change listeners, where a failed IPC
 * must not break the theme switch itself.
 *
 * The zoom goes along because the GPU terminal is the one surface ⌘+ cannot
 * reach on its own. Everything else in the window is inside the webview, so
 * `setZoom` scales it; the terminal is painted by a sibling surface that is
 * merely *positioned* in window points, which meant zooming in bought a bigger
 * hole full of the same small text. Rust keeps the two factors apart and
 * multiplies, so this and the Appearance pane's text size compose instead of
 * overwriting each other.
 *
 * `scale` stays the device pixel ratio alone. WebKit's page zoom deliberately
 * does not fold into `devicePixelRatio` (see `lib/browserEngine.ts`, where
 * assuming it did made a correction that was always a no-op), so there is no
 * double-counting here.
 */
/** Font size, in CSS pixels, of the last appearance the shell pushed. */
let pushedFontPx: number | null = null;

/**
 * A line's height in CSS pixels, as near as the web side can tell.
 *
 * The exact figure belongs to the glyph atlas in the renderer and never comes
 * back over IPC, so this is the terminal's font size times the ratio the
 * rasteriser uses. It feeds one thing: turning a pixel wheel delta into a
 * number of lines on platforms where the DOM hole is what hears the wheel. On
 * macOS the GPU surface takes the wheel itself and does the conversion against
 * the real metrics, so this is not in that path.
 */
export function estimatedTerminalLineHeightPx(): number {
  const fontPx = pushedFontPx ?? 13;
  return fontPx * 1.2;
}

export async function pushNativeTerminalAppearance(
  fontPx?: number | null,
  zoom: number = webviewZoom(),
): Promise<number> {
  try {
    if (typeof fontPx === "number" && Number.isFinite(fontPx) && fontPx > 0) {
      pushedFontPx = fontPx;
    }
    const appearance = { ...readTerminalAppearance(fontPx), zoom };
    const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    return await invoke<number>("native_term_set_appearance", { appearance, scale });
  } catch {
    return 0;
  }
}

/** The subset of xterm.js's `ITheme` these tokens cover. */
export type XtermTheme = {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
};

/**
 * The same tokens, shaped for xterm.js.
 *
 * `cursorAccent` is the glyph *under* the block cursor, so it takes the
 * background rather than a third color — get it wrong and the character the
 * cursor sits on becomes unreadable instead of inverted.
 */
export function xtermThemeFromTokens(): XtermTheme {
  const a = readTerminalAppearance();
  const ansi = a.ansi ?? [];
  const at = (i: number): string | undefined => {
    const v = ansi[i];
    return v === undefined || v === "" ? undefined : v;
  };
  const theme: XtermTheme = {
    background: a.background,
    foreground: a.foreground,
    cursor: a.cursor,
    cursorAccent: a.background,
    selectionBackground: a.selection,
    black: at(0),
    red: at(1),
    green: at(2),
    yellow: at(3),
    blue: at(4),
    magenta: at(5),
    cyan: at(6),
    white: at(7),
    brightBlack: at(8),
    brightRed: at(9),
    brightGreen: at(10),
    brightYellow: at(11),
    brightBlue: at(12),
    brightMagenta: at(13),
    brightCyan: at(14),
    brightWhite: at(15),
  };
  // xterm treats an explicit `undefined` as "set this to undefined" on a live
  // `term.options.theme` assignment, which blanks a color rather than leaving
  // it alone. Dropping the keys entirely is the only way to say "no opinion".
  for (const k of Object.keys(theme) as (keyof XtermTheme)[]) {
    if (theme[k] === undefined) delete theme[k];
  }
  return theme;
}

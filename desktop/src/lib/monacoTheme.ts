// Shared Monaco theme — an exact GitHub Primer code + diff palette used by every
// Monaco surface (file editor, Trace Changes diff, working-tree diff, PR diff).
// The user supplied a GitHub diff screenshot and asked for "these exact colors
// and feel", so this replicates GitHub Dark Default / Light Default rather than
// deriving from the app tokens: dark #0d1117 canvas, coral keywords, light-blue
// strings, muted line numbers, and the soft green/red diff washes (the 0.15
// line / 0.4 word alpha that GitHub uses, expressed as 8-digit hex so Monaco
// composites them over the canvas).
//
// Why a hex palette here: Monaco paints onto its own canvas and `defineTheme`
// accepts only concrete hex — CSS custom properties never resolve inside the
// editor. Matching an external design spec exactly, this is a deliberate,
// isolated hex palette (the same justified-hex exception as the agent identity
// palette). Call `ensureAuraThemes(monaco)` in `beforeMount`, then set
// `theme={isDark ? AURA_MONACO_DARK : AURA_MONACO_LIGHT}`.

import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

export const AURA_MONACO_DARK = "aura-dark";
export const AURA_MONACO_LIGHT = "aura-light";

// GitHub Dark Default (Primer) — chrome + syntax + diff.
const DARK = {
  bg: "#0d1117",
  fg: "#f0f6fc",
  lineNr: "#6e7681",
  lineNrActive: "#e6edf3",
  gutter: "#0d1117",
  lineHighlight: "#6e768119", // subtle active-line wash
  indent: "#21262d",
  indentActive: "#3b4148",
  selection: "#264f78",
  // syntax (mapped onto Monaco's coarse Monarch token types)
  keyword: "#ff7b72", // import / from / type / interface / const
  string: "#a5d6ff",
  comment: "#8b949e",
  number: "#79c0ff",
  type: "#79c0ff",
  regexp: "#7ee787",
  delimiter: "#c9d1d9",
  tag: "#7ee787",
  attrName: "#79c0ff",
  attrValue: "#a5d6ff",
  // Diff washes — the EXACT GitHub Primer dark `diffBlob` tokens, no adaptation:
  // additionLine .15 / deletionLine .10 (GitHub paints deletions softer than
  // additions), word .40, num-gutter .30. Expressed as #rrggbbaa so Monaco
  // composites them over the #0d1117 canvas. The peripheral overview-ruler
  // markers are calmed off their old neon 0.60 so the surface reads welcoming.
  addLine: "#2ea04326", // additionLine — rgba(46,160,67,.15)
  // Word-level highlight pulled down from Primer's .40 to .24, and the number
  // gutter from .30 to .22. Monaco is the split-diff viewer, so these sit
  // directly beside the hand-rolled inline diffs, which desaturate their
  // markers to ~58%; at Primer's stock alpha the same change read hotter on
  // one side of the screen than the other. Line washes are untouched — they
  // were already the restrained part.
  addWord: "#2ea0433d", // additionWord — rgba(46,160,67,.24)
  delLine: "#f851491a", // deletionLine — rgba(248,81,73,.10)
  delWord: "#f851493d", // deletionWord — rgba(248,81,73,.24)
  addGutter: "#3fb95038", // additionNum — rgba(63,185,80,.22)
  delGutter: "#f8514938", // deletionNum — rgba(248,81,73,.22)
  addOverview: "#3fb95080",
  delOverview: "#f8514980",
  diagonal: "#6e768114",
};

// GitHub Light Default (Primer).
const LIGHT = {
  bg: "#ffffff",
  fg: "#1f2328",
  lineNr: "#8c959f",
  lineNrActive: "#1f2328",
  gutter: "#ffffff",
  lineHighlight: "#eaeef280",
  indent: "#eaeef2",
  indentActive: "#d0d7de",
  selection: "#add6ff",
  keyword: "#cf222e",
  string: "#0a3069",
  comment: "#6e7781",
  number: "#0550ae",
  type: "#0550ae",
  regexp: "#116329",
  delimiter: "#24292f",
  tag: "#116329",
  attrName: "#0550ae",
  attrValue: "#0a3069",
  // EXACT GitHub Primer light `diffBlob` tokens — opaque pastels (GitHub light
  // uses solid colors here, not alpha), so the wash matches github.com exactly.
  addLine: "#dafbe1", // additionLine
  addWord: "#aceebb", // additionWord
  delLine: "#ffebe9", // deletionLine
  delWord: "#ffcecb", // deletionWord
  addGutter: "#aceebb", // additionNum
  delGutter: "#ffcecb", // deletionNum
  addOverview: "#1a7f3780",
  delOverview: "#cf222e80",
  diagonal: "#6e77811f",
};

function buildTheme(isDark: boolean): editor.IStandaloneThemeData {
  const c = isDark ? DARK : LIGHT;
  const hex = (s: string) => s.replace("#", "");
  return {
    base: isDark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "", foreground: hex(c.fg) },
      { token: "comment", foreground: hex(c.comment), fontStyle: "italic" },
      { token: "keyword", foreground: hex(c.keyword) },
      { token: "operator", foreground: hex(c.keyword) },
      { token: "string", foreground: hex(c.string) },
      { token: "string.escape", foreground: hex(c.number) },
      { token: "number", foreground: hex(c.number) },
      { token: "regexp", foreground: hex(c.regexp) },
      { token: "type", foreground: hex(c.type) },
      { token: "type.identifier", foreground: hex(c.type) },
      { token: "delimiter", foreground: hex(c.delimiter) },
      { token: "delimiter.bracket", foreground: hex(c.delimiter) },
      { token: "tag", foreground: hex(c.tag) },
      { token: "attribute.name", foreground: hex(c.attrName) },
      { token: "attribute.value", foreground: hex(c.attrValue) },
      { token: "annotation", foreground: hex(c.keyword) },
    ],
    colors: {
      "editor.background": c.bg,
      "editor.foreground": c.fg,
      "editorLineNumber.foreground": c.lineNr,
      "editorLineNumber.activeForeground": c.lineNrActive,
      "editorGutter.background": c.gutter,
      "editor.lineHighlightBackground": c.lineHighlight,
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": c.selection,
      "editorIndentGuide.background1": c.indent,
      "editorIndentGuide.activeBackground1": c.indentActive,
      "editorWhitespace.foreground": c.indent,
      "editorOverviewRuler.border": "#00000000",
      "editorWidget.background": c.bg,
      "editorWidget.border": c.indent,
      "scrollbarSlider.background": isDark ? "#6e768133" : "#8c959f33",
      "scrollbarSlider.hoverBackground": isDark ? "#6e768155" : "#8c959f55",
      "scrollbarSlider.activeBackground": isDark ? "#6e768177" : "#8c959f77",
      // ── diff palette (exact GitHub washes) ───────────────────────
      "diffEditor.insertedLineBackground": c.addLine,
      "diffEditor.insertedTextBackground": c.addWord,
      "diffEditor.removedLineBackground": c.delLine,
      "diffEditor.removedTextBackground": c.delWord,
      "diffEditorGutter.insertedLineBackground": c.addGutter,
      "diffEditorGutter.removedLineBackground": c.delGutter,
      "diffEditorOverview.insertedForeground": c.addOverview,
      "diffEditorOverview.removedForeground": c.delOverview,
      "diffEditor.diagonalFill": c.diagonal,
      "diffEditor.unchangedRegionBackground": c.bg,
    },
  };
}

/** (Re)define both Aura Monaco themes. Idempotent — cheap to call on every
 *  mount and on every theme/variant change. */
export function ensureAuraThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(AURA_MONACO_DARK, buildTheme(true));
  monaco.editor.defineTheme(AURA_MONACO_LIGHT, buildTheme(false));
}

/** The theme name for a resolved light/dark mode. */
export function auraThemeName(isDark: boolean): string {
  return isDark ? AURA_MONACO_DARK : AURA_MONACO_LIGHT;
}

/** Exact GitHub diff washes for non-Monaco diff renderers (e.g. the unified
 *  table fallback), so every diff surface matches. Values are the same line /
 *  word alphas Monaco uses, as `#rrggbbaa` for CSS. */
export const AURA_DIFF_CSS = {
  dark: { addLine: DARK.addLine, delLine: DARK.delLine, addFg: "#3fb950", delFg: "#f85149" },
  light: { addLine: LIGHT.addLine, delLine: LIGHT.delLine, addFg: "#1a7f37", delFg: "#cf222e" },
} as const;

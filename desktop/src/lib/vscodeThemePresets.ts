// Built-in editor theme presets — a curated starter set so the Editor Themes
// pane is delightful out of the box, before the user hunts down a *.json file.
//
// Each preset is authored as a small VS Code color theme (the natural shape)
// and run through the SAME converter as an imported file, so there is exactly
// one code path: presets and user imports both become `ConvertedTheme`s and
// register in Monaco identically. The token `scope`s are the Monarch token
// names Aura's editor actually emits (comment / keyword / string / number /
// type / …), so the file editor genuinely recolors rather than relying on
// grammar-specific TextMate scopes.
//
// The palettes are well-known published color sets (Dracula, One Dark, Nord,
// Solarized). A palette is a list of hex values — facts, not code — re-authored
// here as compact Monaco themes; this is not a copy of any extension's source.

import { convertVsCodeTheme, type VsCodeColorTheme } from "./vscodeTheme";
import type { ConvertedTheme } from "./vscodeTheme";

type Palette = {
  comment: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  constant: string;
  variable: string;
  tag: string;
  attrName: string;
  func: string;
  regexp: string;
};

// The theme's semantic colour identity — its real ANSI/diagnostic palette, NOT
// its syntax-token roles (a theme's "string" colour is often yellow, not green,
// so deriving UI greens from syntax would misfire). These flow into the
// workbench keys `buildCssVars` mines, so an active preset carries its own
// green / red / amber / blue / violet across the WHOLE app — "brand green and
// all" — not just the editor. Values are the themes' published ANSI palettes.
type Semantic = {
  green: string;
  red: string;
  yellow: string;
  blue: string;
  magenta: string;
};

// The theme's real WORKBENCH surface hexes — the exact panel/widget/border/
// selection colours VS Code paints its chrome with. Without these, the app
// reskin derives the whole surface ladder by lightening `editor.background`,
// which is close but not the genuine article. Supplying the published values
// for the keys `buildCssVars` mines (`sideBar.background` → bg-1, `editorWidget.
// background` → bg-3, `panel.border` → line, `input.background` → composer,
// `badge.background`/`menu.selectionBackground` → pills/selection) makes the
// desktop adopt the theme's EXACT colours, not an approximation — and the same
// keys sharpen Monaco's own find/suggest widgets. `border`/`selection` are
// optional: a theme that genuinely has no distinct value derives one. */
type Chrome = {
  /** sideBar / activityBar / titleBar / panel surface → app chrome (bg-1). */
  chrome: string;
  /** editorWidget / dropdown / menu surface → elevated cards (bg-3). */
  widget: string;
  /** input.background → the composer field. Defaults to `widget`. */
  input?: string;
  /** panel / group / widget border → the hairline. Omit to derive off the canvas. */
  border?: string;
  /** badge / active-selection background → pills, kbd, selected rows. Omit to derive. */
  selection?: string;
};

function chromeColors(c: Chrome): Record<string, string> {
  const input = c.input ?? c.widget;
  const out: Record<string, string> = {
    "sideBar.background": c.chrome,
    "activityBar.background": c.chrome,
    "titleBar.activeBackground": c.chrome,
    "panel.background": c.chrome,
    "editorGroupHeader.tabsBackground": c.chrome,
    "editorWidget.background": c.widget,
    "dropdown.background": c.widget,
    "menu.background": c.widget,
    "editorSuggestWidget.background": c.widget,
    "input.background": input,
  };
  if (c.border) {
    out["panel.border"] = c.border;
    out["editorGroup.border"] = c.border;
    out["sideBar.border"] = c.border;
    out["widget.border"] = c.border;
    out["input.border"] = c.border;
  }
  if (c.selection) {
    out["badge.background"] = c.selection;
    out["button.secondaryBackground"] = c.selection;
    out["keybindingLabel.background"] = c.selection;
    out["menu.selectionBackground"] = c.selection;
    out["list.activeSelectionBackground"] = c.selection;
  }
  return out;
}

function preset(
  name: string,
  type: "dark" | "light",
  bg: string,
  fg: string,
  accent: string,
  p: Palette,
  s: Semantic,
  c: Chrome,
): VsCodeColorTheme {
  return {
    name,
    type,
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      focusBorder: accent,
      "editorLineNumber.foreground": p.comment,
      "editorCursor.foreground": accent,
      // Semantic identity → the exact keys `buildCssVars` reads for the app's
      // brand/semantic tokens, so the whole desktop adopts the theme's palette.
      "terminal.ansiGreen": s.green,
      "gitDecoration.addedResourceForeground": s.green,
      "terminal.ansiRed": s.red,
      "editorError.foreground": s.red,
      "terminal.ansiYellow": s.yellow,
      "editorWarning.foreground": s.yellow,
      "terminal.ansiBlue": s.blue,
      "terminal.ansiMagenta": s.magenta,
      "terminal.ansiBrightMagenta": s.magenta,
      // Real workbench surfaces → the app chrome reskins with EXACT colours.
      ...chromeColors(c),
    },
    tokenColors: [
      { scope: "comment", settings: { foreground: p.comment, fontStyle: "italic" } },
      {
        scope: ["keyword", "operator", "keyword.operator"],
        settings: { foreground: p.keyword },
      },
      {
        scope: ["string", "string.escape", "attribute.value"],
        settings: { foreground: p.string },
      },
      { scope: "number", settings: { foreground: p.number } },
      {
        scope: ["type", "type.identifier", "entity.name.type"],
        settings: { foreground: p.type },
      },
      {
        scope: ["constant", "constant.language", "constant.numeric"],
        settings: { foreground: p.constant },
      },
      { scope: ["variable", "identifier"], settings: { foreground: p.variable } },
      { scope: ["tag", "entity.name.tag"], settings: { foreground: p.tag } },
      {
        scope: ["attribute.name", "entity.other.attribute-name"],
        settings: { foreground: p.attrName },
      },
      {
        scope: ["function", "entity.name.function"],
        settings: { foreground: p.func },
      },
      { scope: "regexp", settings: { foreground: p.regexp } },
      { scope: "delimiter", settings: { foreground: fg } },
    ],
  };
}

const RAW_PRESETS: VsCodeColorTheme[] = [
  // Pure-black OLED themes — `editor.background` is genuine #000000, with the
  // chrome surfaces only a hair off black so the desktop stays truly dark
  // (great on OLED, and what people mean by "pitch black"). Two flavours: a
  // cool arctic-blue accent and a warm amber one.
  preset(
    "Pitch Black",
    "dark",
    "#000000",
    "#e4e4e7",
    "#4da3ff",
    {
      comment: "#6a6a73",
      keyword: "#82aaff",
      string: "#c3e88d",
      number: "#f78c6c",
      type: "#ffcb6b",
      constant: "#f78c6c",
      variable: "#e4e4e7",
      tag: "#f07178",
      attrName: "#c792ea",
      func: "#82aaff",
      regexp: "#89ddff",
    },
    { green: "#c3e88d", red: "#ff5370", yellow: "#ffcb6b", blue: "#82aaff", magenta: "#c792ea" },
    { chrome: "#050505", widget: "#0d0d0f", input: "#0a0a0c", border: "#1c1c20", selection: "#1f1f26" },
  ),
  preset(
    "Pitch Black Amber",
    "dark",
    "#000000",
    "#ece6df",
    "#f5a35a",
    {
      comment: "#6b665e",
      keyword: "#f5a35a",
      string: "#d7c08a",
      number: "#e88c5a",
      type: "#e0c27a",
      constant: "#e88c5a",
      variable: "#ece6df",
      tag: "#e6855e",
      attrName: "#d7b36a",
      func: "#f0b572",
      regexp: "#d7c08a",
    },
    { green: "#a9c97e", red: "#e86b6b", yellow: "#e0c27a", blue: "#7fa6c9", magenta: "#c79ac4" },
    { chrome: "#050403", widget: "#0f0d0a", input: "#0b0a08", border: "#201c17", selection: "#241f18" },
  ),
  preset(
    "Dracula",
    "dark",
    "#282a36",
    "#f8f8f2",
    "#bd93f9",
    {
      comment: "#6272a4",
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      type: "#8be9fd",
      constant: "#bd93f9",
      variable: "#f8f8f2",
      tag: "#ff79c6",
      attrName: "#50fa7b",
      func: "#50fa7b",
      regexp: "#f1fa8c",
    },
    { green: "#50fa7b", red: "#ff5555", yellow: "#f1fa8c", blue: "#8be9fd", magenta: "#ff79c6" },
    { chrome: "#21222c", widget: "#21222c", input: "#21222c", border: "#191a21", selection: "#44475a" },
  ),
  preset(
    "One Dark",
    "dark",
    "#282c34",
    "#abb2bf",
    "#61afef",
    {
      comment: "#5c6370",
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      type: "#e5c07b",
      constant: "#d19a66",
      variable: "#e06c75",
      tag: "#e06c75",
      attrName: "#d19a66",
      func: "#61afef",
      regexp: "#98c379",
    },
    { green: "#98c379", red: "#e06c75", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd" },
    { chrome: "#21252b", widget: "#21252b", input: "#1b1d23", border: "#181a1f", selection: "#3e4451" },
  ),
  preset(
    "Nord",
    "dark",
    "#2e3440",
    "#d8dee9",
    "#88c0d0",
    {
      comment: "#616e88",
      keyword: "#81a1c1",
      string: "#a3be8c",
      number: "#b48ead",
      type: "#8fbcbb",
      constant: "#b48ead",
      variable: "#d8dee9",
      tag: "#81a1c1",
      attrName: "#8fbcbb",
      func: "#88c0d0",
      regexp: "#ebcb8b",
    },
    { green: "#a3be8c", red: "#bf616a", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead" },
    { chrome: "#2e3440", widget: "#3b4252", input: "#3b4252", border: "#3b4252", selection: "#434c5e" },
  ),
  preset(
    "Solarized Dark",
    "dark",
    "#002b36",
    "#839496",
    "#268bd2",
    {
      comment: "#586e75",
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      type: "#b58900",
      constant: "#cb4b16",
      variable: "#268bd2",
      tag: "#268bd2",
      attrName: "#b58900",
      func: "#268bd2",
      regexp: "#2aa198",
    },
    { green: "#859900", red: "#dc322f", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682" },
    { chrome: "#073642", widget: "#073642", border: "#094a5a", selection: "#0a4f5e" },
  ),
  preset(
    "Solarized Light",
    "light",
    "#fdf6e3",
    "#657b83",
    "#268bd2",
    {
      comment: "#93a1a1",
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      type: "#b58900",
      constant: "#cb4b16",
      variable: "#268bd2",
      tag: "#268bd2",
      attrName: "#b58900",
      func: "#268bd2",
      regexp: "#2aa198",
    },
    { green: "#859900", red: "#dc322f", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682" },
    { chrome: "#eee8d5", widget: "#eee8d5", border: "#d9d2bf", selection: "#dcd5c2" },
  ),
];

/** The converted, ready-to-apply preset themes (same shape as a user import). */
export const THEME_PRESETS: ConvertedTheme[] = RAW_PRESETS.map(convertVsCodeTheme);

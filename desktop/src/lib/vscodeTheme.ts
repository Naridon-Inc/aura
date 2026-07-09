// VS Code color-theme importer — the first concrete slice of the "plugins like
// a VS Code extension system" track. A VS Code color theme is a JSONC document
// (`*-color-theme.json`) with two halves we can translate losslessly enough to
// be useful:
//
//   • `colors`      — workbench color keys (`editor.background`, `focusBorder`,
//                     …). These map ONTO Monaco's `colors` map almost 1:1, since
//                     Monaco borrowed VS Code's color-key vocabulary.
//   • `tokenColors` — TextMate grammar rules (`{ scope, settings:{foreground,
//                     fontStyle} }`). Monaco's theme rules match a `token` string
//                     against Monarch token types by dotted-prefix, and the
//                     common top-level TextMate scopes (`comment`, `keyword`,
//                     `string`, `number`, `type`, `variable`, …) line up with
//                     Monarch's tokens, so we forward each scope as a rule token.
//
// This is an honest APPROXIMATION, not a TextMate engine: full per-grammar
// fidelity needs `monaco-textmate` + the language's `.tmLanguage`, which is out
// of scope. The common scopes match, which is what makes an imported theme feel
// like itself. We never execute any theme code — this is pure data parsing.

import type { editor } from "monaco-editor";

// ── Parsed VS Code theme shape (the subset we read) ──────────────────────

export type VsCodeTokenColor = {
  name?: string;
  scope?: string | string[];
  settings?: {
    foreground?: string;
    background?: string;
    fontStyle?: string;
  };
};

export type VsCodeColorTheme = {
  name?: string;
  type?: string; // "dark" | "light" | "hc" | "hcDark" | "hcLight" | …
  colors?: Record<string, string>;
  tokenColors?: VsCodeTokenColor[];
  // `include` (theme inheritance) is intentionally NOT resolved — a pasted /
  // single-file import has no sibling files to read.
  include?: string;
};

export type ConvertedTheme = {
  /** Display name from the theme, or a fallback. */
  name: string;
  /** Resolved light/dark axis — drives Monaco `base` + app scheme pinning. */
  isDark: boolean;
  /** Ready to hand to `monaco.editor.defineTheme`. */
  monaco: editor.IStandaloneThemeData;
  /** Workbench colors mapped to Aura CSS custom properties, for the optional
   *  "apply to whole app" chrome reskin. Always populated; applying is opt-in. */
  cssVars: Record<string, string>;
};

// ── JSONC tolerance ──────────────────────────────────────────────────────
//
// VS Code theme files are JSON-with-comments and frequently carry trailing
// commas. `JSON.parse` rejects both, so strip them first — string-aware so a
// `//` or `,` inside a `"#aabbcc // not a comment"` value survives.

export function stripJsonc(input: string): string {
  let out = "";
  let inStr = false;
  let strQuote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        // copy the escaped char verbatim
        out += next ?? "";
        i++;
      } else if (ch === strQuote) {
        inStr = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  // Drop trailing commas: `,` followed only by whitespace then `}` or `]`.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseVsCodeTheme(text: string): VsCodeColorTheme {
  const obj = JSON.parse(stripJsonc(text));
  if (!obj || typeof obj !== "object") {
    throw new Error("Theme file is not a JSON object.");
  }
  if (!("tokenColors" in obj) && !("colors" in obj)) {
    throw new Error(
      "This doesn't look like a VS Code color theme (no `colors` or `tokenColors`).",
    );
  }
  return obj as VsCodeColorTheme;
}

// ── Color helpers ────────────────────────────────────────────────────────

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True for a `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` string. */
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v.trim());
}

/** Normalize to a 6-digit hex WITHOUT the leading `#`, dropping any alpha —
 *  the form Monaco theme *rules* require (rules don't accept alpha). Returns
 *  null for anything that isn't a hex color. */
export function ruleHex(v: unknown): string | null {
  if (!isHexColor(v)) return null;
  let h = (v as string).trim().slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
  } else {
    h = h.slice(0, 6);
  }
  return h.toLowerCase();
}

/** Relative luminance (0..1) of a hex color, for dark/light inference. */
function luminance(hex: string): number {
  const h = ruleHex(hex);
  if (!h) return 0;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Mix `hex` toward white (amt>0) or black (amt<0) by |amt| (0..1). Returns
 *  `#rrggbb`. Used to derive Aura's bg-1/bg-2 surface shades from a single
 *  editor.background when applying a theme to the app chrome. */
function shade(hex: string, amt: number): string {
  const h = ruleHex(hex) ?? "000000";
  const target = amt >= 0 ? 255 : 0;
  const t = Math.abs(amt);
  const mix = (c: number) => Math.round(c + (target - c) * t);
  const r = mix(parseInt(h.slice(0, 2), 16));
  const g = mix(parseInt(h.slice(2, 4), 16));
  const b = mix(parseInt(h.slice(4, 6), 16));
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** Mix two hex colors: `t=0`→`a`, `t=1`→`b`. Alpha on either input is dropped.
 *  Returns `#rrggbb`. Used to tint an accent toward the surface for the
 *  soft-accent / avatar backdrops so they read as "accent-coloured", not flat. */
function mix(aHex: string, bHex: string, t: number): string {
  const a = ruleHex(aHex) ?? "000000";
  const b = ruleHex(bHex) ?? "000000";
  const ch = (i: number) => {
    const av = parseInt(a.slice(i, i + 2), 16);
    const bv = parseInt(b.slice(i, i + 2), 16);
    return Math.round(av + (bv - av) * t);
  };
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(ch(0))}${to2(ch(2))}${to2(ch(4))}`;
}

/** True only for an OPAQUE hex (`#rgb` / `#rrggbb`) — no alpha channel. Surface
 *  roles (backgrounds) must be opaque: a translucent VS Code overlay like
 *  `list.hoverBackground` would become a solid wall of its own colour once we
 *  flatten away the alpha, so we refuse those for surface picks. */
function solidHex(v: unknown): boolean {
  if (!isHexColor(v)) return false;
  const body = (v as string).trim().slice(1);
  return body.length === 3 || body.length === 6;
}

// ── Conversion ───────────────────────────────────────────────────────────

function resolveIsDark(theme: VsCodeColorTheme): boolean {
  const t = (theme.type ?? "").toLowerCase();
  if (t === "light" || t === "hclight" || t === "hc-light") return false;
  if (t === "dark" || t === "hc" || t === "hcdark" || t === "hc-black") {
    return true;
  }
  // No usable `type` — infer from the editor background luminance.
  const bg = theme.colors?.["editor.background"];
  if (isHexColor(bg)) return luminance(bg!) < 0.5;
  return true;
}

/** The full set of Aura shell tokens an imported VS Code theme drives. Exported
 *  so the chrome-applier (`vscodeThemesStore`) stays in lockstep — every key here
 *  is set when a theme is applied and removed when it's cleared. Two brand tokens
 *  are deliberately ABSENT: `--color-caret-orange` (the Anthropic agent monogram)
 *  and `--color-ai-pink` (the AI-action pill). Those are fixed brand marks that
 *  must not drift with the editor theme, so `buildCssVars` never emits them and
 *  the cascade keeps their @theme defaults. */
export const CHROME_VAR_KEYS = [
  "--color-bg-0",
  "--color-bg-1",
  "--color-bg-2",
  "--color-bg-3",
  "--color-bg-layer-3",
  "--color-text-1",
  "--color-text-2",
  "--color-text-3",
  "--color-text-4",
  "--color-text-5",
  "--color-line",
  "--color-line-soft",
  "--color-accent",
  "--color-accent-soft",
  "--color-accent-green",
  "--color-amber",
  "--color-red",
  "--color-violet",
  "--color-blue",
  "--color-pink",
  "--color-green",
  "--color-composer-bg",
  "--color-composer-border",
  "--color-composer-border-focus",
  "--color-pill-bg",
  "--color-pill-bg-hover",
  "--color-pill-fg",
  "--color-kbd-bg",
  "--color-kbd-fg",
  "--color-popover-bg",
  "--color-popover-border",
  "--color-popover-row-hover",
  "--color-avatar-bg",
  "--color-avatar-fg",
] as const;

/** VS Code workbench colors → Aura's FULL shell token vocabulary. The point is
 *  that an imported theme retones the *whole desktop*, not just the editor: the
 *  surface ladder derives from `editor.background`; the text ramp from
 *  `editor.foreground`; and — crucially — the brand/semantic family (green,
 *  amber, red, violet, blue, pink) is mined from the theme's git-decoration,
 *  diagnostic and terminal-ANSI keys so "brand green and all" carries across
 *  every Aura surface. The smaller widget roles (composer / pill / kbd / popover
 *  / avatar) prefer the matching VS Code widget key, then fall back to the
 *  derived ladder so nothing is ever left on Aura's default tone. Every value is
 *  flattened to an opaque `#rrggbb`; missing keys fall back so nothing is unset.
 *
 *  The shadcn + role aliases in `styles.css` (`--color-primary`, `--color-card`,
 *  `--color-sidebar-*`, `--color-bg-card`, …) are all `var(--color-…)` refs to
 *  these base tokens, so overriding the base set inline on `<html>` cascades to
 *  every primitive without us enumerating them here. */
function buildCssVars(
  colors: Record<string, string>,
  isDark: boolean,
): Record<string, string> {
  // Drop any alpha and normalize to #rrggbb — every shell token must be opaque.
  const norm = (v: string): string => `#${ruleHex(v) ?? "000000"}`;
  /** First key whose value is any hex colour, normalized; else the (already
   *  #rrggbb) fallback. For foreground / accent roles, where sources are solid. */
  const pick = (keys: string[], fallback: string): string => {
    for (const k of keys) if (isHexColor(colors[k])) return norm(colors[k]!);
    return fallback;
  };
  /** Like `pick`, but only OPAQUE source keys — for surface roles, so a
   *  translucent VS Code overlay never becomes a solid wall of its own colour. */
  const pickSolid = (keys: string[], fallback: string): string => {
    for (const k of keys) if (solidHex(colors[k])) return norm(colors[k]!);
    return fallback;
  };

  const bg = pickSolid(["editor.background"], isDark ? "#1e1e1e" : "#ffffff");
  const fg = pick(["editor.foreground"], isDark ? "#d4d4d4" : "#1f2328");
  // In a dark theme the chrome/panels step LIGHTER than the editor canvas (VS
  // Code's own convention); in a light theme they step darker. `dir` carries
  // that direction so every derived shade moves the right way.
  const dir = isDark ? 1 : -1;

  // Surface ladder — prefer the theme's real panel tones where opaque, else
  // derive a coherent shade off the canvas so the ladder never breaks.
  const bg1 = pickSolid(
    ["sideBar.background", "activityBar.background", "titleBar.activeBackground"],
    shade(bg, dir * 0.04),
  );
  const bg2 = shade(bg, dir * 0.08);
  const bg3 = pickSolid(
    [
      "editorWidget.background",
      "dropdown.background",
      "editorGroupHeader.tabsBackground",
      "panel.background",
    ],
    shade(bg, dir * 0.13),
  );
  const bgLayer3 = shade(bg3, dir * 0.06);

  // Text ramp off the editor foreground — dim toward the canvas as the tier
  // drops, mirroring Aura's own 1→5 ladder.
  const text2 = shade(fg, isDark ? -0.18 : 0.18);
  const text3 = shade(fg, isDark ? -0.34 : 0.34);
  const text4 = shade(fg, isDark ? -0.5 : 0.5);
  const text5 = shade(fg, isDark ? -0.68 : 0.68);

  const line = pickSolid(
    [
      "panel.border",
      "editorGroup.border",
      "sideBar.border",
      "widget.border",
      "contrastBorder",
    ],
    shade(bg, dir * 0.12),
  );
  const lineSoft = shade(line, isDark ? -0.3 : 0.3);

  // Accent + the brand/semantic family. Mine git-decoration, diagnostic and
  // terminal-ANSI keys so brand-green, error-red, warning-amber and the diff
  // colours all carry through — that's what makes a theme feel like itself.
  const accent = pick(
    [
      "focusBorder",
      "button.background",
      "textLink.foreground",
      "activityBarBadge.background",
      "progressBar.background",
    ],
    isDark ? "#3794ff" : "#0969da",
  );
  const accentGreen = pick(
    [
      "gitDecoration.addedResourceForeground",
      "terminal.ansiGreen",
      "testing.iconPassed",
      "charts.green",
      "minimapGutter.addedBackground",
    ],
    "#4dc1a4",
  );
  const green = pick(
    ["terminal.ansiGreen", "gitDecoration.addedResourceForeground", "charts.green"],
    accentGreen,
  );
  const amber = pick(
    [
      "gitDecoration.modifiedResourceForeground",
      "editorWarning.foreground",
      "terminal.ansiYellow",
      "list.warningForeground",
      "charts.yellow",
    ],
    "#7eb6c8",
  );
  const red = pick(
    [
      "editorError.foreground",
      "errorForeground",
      "gitDecoration.deletedResourceForeground",
      "terminal.ansiRed",
      "charts.red",
    ],
    "#d05a76",
  );
  const violet = pick(
    ["terminal.ansiMagenta", "charts.purple", "terminal.ansiBrightMagenta"],
    "#a78bfa",
  );
  const blue = pick(
    ["terminal.ansiBlue", "charts.blue", "textLink.foreground"],
    "#78a6df",
  );
  const pink = pick(
    ["terminal.ansiBrightMagenta", "terminal.ansiMagenta"],
    "#c4a4e8",
  );
  const accentSoft = mix(accent, bg, 0.85); // mostly canvas, a wash of accent

  // Smaller widget roles — prefer the matching VS Code key, then the ladder.
  const composerBg = pickSolid(["input.background", "editorWidget.background"], bg3);
  const composerBorder = pickSolid(
    ["input.border", "editorWidget.border", "widget.border"],
    line,
  );
  const composerBorderFocus = pick(
    ["focusBorder"],
    mix(accent, composerBorder, 0.5),
  );

  const pillBg = pickSolid(["badge.background", "button.secondaryBackground"], bg2);
  const pillFg = pick(["badge.foreground", "button.secondaryForeground"], text2);

  const kbdBg = pickSolid(["keybindingLabel.background", "badge.background"], bg2);
  const kbdFg = pick(["keybindingLabel.foreground", "badge.foreground"], text2);

  const popoverBg = pickSolid(
    [
      "menu.background",
      "dropdown.background",
      "editorWidget.background",
      "editorSuggestWidget.background",
    ],
    bg2,
  );
  const popoverBorder = pickSolid(
    [
      "menu.border",
      "dropdown.border",
      "editorWidget.border",
      "editorSuggestWidget.border",
    ],
    line,
  );
  const popoverRowHover = pickSolid(
    [
      "menu.selectionBackground",
      "list.activeSelectionBackground",
      "editorSuggestWidget.selectedBackground",
    ],
    shade(popoverBg, dir * 0.06),
  );

  return {
    "--color-bg-0": bg,
    "--color-bg-1": bg1,
    "--color-bg-2": bg2,
    "--color-bg-3": bg3,
    "--color-bg-layer-3": bgLayer3,
    "--color-text-1": fg,
    "--color-text-2": text2,
    "--color-text-3": text3,
    "--color-text-4": text4,
    "--color-text-5": text5,
    "--color-line": line,
    "--color-line-soft": lineSoft,
    "--color-accent": accent,
    "--color-accent-soft": accentSoft,
    "--color-accent-green": accentGreen,
    "--color-amber": amber,
    "--color-red": red,
    "--color-violet": violet,
    "--color-blue": blue,
    "--color-pink": pink,
    "--color-green": green,
    "--color-composer-bg": composerBg,
    "--color-composer-border": composerBorder,
    "--color-composer-border-focus": composerBorderFocus,
    "--color-pill-bg": pillBg,
    "--color-pill-bg-hover": shade(pillBg, dir * 0.06),
    "--color-pill-fg": pillFg,
    "--color-kbd-bg": kbdBg,
    "--color-kbd-fg": kbdFg,
    "--color-popover-bg": popoverBg,
    "--color-popover-border": popoverBorder,
    "--color-popover-row-hover": popoverRowHover,
    "--color-avatar-bg": mix(accent, bg, 0.72),
    "--color-avatar-fg": accent,
  };
}

export function convertVsCodeTheme(theme: VsCodeColorTheme): ConvertedTheme {
  const isDark = resolveIsDark(theme);
  const srcColors = theme.colors ?? {};

  // Monaco `colors`: forward every workbench key whose value is a valid hex
  // color (Monaco ignores keys it doesn't recognize, but throws on a malformed
  // VALUE — so we filter values, not keys). Guarantee bg/fg so the editor is
  // never left on the inherited base canvas.
  const colors: Record<string, string> = {};
  for (const [k, v] of Object.entries(srcColors)) {
    if (isHexColor(v)) colors[k] = (v as string).trim();
  }
  if (!colors["editor.background"]) {
    colors["editor.background"] = isDark ? "#1e1e1e" : "#ffffff";
  }
  if (!colors["editor.foreground"]) {
    colors["editor.foreground"] = isDark ? "#d4d4d4" : "#1f2328";
  }

  // Monaco rules from TextMate tokenColors.
  const rules: editor.ITokenThemeRule[] = [];
  for (const tc of theme.tokenColors ?? []) {
    const settings = tc.settings ?? {};
    const fg = ruleHex(settings.foreground);
    const bg = ruleHex(settings.background);
    const fontStyle = settings.fontStyle; // may be "", "italic bold", undefined
    const scopes =
      typeof tc.scope === "string"
        ? tc.scope.split(",").map((s) => s.trim())
        : Array.isArray(tc.scope)
          ? tc.scope
          : [];
    if (scopes.length === 0) {
      // Global settings entry — sets the base editor foreground.
      if (fg) {
        rules.push({ token: "", foreground: fg });
      }
      continue;
    }
    for (const scope of scopes) {
      if (!scope) continue;
      const rule: editor.ITokenThemeRule = { token: scope };
      if (fg) rule.foreground = fg;
      if (bg) rule.background = bg;
      if (fontStyle !== undefined) rule.fontStyle = fontStyle;
      if (rule.foreground || rule.background || rule.fontStyle !== undefined) {
        rules.push(rule);
      }
    }
  }

  const monaco: editor.IStandaloneThemeData = {
    base: isDark ? "vs-dark" : "vs",
    inherit: true,
    rules,
    colors,
  };

  return {
    name: theme.name?.trim() || "Imported theme",
    isDark,
    monaco,
    cssVars: buildCssVars(colors, isDark),
  };
}

/** One-shot: raw text → converted theme. Throws a friendly Error on bad input. */
export function importVsCodeThemeText(text: string): ConvertedTheme {
  return convertVsCodeTheme(parseVsCodeTheme(text));
}

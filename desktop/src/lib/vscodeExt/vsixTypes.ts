// Shared types for VS Code extension support (Tier 0 — declarative content only).
//
// Two families live here:
//   1. The records the Rust side returns over IPC (mirrors of the serde structs
//      in `src-tauri/src/cmd_vsix/model.rs`, camelCase to match `rename_all`).
//   2. The slices of a `.vsix`'s `extension/package.json` the frontend router
//      reads to apply themes / language-configuration / snippets to Monaco.
//
// No extension CODE is represented or executed anywhere — only its declarative
// `contributes` is consumed.

import type { ConvertedTheme } from "../vscodeTheme";

// ── IPC records (mirror cmd_vsix::model) ─────────────────────────────────────

/** How many of each declarative contribution an extension carries, plus the
 *  signals for the *other* VS Code extension kinds Aura detects but can't run
 *  yet. Mirrors the serde struct in `cmd_vsix/model.rs` (camelCase). The
 *  not-yet-runnable fields are optional so an older install index still reads. */
export type ContributesSummary = {
  themes: number;
  languages: number;
  grammars: number;
  snippets: number;
  iconThemes: number;
  commands: number;
  /** Node entry (`main`) — wants a desktop host Tier 0 does not provide. */
  hasMain: boolean;
  /** Web entry (`browser`) — runnable in a Web-Worker host (Tier 1). */
  hasBrowser: boolean;

  // ── The other extension kinds — detected, not yet runnable (Phases B–D) ────
  /** Node `main` + declared languages/grammars → needs a language server. */
  isLanguageServer?: boolean;
  /** `contributes.views[]` total — tree/list views in a side panel. */
  views?: number;
  /** `contributes.viewsContainers` present (activity-bar / panel containers). */
  viewsContainers?: boolean;
  /** `contributes.customEditors[]` count — custom document editors. */
  customEditors?: number;
  /** `contributes.webviews` present — webview panel contributions. */
  webviews?: boolean;
  /** `contributes.debuggers[]` count — debug adapters. */
  debuggers?: number;
};

/** One installed VS Code extension as Aura records it on disk. */
export type InstalledExtension = {
  /** `<namespace>.<name>` — the canonical VS Code extension id. */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  /** Absolute path to the extracted bundle root (contains `extension/`). */
  installDir: string;
  /** When false, the contributes router skips this extension entirely. */
  enabled: boolean;
  contributes: ContributesSummary;
  /** Path (relative to the package root) to the extension's icon, if any. */
  icon: string | null;
  installedAt: number;
};

/** A single Open VSX search hit — listing metadata only, never code. */
export type OpenVsxHit = {
  namespace: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  downloadCount: number;
  averageRating: number | null;
  iconUrl: string | null;
  timestamp: string | null;
};

// ── package.json `contributes` slices the router reads ───────────────────────

/** A `contributes.themes[]` entry. `path` points at the theme JSON. */
export type VsThemeContribution = {
  label?: string;
  uiTheme?: string;
  path?: string;
};

/** A `contributes.languages[]` entry. `configuration` points at a
 *  language-configuration.json the router translates to Monaco's shape. */
export type VsLanguageContribution = {
  id?: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  configuration?: string;
};

/** A `contributes.grammars[]` entry — consumed by the TextMate engine (Tier C),
 *  counted but not applied here. */
export type VsGrammarContribution = {
  language?: string;
  scopeName?: string;
  path?: string;
};

/** A `contributes.snippets[]` entry. `path` points at a VS Code snippet file. */
export type VsSnippetContribution = {
  language?: string;
  path?: string;
};

export type VsContributes = {
  themes?: VsThemeContribution[];
  languages?: VsLanguageContribution[];
  grammars?: VsGrammarContribution[];
  snippets?: VsSnippetContribution[];
};

export type VsManifest = {
  contributes?: VsContributes;
};

// ── language-configuration.json (the subset Monaco understands) ──────────────
//
// VS Code writes regexes either as a plain string or as `{ pattern, flags }`.
// `autoClosingPairs` entries are either a `[open, close]` tuple or an object.

export type VsRegexSource = string | { pattern: string; flags?: string };

export type VsAutoClosingPair =
  | [string, string]
  | { open: string; close: string; notIn?: string[] };

export type VsLanguageConfiguration = {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: VsAutoClosingPair[];
  surroundingPairs?: VsAutoClosingPair[];
  wordPattern?: VsRegexSource;
  folding?: { markers?: { start: VsRegexSource; end: VsRegexSource } };
  indentationRules?: {
    increaseIndentPattern?: VsRegexSource;
    decreaseIndentPattern?: VsRegexSource;
  };
};

// ── VS Code snippet file ─────────────────────────────────────────────────────
//
// `{ "For Loop": { "prefix": "for", "body": ["for (...) {", "\t$0", "}"],
//    "description": "…" } }`. `prefix` and `body` may each be a string or array.

export type VsSnippet = {
  prefix?: string | string[];
  body?: string | string[];
  description?: string;
};

export type VsSnippetFile = Record<string, VsSnippet>;

/** A theme an installed extension contributes, registered with Monaco and
 *  offered to the user by the Extensions surface. */
export type ExtensionTheme = {
  /** Owning extension id. */
  extId: string;
  /** Owning extension's display name, for grouping in the picker. */
  extName: string;
  /** The theme's own label from its `contributes.themes[]` entry. */
  label: string;
  /** The Monaco theme name it was defined under (`vsext:<extId>:<slug>`). */
  themeName: string;
  isDark: boolean;
  /** The fully-converted theme (Monaco data + derived CSS vars). Carried so the
   *  Editor-Themes picker can adopt it into the user's theme library without
   *  re-reading and re-parsing the extension's JSON. */
  converted: ConvertedTheme;
};

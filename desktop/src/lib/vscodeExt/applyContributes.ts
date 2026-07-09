// Apply enabled extensions' declarative `contributes` to Monaco.
//
// This is Tier 0: we read an extension's `extension/package.json` and the asset
// files it points at, and wire the *data* into Monaco — themes, language
// configuration, and snippets. No extension code is fetched or executed.
//
//   themes   → convert the VS Code theme JSON and `monaco.editor.defineTheme`
//              under a deterministic name; record it so the picker can offer it.
//   languages→ `monaco.languages.register` + `setLanguageConfiguration`
//              (comments / brackets / auto-closing / surrounding / folding /
//              word-pattern / indentation). Only for languages Monaco doesn't
//              already know — we never clobber a built-in's richer config.
//   snippets → a completion provider per language, fed from the enabled set.
//   grammars → real TextMate tokenizing via `textmateEngine` (vscode-textmate +
//              vscode-oniguruma WASM), attached only to languages we newly
//              registered, so a contributed language gets genuine syntax
//              highlighting instead of plain text.
//
// Idempotent per Monaco instance: a signature of the enabled set gates the work
// so repeated editor mounts don't re-route, and an in-flight guard collapses
// concurrent first mounts. When the enabled set changes the router rebuilds the
// theme registry and snippet map from scratch so disabling an extension drops
// its contributions.

import type { Monaco } from "@monaco-editor/react";
import type { editor, languages, Position } from "monaco-editor";

import { api } from "../api";
import {
  registerGrammarSource,
  resetGrammarSources,
  wireExtensionGrammars,
} from "./textmateEngine";
import { importVsCodeThemeText, stripJsonc } from "../vscodeTheme";
import {
  clearExtensionThemes,
  ensureInstalledLoaded,
  getEnabledExtensions,
  getExtensionThemes,
  registerExtensionTheme,
} from "./vsixStore";
import type {
  InstalledExtension,
  VsLanguageConfiguration,
  VsManifest,
  VsRegexSource,
  VsSnippetFile,
} from "./vsixTypes";

// Per-instance guards. Monaco is effectively a singleton from the loader, but
// keying on the instance keeps this correct if that ever changes.
const appliedSig = new WeakMap<Monaco, string>();
const inFlight = new WeakMap<Monaco, Promise<void>>();
// Set when the enabled set changes mid-apply, so the in-flight run re-runs once
// against the new set instead of swallowing the change (mirrors reconcile()).
const applyQueued = new WeakMap<Monaco, boolean>();
const completionLangs = new WeakMap<Monaco, Set<string>>();
const registeredLangs = new WeakMap<Monaco, Set<string>>();
// Languages *we* registered (never Monaco built-ins), accumulated across passes.
// Once a language is ours it stays ours — Monaco has no unregister — so a
// contributed grammar may always re-tokenize it. The authority for which
// languages the TextMate engine is allowed to attach to.
const ourLangs = new WeakMap<Monaco, Set<string>>();

// The extension-theme registry is a single global (not per-Monaco): a theme is
// the same data whichever editor renders it, and the Settings picker reads it
// without any Monaco at all. So its load is guarded by a module-level signature
// + in-flight promise rather than a WeakMap.
let themeSig = "";
let themeInFlight: Promise<void> | null = null;
// Same guard for the global theme load: a disable/remove that lands mid-load
// schedules one more pass so the picker never reflects a stale enabled set.
let themeQueued = false;

// Snippets contributed by the enabled set, keyed by Monaco language id. Rebuilt
// on every signature change; the completion providers (registered once per
// language) read this live so re-applying refreshes their output.
type SnippetEntry = { label: string; insertText: string; documentation?: string };
const snippetsByLang = new Map<string, SnippetEntry[]>();

function enabledSignature(exts: InstalledExtension[]): string {
  return exts
    .map((e) => `${e.id}@${e.version}`)
    .sort()
    .join(",");
}

/** Load every enabled extension's contributed color themes into the global
 *  registry — WITHOUT any Monaco. Pure data: read each manifest, convert each
 *  theme file, and record the result (with its converted payload) so the
 *  Editor-Themes picker can list and adopt it even if no code editor has
 *  mounted yet. Signature-guarded + in-flight-collapsed so repeated calls (the
 *  Settings tab + every editor mount) are cheap; rebuilds from scratch when the
 *  enabled set changes so a disable/remove drops the theme. */
export async function ensureExtensionThemesLoaded(): Promise<void> {
  // A call arriving mid-load may reflect a newer enabled set; mark it so the
  // running pass re-runs once on completion rather than swallowing the change.
  if (themeInFlight) {
    themeQueued = true;
    return themeInFlight;
  }

  const p = (async () => {
    await ensureInstalledLoaded();
    const enabled = getEnabledExtensions();
    const sig = enabledSignature(enabled);
    if (themeSig === sig) return;

    clearExtensionThemes();
    for (const ext of enabled) {
      try {
        const raw = await api.vsixReadText(ext.id, "package.json");
        const manifest = JSON.parse(stripJsonc(raw)) as VsManifest;
        for (const t of manifest.contributes?.themes ?? []) {
          if (!t.path) continue;
          try {
            const text = await api.vsixReadText(ext.id, t.path);
            const converted = importVsCodeThemeText(text);
            const label = t.label?.trim() || converted.name;
            registerExtensionTheme({
              extId: ext.id,
              extName: ext.displayName,
              label,
              themeName: `vsext:${ext.id}:${themeSlug(label)}`,
              isDark: converted.isDark,
              converted,
            });
          } catch {
            // Not a usable color theme — skip just this one.
          }
        }
      } catch {
        // Unreadable manifest — skip this extension's themes.
      }
    }
    themeSig = sig;
  })().finally(() => {
    themeInFlight = null;
    if (themeQueued) {
      themeQueued = false;
      void ensureExtensionThemesLoaded();
    }
  });

  themeInFlight = p;
  return p;
}

/** Apply the currently-enabled extensions to a Monaco instance. Cheap to call
 *  on every editor mount: the signature guard skips redundant work and the
 *  installed list is cached after the first read. */
export async function applyInstalledExtensions(monaco: Monaco): Promise<void> {
  const existing = inFlight.get(monaco);
  if (existing) {
    // Enabled set may have changed since this run started — re-run once after.
    applyQueued.set(monaco, true);
    return existing;
  }

  const p = (async () => {
    // Themes first (Monaco-free load), then define each on this instance —
    // idempotent, so a second editor or a re-mount just re-points the names.
    await ensureExtensionThemesLoaded();
    for (const t of getExtensionThemes()) {
      try {
        monaco.editor.defineTheme(t.themeName, t.converted.monaco);
      } catch {
        // Malformed theme data — skip just this one.
      }
    }

    const enabled = getEnabledExtensions();
    const sig = enabledSignature(enabled);
    if (appliedSig.get(monaco) === sig) return;

    // Rebuild the language/snippet wiring the enabled set fully owns, so a
    // disable/remove drops the contribution instead of leaving it stranded.
    snippetsByLang.clear();
    resetGrammarSources();

    let mine = ourLangs.get(monaco);
    if (!mine) {
      mine = new Set<string>();
      ourLangs.set(monaco, mine);
    }
    for (const ext of enabled) {
      try {
        await routeExtension(monaco, ext, mine);
      } catch {
        // A single malformed extension must not break the others or the editor.
      }
    }
    // Now that every grammar source is recorded and our languages registered,
    // attach the real TextMate tokenizers (and drop any whose extension was just
    // disabled). Loads the WASM engine lazily — and only if some enabled
    // extension actually contributed a grammar.
    await wireExtensionGrammars(monaco, mine);
    appliedSig.set(monaco, sig);
  })().finally(() => {
    inFlight.delete(monaco);
    if (applyQueued.get(monaco)) {
      applyQueued.delete(monaco);
      void applyInstalledExtensions(monaco);
    }
  });

  inFlight.set(monaco, p);
  return p;
}

// Languages + snippets + grammar sources — themes are handled by
// ensureExtensionThemesLoaded; grammars are wired (engine) after the full pass.
async function routeExtension(
  monaco: Monaco,
  ext: InstalledExtension,
  ours: Set<string>,
): Promise<void> {
  const raw = await api.vsixReadText(ext.id, "package.json");
  const manifest = JSON.parse(stripJsonc(raw)) as VsManifest;
  const c = manifest.contributes;
  if (!c) return;

  for (const lang of c.languages ?? []) {
    const id = lang.id?.trim();
    if (!id) continue;
    try {
      await routeLanguage(monaco, ext, id, lang.configuration, ours, {
        extensions: lang.extensions,
        aliases: lang.aliases,
        filenames: lang.filenames,
      });
    } catch {
      // Bad language-configuration JSON — skip this language.
    }
  }

  // Record each grammar as a tokenizable source. The TextMate engine reads the
  // file lazily when it wires the language after this pass.
  for (const g of c.grammars ?? []) {
    registerGrammarSource(ext.id, g);
  }

  for (const snip of c.snippets ?? []) {
    const language = snip.language?.trim();
    if (!language || !snip.path) continue;
    try {
      const text = await api.vsixReadText(ext.id, snip.path);
      const file = JSON.parse(stripJsonc(text)) as VsSnippetFile;
      ingestSnippets(language, file);
      ensureCompletionProvider(monaco, language);
    } catch {
      // Malformed snippet file — skip it.
    }
  }
}

// ── Languages ────────────────────────────────────────────────────────────────

async function routeLanguage(
  monaco: Monaco,
  ext: InstalledExtension,
  id: string,
  configuration: string | undefined,
  ours: Set<string>,
  meta: { extensions?: string[]; aliases?: string[]; filenames?: string[] },
): Promise<void> {
  let langs = registeredLangs.get(monaco);
  if (!langs) {
    langs = new Set<string>();
    registeredLangs.set(monaco, langs);
  }
  // Seen before: if it's a language we registered, it stays ours to tokenize
  // (the persistent `ours` set is the authority — built-ins were never added).
  if (langs.has(id)) return;

  // Never override a language Monaco already ships (built-ins carry far richer
  // tokenizers + config than a single language-configuration.json provides).
  const known = monaco.languages
    .getLanguages()
    .some((l: languages.ILanguageExtensionPoint) => l.id === id);
  if (known) {
    langs.add(id);
    return;
  }

  monaco.languages.register({
    id,
    extensions: meta.extensions,
    aliases: meta.aliases,
    filenames: meta.filenames,
  });
  langs.add(id);
  ours.add(id);

  if (configuration) {
    const text = await api.vsixReadText(ext.id, configuration);
    const cfg = JSON.parse(stripJsonc(text)) as VsLanguageConfiguration;
    monaco.languages.setLanguageConfiguration(id, convertLanguageConfig(cfg));
  }
}

/** A VS Code regex source (string or `{ pattern, flags }`) → RegExp, dropping
 *  anything that doesn't compile rather than throwing into the editor. */
function toRegex(src: VsRegexSource | undefined): RegExp | undefined {
  if (src === undefined) return undefined;
  try {
    if (typeof src === "string") return new RegExp(src);
    if (src && typeof src === "object" && typeof src.pattern === "string") {
      return new RegExp(src.pattern, src.flags);
    }
  } catch {
    // Extension shipped an invalid / non-JS regex — ignore that field.
  }
  return undefined;
}

function normalizePair(
  p: [string, string] | { open: string; close: string; notIn?: string[] },
): languages.IAutoClosingPairConditional | null {
  if (Array.isArray(p)) {
    if (p.length < 2) return null;
    return { open: p[0], close: p[1] };
  }
  if (p && typeof p.open === "string" && typeof p.close === "string") {
    return p.notIn
      ? { open: p.open, close: p.close, notIn: p.notIn }
      : { open: p.open, close: p.close };
  }
  return null;
}

function convertLanguageConfig(
  raw: VsLanguageConfiguration,
): languages.LanguageConfiguration {
  const cfg: languages.LanguageConfiguration = {};
  if (raw.comments) cfg.comments = raw.comments;
  if (Array.isArray(raw.brackets)) cfg.brackets = raw.brackets;
  if (Array.isArray(raw.autoClosingPairs)) {
    cfg.autoClosingPairs = raw.autoClosingPairs
      .map(normalizePair)
      .filter((x): x is languages.IAutoClosingPairConditional => x !== null);
  }
  if (Array.isArray(raw.surroundingPairs)) {
    cfg.surroundingPairs = raw.surroundingPairs
      .map(normalizePair)
      .filter((x): x is languages.IAutoClosingPair => x !== null);
  }
  const wordPattern = toRegex(raw.wordPattern);
  if (wordPattern) cfg.wordPattern = wordPattern;
  if (raw.folding?.markers) {
    const start = toRegex(raw.folding.markers.start);
    const end = toRegex(raw.folding.markers.end);
    if (start && end) cfg.folding = { markers: { start, end } };
  }
  if (raw.indentationRules) {
    const inc = toRegex(raw.indentationRules.increaseIndentPattern);
    const dec = toRegex(raw.indentationRules.decreaseIndentPattern);
    if (inc && dec) {
      cfg.indentationRules = {
        increaseIndentPattern: inc,
        decreaseIndentPattern: dec,
      };
    }
  }
  return cfg;
}

// ── Snippets ─────────────────────────────────────────────────────────────────

function ingestSnippets(language: string, file: VsSnippetFile): void {
  const bucket = snippetsByLang.get(language) ?? [];
  for (const [name, snip] of Object.entries(file)) {
    if (!snip || typeof snip !== "object") continue;
    const body = Array.isArray(snip.body)
      ? snip.body.join("\n")
      : typeof snip.body === "string"
        ? snip.body
        : "";
    if (!body) continue;
    const prefixes = Array.isArray(snip.prefix)
      ? snip.prefix
      : typeof snip.prefix === "string"
        ? [snip.prefix]
        : [name];
    for (const prefix of prefixes) {
      if (!prefix) continue;
      bucket.push({
        label: prefix,
        insertText: body,
        documentation: snip.description ?? name,
      });
    }
  }
  snippetsByLang.set(language, bucket);
}

function ensureCompletionProvider(monaco: Monaco, language: string): void {
  let provided = completionLangs.get(monaco);
  if (!provided) {
    provided = new Set<string>();
    completionLangs.set(monaco, provided);
  }
  if (provided.has(language)) return;
  provided.add(language);

  monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems(model: editor.ITextModel, position: Position) {
      const entries = snippetsByLang.get(language);
      if (!entries || entries.length === 0) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions: languages.CompletionItem[] = entries.map((e) => ({
        label: e.label,
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: e.insertText,
        insertTextRules:
          monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        documentation: e.documentation,
        range,
      }));
      return { suggestions };
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function themeSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "theme"
  );
}

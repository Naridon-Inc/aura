// The TextMate grammar engine — real syntax highlighting in Monaco for the
// languages an installed extension brings.
//
// This is what finally makes a *language* extension genuinely work here, not
// just register a name: a `.tmLanguage.json` grammar is the same data VS Code
// itself tokenizes with, and we run it with the same two Microsoft libraries VS
// Code uses — `vscode-oniguruma` (the regex engine, compiled to WebAssembly) and
// `vscode-textmate` (the grammar interpreter). No extension *code* runs; a
// grammar is declarative rules, executed by our engine, not the extension's.
//
// How it threads into Monaco:
//   • One global oniguruma WASM load + one `vscode-textmate` Registry for the
//     whole app (a grammar is the same wherever it tokenizes).
//   • `applyContributes` calls `registerGrammarSource` as it parses each enabled
//     extension's manifest, recording scope → file. `wireExtensionGrammars` then
//     loads each grammar and attaches a Monaco tokens provider.
//   • The provider hands Monaco the token's most-specific TextMate scope as the
//     token type; Monaco's active theme colours it by longest-scope-prefix —
//     exactly how the VS Code colour themes we already import are keyed. So a
//     contributed grammar lights up under whatever editor theme is selected,
//     with zero private-API reach-in.
//
// Safety: we attach grammars ONLY to languages an extension newly registered —
// never to a language Monaco already ships (TS/JS/CSS/…), whose built-in
// tokenizer is richer than a single grammar swap. A grammar that fails to load,
// parse, or tokenize is skipped silently; the language degrades to plain text,
// never an editor crash.

import type { Monaco } from "@monaco-editor/react";
import type { IDisposable, languages } from "monaco-editor";
import {
  INITIAL,
  parseRawGrammar,
  Registry,
  type IGrammar,
  type IRawGrammar,
  type StateStack,
} from "vscode-textmate";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";

import { api } from "../api";

// scope name → which installed extension file holds its grammar JSON. Rebuilt by
// `resetGrammarSources` + `registerGrammarSource` on each apply pass, so a
// disabled/removed extension drops out.
type ScopeSource = { extId: string; path: string };
const scopeSources = new Map<string, ScopeSource>();
// Monaco language id → its root TextMate scope (from a grammar's `language`
// field). Only languages that name a grammar can be tokenized.
const langToScope = new Map<string, string>();
// Parsed-grammar cache, so re-mounting an editor doesn't re-read + re-parse.
const rawGrammarCache = new Map<string, IRawGrammar | null>();

// The oniguruma WASM loads exactly ONCE for the app's lifetime (`loadWASM` throws
// if called twice). The `vscode-textmate` Registry, by contrast, keeps its own
// internal compiled-grammar cache keyed by scope name — so it's recreated whenever
// the grammar sources reset (an extension was updated/disabled), otherwise a new
// version of a grammar under the same scope would serve the stale compiled copy
// until restart. `null` wasm result means the engine couldn't initialise (WASM
// fetch failed) — callers degrade to no highlighting.
let wasmPromise: Promise<boolean> | null = null;
let registry: Registry | null = null;

// Active tokens providers, per Monaco instance per language, so a rebuild can
// dispose the old provider before attaching a new one.
const providersByMonaco = new WeakMap<Monaco, Map<string, IDisposable>>();

/** Read + parse a grammar by scope name. Returns null (cached) when the scope
 *  isn't one we have a source for, or the file is unreadable / malformed. */
async function loadRawGrammar(scopeName: string): Promise<IRawGrammar | null> {
  const cached = rawGrammarCache.get(scopeName);
  if (cached !== undefined) return cached;
  const src = scopeSources.get(scopeName);
  if (!src) {
    rawGrammarCache.set(scopeName, null);
    return null;
  }
  try {
    const text = await api.vsixReadText(src.extId, src.path);
    const raw = parseRawGrammar(text, src.path);
    rawGrammarCache.set(scopeName, raw);
    return raw;
  } catch {
    rawGrammarCache.set(scopeName, null);
    return null;
  }
}

/** Load the oniguruma WASM exactly once (it throws if loaded twice). Returns false
 *  if the WASM couldn't be fetched — the engine then stays off. */
function ensureWasm(): Promise<boolean> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      try {
        // Fetch as bytes (not a streamed Response) so it works regardless of the
        // asset server's `Content-Type` — the Tauri asset host doesn't always
        // label `.wasm` as `application/wasm`, which would break streaming.
        const bytes = await (await fetch(onigWasmUrl)).arrayBuffer();
        await loadWASM({ data: bytes });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return wasmPromise;
}

/** Ensure WASM is up and a Registry exists. Idempotent; safe to call on every
 *  apply pass. Recreating the Registry (when `resetGrammarSources` nulled it) is
 *  cheap — it does NOT reload WASM — and gives a fresh, empty grammar cache so a
 *  re-enabled or updated grammar is recompiled instead of served stale. Returns
 *  false if WASM couldn't be fetched (engine stays off). */
async function ensureEngine(): Promise<boolean> {
  const ok = await ensureWasm();
  if (!ok) return false;
  if (!registry) {
    registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      loadGrammar: (scopeName) => loadRawGrammar(scopeName),
    });
  }
  return true;
}

/** Forget every recorded grammar source. Called at the start of an apply pass so
 *  the source maps reflect only the currently-enabled set. Keeps the WASM
 *  Registry — only the scope→file routing is rebuilt. */
export function resetGrammarSources(): void {
  scopeSources.clear();
  langToScope.clear();
  rawGrammarCache.clear();
  // Drop the Registry too: it caches compiled grammars by scope internally, so a
  // stale copy would otherwise survive an extension update/disable that reuses the
  // same scope name. `ensureEngine` rebuilds it (no WASM reload) on the next wire.
  registry = null;
}

/** Record one `contributes.grammars[]` entry as a tokenizable source. Called by
 *  the contributes router as it walks each enabled extension's manifest. */
export function registerGrammarSource(
  extId: string,
  g: { language?: string; scopeName?: string; path?: string },
): void {
  if (!g.scopeName || !g.path) return;
  scopeSources.set(g.scopeName, { extId, path: g.path });
  if (g.language) langToScope.set(g.language, g.scopeName);
}

// Monaco state object wrapping a TextMate StateStack. StateStack is immutable and
// carries its own structural `equals`, so Monaco can correctly decide when a
// downstream line's start-state is unchanged and stop re-tokenizing.
class TmState implements languages.IState {
  constructor(readonly ruleStack: StateStack) {}
  clone(): languages.IState {
    return new TmState(this.ruleStack);
  }
  equals(other: languages.IState): boolean {
    return other instanceof TmState && this.ruleStack.equals(other.ruleStack);
  }
}

// Pathological lines (giant minified blobs) can make a backtracking grammar
// crawl; cap each line so the editor never locks up. Tokens up to the limit are
// still returned; the rest of the line falls back to the default scope.
const LINE_TOKENIZE_TIME_LIMIT_MS = 250;

/** Load the grammar for `scopeName` and attach a Monaco tokens provider to
 *  `langId`, replacing any provider we previously set for it. */
async function wireLanguage(
  monaco: Monaco,
  langId: string,
  scopeName: string,
): Promise<void> {
  const reg = registry;
  if (!reg) return;
  let grammar: IGrammar | null;
  try {
    grammar = await reg.loadGrammar(scopeName);
  } catch {
    grammar = null;
  }
  if (!grammar) return;

  // The grammar references a real language id — make sure Monaco knows it (a
  // grammar can name a language no `contributes.languages` entry declared).
  const known = monaco.languages
    .getLanguages()
    .some((l: languages.ILanguageExtensionPoint) => l.id === langId);
  if (!known) monaco.languages.register({ id: langId });

  let map = providersByMonaco.get(monaco);
  if (!map) {
    map = new Map<string, IDisposable>();
    providersByMonaco.set(monaco, map);
  }
  map.get(langId)?.dispose();

  const disposable = monaco.languages.setTokensProvider(langId, {
    getInitialState: () => new TmState(INITIAL),
    tokenize: (line: string, state: languages.IState) => {
      const prev = (state as TmState).ruleStack;
      let result;
      try {
        result = grammar.tokenizeLine(line, prev, LINE_TOKENIZE_TIME_LIMIT_MS);
      } catch {
        // A tokenizer fault on one line must not break the editor — emit the
        // whole line as the default scope and carry the prior state forward.
        return { tokens: [{ startIndex: 0, scopes: "" }], endState: state };
      }
      const tokens = result.tokens.map((t) => ({
        startIndex: t.startIndex,
        // Most-specific (innermost) scope; Monaco's theme matches it by
        // longest dotted-prefix, the same way VS Code colour rules select.
        scopes: t.scopes.length > 0 ? t.scopes[t.scopes.length - 1] : "",
      }));
      return { tokens, endState: new TmState(result.ruleStack) };
    },
  });
  map.set(langId, disposable);
}

/** Attach TextMate tokenizers to every newly-contributed language that names a
 *  grammar. `ownLangs` is the set of language ids the contributes router itself
 *  registered this pass (never Monaco built-ins) — only those are safe to swap.
 *  No-op (and no WASM load) when nothing contributed a grammar. */
export async function wireExtensionGrammars(
  monaco: Monaco,
  ownLangs: Set<string>,
): Promise<void> {
  // Drop tokenizers for our languages whose grammar source vanished this pass
  // (the contributing extension was disabled or removed) — they revert to plain
  // text rather than keeping a now-orphaned grammar. Runs even when nothing is
  // contributed now, so disabling the last grammar extension cleans up.
  const existing = providersByMonaco.get(monaco);
  if (existing) {
    for (const [langId, disp] of existing) {
      if (!langToScope.has(langId)) {
        disp.dispose();
        existing.delete(langId);
      }
    }
  }

  if (langToScope.size === 0) return;
  const ready = await ensureEngine();
  if (!ready) return;
  for (const [langId, scopeName] of langToScope) {
    if (!ownLangs.has(langId)) continue; // never clobber a Monaco built-in
    try {
      await wireLanguage(monaco, langId, scopeName);
    } catch {
      // One bad grammar must not stop the others.
    }
  }
}

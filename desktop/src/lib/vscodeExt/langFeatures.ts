// Shared wire shapes for the language-feature bridge (Tier 1, W2).
//
// A web extension that calls `languages.registerCompletionItemProvider` /
// `registerHoverProvider` runs its provider INSIDE the host worker — but the
// document model and the popup UI live on the main thread, in Monaco. So a
// provider invocation crosses the worker boundary: main ships the document text
// + cursor position in, the worker calls the extension's provider, and the
// result comes back as one of the plain, structured-clone-safe shapes below.
//
// Coordinates on the wire are VS Code's: 0-based line AND 0-based character
// (what the provider sees). The main thread converts to Monaco's 1-based
// line/column when it builds the suggestion. Keeping the wire in the extension's
// own coordinate space means the worker never has to know about Monaco.
//
// Nothing here runs extension code; it is the data contract only. Both the
// worker (vscodeExtHostLang) and the main thread (extHostMonacoLang) import it,
// so the two ends can never drift.

/** Which language feature a provider serves. */
export type LangProviderKind = "completion" | "hover";

/** A position in VS Code coordinates: line and character are both 0-based. */
export type WirePos = { line: number; character: number };

/** A range in VS Code coordinates (0-based, end-exclusive like VS Code). */
export type WireRange = { start: WirePos; end: WirePos };

/** Documentation/markdown payload — `isMarkdown` tells the main side whether to
 *  hand Monaco an IMarkdownString or a plain string. */
export type WireMarkdown = { value: string; isMarkdown: boolean };

/** A serialized `vscode.CompletionItem`. `kind` is the VS Code enum value (the
 *  main thread remaps it to Monaco's different enum). `handle` is present only
 *  when the provider has a `resolveCompletionItem` — the main thread sends it
 *  back to lazily fill in detail/documentation when Monaco focuses the item. */
export type WireCompletionItem = {
  /** Primary label text (from a string label, or a label object's `.label`). */
  label: string;
  /** Secondary text shown right of the label (label object `.detail`). */
  detailLabel?: string;
  /** Faint qualifier (label object `.description`). */
  descriptionLabel?: string;
  /** VS Code `CompletionItemKind` value (Text=0, Method=1, …). */
  kind?: number;
  /** VS Code `CompletionItemTag` values (1 = Deprecated). */
  tags?: number[];
  /** Text/snippet to insert. When `isSnippet`, it is TM-snippet syntax. */
  insertText: string;
  /** True when `insertText` is a `SnippetString` (insert as snippet). */
  isSnippet: boolean;
  /** Greyed detail line in the completion widget. */
  detail?: string;
  /** Expanded documentation (string or markdown). */
  documentation?: WireMarkdown;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  /** Replacement range the provider specified (else main uses the word range). */
  range?: WireRange;
  commitCharacters?: string[];
  /** Resolve handle — set when the provider can lazily enrich this item. */
  handle?: number;
};

/** A serialized `vscode.CompletionList`. */
export type WireCompletionList = {
  items: WireCompletionItem[];
  /** VS Code's "incomplete" → Monaco re-asks as the user keeps typing. */
  isIncomplete: boolean;
};

/** A serialized `vscode.Hover`. */
export type WireHover = {
  contents: WireMarkdown[];
  range?: WireRange;
};

/** The document snapshot shipped into the worker for one provider call. */
export type WireDoc = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
};

/** Trigger context for a completion request, in VS Code's enum space
 *  (Invoke=0, TriggerCharacter=1, TriggerForIncompleteCompletions=2). */
export type WireCompletionContext = {
  triggerKind: number;
  triggerCharacter?: string;
};

/** A related-information note attached to a diagnostic (another spot in the code
 *  the problem references). */
export type WireDiagnosticRelated = {
  uri: string;
  range: WireRange;
  message: string;
};

/** A serialized `vscode.Diagnostic` (one squiggle). `severity` is VS Code's enum
 *  (Error=0, Warning=1, Information=2, Hint=3); the main thread remaps it to
 *  Monaco's MarkerSeverity. `tags` are VS Code's DiagnosticTag (Unnecessary=1,
 *  Deprecated=2). */
export type WireDiagnostic = {
  range: WireRange;
  message: string;
  severity: number;
  source?: string;
  code?: string | number;
  tags?: number[];
  related?: WireDiagnosticRelated[];
};

/** Pull the concrete language ids out of a VS Code `DocumentSelector`. We can
 *  only target a Monaco language we can name, so a wildcard (`"*"`) or a
 *  scheme/pattern-only filter contributes no language and is skipped — better an
 *  honest no-match than silently hijacking every editor. Accepts a bare string,
 *  a `{ language }` filter, or an array of either. */
export function selectorLanguages(selector: unknown): string[] {
  const out = new Set<string>();
  const add = (s: unknown): void => {
    if (typeof s === "string") {
      if (s && s !== "*") out.add(s);
    } else if (s && typeof s === "object") {
      const lang = (s as { language?: unknown }).language;
      if (typeof lang === "string" && lang && lang !== "*") out.add(lang);
    }
  };
  if (Array.isArray(selector)) selector.forEach(add);
  else add(selector);
  return [...out];
}

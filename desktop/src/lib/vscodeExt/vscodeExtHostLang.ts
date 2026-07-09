// Worker side of the language-feature bridge (Tier 1, W2).
//
// When a web extension calls `languages.registerCompletionItemProvider` /
// `registerHoverProvider`, the provider object lives HERE, in the worker. This
// module keeps the registry of those providers, builds the minimal `vscode`
// document/position values a provider expects, runs it on demand, and serializes
// the result into the plain `langFeatures` wire shapes for the main thread.
//
// No Monaco, no DOM — the worker only ever sees the document text the main thread
// ships in. A provider that throws is reported as an honest failure; it never
// takes down the host.

import {
  type LangProviderKind,
  type WireCompletionItem,
  type WireCompletionList,
  type WireDiagnostic,
  type WireDiagnosticRelated,
  type WireDoc,
  type WireHover,
  type WireMarkdown,
  type WirePos,
  type WireRange,
  selectorLanguages,
} from "./langFeatures";
import type { WorkerToHost } from "./extHostProtocol";
import {
  MarkdownString,
  Position,
  Range,
  SnippetString,
  Uri,
} from "./vscodeShim";

type Post = (msg: WorkerToHost) => void;

/** One registered provider, with the extension's live callback object. */
type ProviderRec = {
  extId: string;
  kind: LangProviderKind;
  languages: string[];
  /** The extension's provider object (provideCompletionItems / provideHover …). */
  impl: Record<string, unknown>;
  /** Whether it was announced to the main thread (skipped when no languages). */
  announced: boolean;
};

const providers = new Map<string, ProviderRec>();
let provSeq = 1;

// Items kept alive between a completion response and a later resolve call. VS
// Code's `resolveCompletionItem` is handed the ORIGINAL item object, so we must
// retain it; `handle` is the integer the main thread echoes back. Bounded so a
// long session can't grow it without limit — oldest handles evict first (Map
// keeps insertion order).
type HeldItem = { providerId: string; item: Record<string, unknown> };
const heldItems = new Map<number, HeldItem>();
let handleSeq = 1;
const HELD_ITEM_CAP = 3000;

function holdItem(providerId: string, item: Record<string, unknown>): number {
  const handle = handleSeq++;
  heldItems.set(handle, { providerId, item });
  if (heldItems.size > HELD_ITEM_CAP) {
    // Evict the oldest ~third in one sweep so we don't re-check every insert.
    const drop = heldItems.size - Math.floor((HELD_ITEM_CAP * 2) / 3);
    let i = 0;
    for (const k of heldItems.keys()) {
      if (i++ >= drop) break;
      heldItems.delete(k);
    }
  }
  return handle;
}

// ── Registration ─────────────────────────────────────────────────────────────

/** Register one provider. Returns the providerId the shim's Disposable will use
 *  to unregister. Announces to the main thread only when at least one concrete
 *  language can be targeted. */
export function registerProvider(
  extId: string,
  kind: LangProviderKind,
  selector: unknown,
  impl: Record<string, unknown>,
  triggerCharacters: string[] | undefined,
  post: Post,
): string {
  const providerId = `${extId}::${kind}::${provSeq++}`;
  const languages = selectorLanguages(selector);
  const rec: ProviderRec = { extId, kind, languages, impl, announced: false };
  providers.set(providerId, rec);

  if (languages.length > 0) {
    rec.announced = true;
    post({
      type: "registerLanguageProvider",
      providerId,
      extId,
      kind,
      languages,
      triggerCharacters: kind === "completion" ? triggerCharacters : undefined,
      hasResolve: kind === "completion" && typeof impl.resolveCompletionItem === "function",
    });
  }
  return providerId;
}

/** Drop one provider (its Disposable was disposed). */
export function unregisterProvider(providerId: string, post: Post): void {
  const rec = providers.get(providerId);
  if (!rec) return;
  providers.delete(providerId);
  if (rec.announced) post({ type: "unregisterLanguageProvider", providerId });
}

/** Drop every provider an extension owns (called on unload). */
export function disposeExtensionProviders(extId: string, post: Post): void {
  for (const [id, rec] of [...providers]) {
    if (rec.extId === extId) unregisterProvider(id, post);
  }
}

// ── Provide / resolve ────────────────────────────────────────────────────────

/** Run a provider for a `provide` request and reply with `provideResult`. */
export async function handleProvide(
  reqId: number,
  providerId: string,
  kind: LangProviderKind,
  doc: WireDoc,
  position: WirePos,
  context: { triggerKind: number; triggerCharacter?: string } | undefined,
  post: Post,
): Promise<void> {
  const reply = (value: WireCompletionList | WireHover | null) =>
    post({ type: "provideResult", reqId, ok: true, value });
  const fail = (e: unknown) =>
    post({ type: "provideResult", reqId, ok: false, error: e instanceof Error ? e.message : String(e) });

  const rec = providers.get(providerId);
  if (!rec) return reply(null);

  try {
    const document = makeTextDocument(doc);
    const pos = new Position(position.line, position.character);
    const token = cancellationToken();

    if (kind === "completion") {
      const fn = rec.impl.provideCompletionItems;
      if (typeof fn !== "function") return reply(null);
      const ctx = context ?? { triggerKind: 0, triggerCharacter: undefined };
      const raw = await Promise.resolve(
        (fn as (...a: unknown[]) => unknown)(document, pos, token, ctx),
      );
      return reply(serializeCompletions(raw, providerId, typeof rec.impl.resolveCompletionItem === "function"));
    }

    const fn = rec.impl.provideHover;
    if (typeof fn !== "function") return reply(null);
    const raw = await Promise.resolve((fn as (...a: unknown[]) => unknown)(document, pos, token));
    return reply(serializeHover(raw));
  } catch (e) {
    return fail(e);
  }
}

/** Lazily enrich one held completion item (`resolveCompletionItem`). */
export async function handleResolve(
  reqId: number,
  providerId: string,
  handle: number,
  post: Post,
): Promise<void> {
  const reply = (value: WireCompletionItem | null) =>
    post({ type: "provideResult", reqId, ok: true, value });

  const held = heldItems.get(handle);
  const rec = providers.get(providerId);
  if (!held || !rec || typeof rec.impl.resolveCompletionItem !== "function") return reply(null);

  try {
    const token = cancellationToken();
    const resolved = await Promise.resolve(
      (rec.impl.resolveCompletionItem as (...a: unknown[]) => unknown)(held.item, token),
    );
    const item = (resolved && typeof resolved === "object" ? resolved : held.item) as Record<string, unknown>;
    // No new handle on resolve — the item is already live on the main side.
    return reply(serializeCompletionItem(item, null));
  } catch {
    return reply(null);
  }
}

// ── Serialization ────────────────────────────────────────────────────────────

function serializeCompletions(
  raw: unknown,
  providerId: string,
  hasResolve: boolean,
): WireCompletionList | null {
  if (raw == null) return null;
  let items: unknown[];
  let isIncomplete = false;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)) {
    items = (raw as { items: unknown[] }).items;
    isIncomplete = !!(raw as { isIncomplete?: unknown }).isIncomplete;
  } else {
    return null;
  }
  const out: WireCompletionItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const item = it as Record<string, unknown>;
    const handle = hasResolve ? holdItem(providerId, item) : null;
    out.push(serializeCompletionItem(item, handle));
  }
  return { items: out, isIncomplete };
}

function serializeCompletionItem(
  item: Record<string, unknown>,
  handle: number | null,
): WireCompletionItem {
  // label may be a string or a { label, detail, description } object.
  let label = "";
  let detailLabel: string | undefined;
  let descriptionLabel: string | undefined;
  const rawLabel = item.label;
  if (typeof rawLabel === "string") {
    label = rawLabel;
  } else if (rawLabel && typeof rawLabel === "object") {
    const lo = rawLabel as { label?: unknown; detail?: unknown; description?: unknown };
    label = typeof lo.label === "string" ? lo.label : "";
    detailLabel = typeof lo.detail === "string" ? lo.detail : undefined;
    descriptionLabel = typeof lo.description === "string" ? lo.description : undefined;
  }

  // insertText: string, SnippetString, or absent (defaults to the label).
  let insertText = label;
  let isSnippet = false;
  const ins = item.insertText;
  if (ins instanceof SnippetString) {
    insertText = ins.value;
    isSnippet = true;
  } else if (typeof ins === "string") {
    insertText = ins;
  }

  const tags = Array.isArray(item.tags)
    ? (item.tags.filter((t) => typeof t === "number") as number[])
    : undefined;

  return {
    label,
    detailLabel,
    descriptionLabel,
    kind: typeof item.kind === "number" ? item.kind : undefined,
    tags,
    insertText,
    isSnippet,
    detail: typeof item.detail === "string" ? item.detail : undefined,
    documentation: serializeMarkdown(item.documentation),
    sortText: typeof item.sortText === "string" ? item.sortText : undefined,
    filterText: typeof item.filterText === "string" ? item.filterText : undefined,
    preselect: typeof item.preselect === "boolean" ? item.preselect : undefined,
    range: serializeRange(item.range),
    commitCharacters: Array.isArray(item.commitCharacters)
      ? (item.commitCharacters.filter((c) => typeof c === "string") as string[])
      : undefined,
    handle: handle ?? undefined,
  };
}

function serializeHover(raw: unknown): WireHover | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as { contents?: unknown; range?: unknown };
  const contents: WireMarkdown[] = [];
  const list = Array.isArray(h.contents) ? h.contents : h.contents != null ? [h.contents] : [];
  for (const c of list) {
    const md = serializeHoverContent(c);
    if (md) contents.push(md);
  }
  if (contents.length === 0) return null;
  return { contents, range: serializeRange(h.range) };
}

/** Hover contents may be a string, a MarkdownString, or a `{ language, value }`
 *  code block (the deprecated MarkedString form). Normalize all to markdown. */
function serializeHoverContent(c: unknown): WireMarkdown | null {
  if (typeof c === "string") return { value: c, isMarkdown: false };
  if (c instanceof MarkdownString) return { value: c.value, isMarkdown: true };
  if (c && typeof c === "object") {
    const o = c as { value?: unknown; language?: unknown };
    if (typeof o.value === "string") {
      if (typeof o.language === "string" && o.language) {
        return { value: "```" + o.language + "\n" + o.value + "\n```", isMarkdown: true };
      }
      return { value: o.value, isMarkdown: true };
    }
  }
  return null;
}

function serializeMarkdown(v: unknown): WireMarkdown | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return { value: v, isMarkdown: false };
  if (v instanceof MarkdownString) return { value: v.value, isMarkdown: true };
  if (typeof v === "object" && typeof (v as { value?: unknown }).value === "string") {
    return { value: (v as { value: string }).value, isMarkdown: true };
  }
  return undefined;
}

/** Serialize a `vscode.Range` (or a `{ inserting, replacing }` completion range,
 *  where we honour the replacing range). Returns undefined when absent. */
function serializeRange(v: unknown): WireRange | undefined {
  if (v == null) return undefined;
  let range: unknown = v;
  if (!(v instanceof Range) && typeof v === "object") {
    const ir = v as { replacing?: unknown; inserting?: unknown };
    if (ir.replacing || ir.inserting) range = ir.replacing ?? ir.inserting;
  }
  if (range instanceof Range) {
    return {
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
    };
  }
  if (range && typeof range === "object") {
    const r = range as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } };
    if (r.start && r.end) {
      return {
        start: { line: num(r.start.line), character: num(r.start.character) },
        end: { line: num(r.end.line), character: num(r.end.character) },
      };
    }
  }
  return undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ── Minimal TextDocument over the shipped text ───────────────────────────────

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

const DEFAULT_WORD_RE = /[A-Za-z0-9_$]+/g;

/** Build a read-only `vscode.TextDocument` over `doc.text`. Implements the
 *  members completion/hover providers actually reach for: getText, lineAt,
 *  offsetAt/positionAt, getWordRangeAtPosition, lineCount. */
function makeTextDocument(doc: WireDoc): Record<string, unknown> {
  const text = doc.text;
  // Offsets where each line starts, so position↔offset math is exact regardless
  // of CRLF/LF mixing (we keep the terminators in the offset accounting).
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      lineStarts.push(i + 1);
    } else if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i++; // CRLF counts as one break
      lineStarts.push(i + 1);
    }
  }
  const lineCount = lineStarts.length;

  const lineText = (line: number): string => {
    if (line < 0 || line >= lineCount) return "";
    const start = lineStarts[line];
    const end = line + 1 < lineCount ? lineStarts[line + 1] : text.length;
    return text.slice(start, end).replace(/\r?\n$/, "");
  };

  const offsetAt = (p: { line: number; character: number }): number => {
    const line = Math.max(0, Math.min(p.line, lineCount - 1));
    const lineLen = lineText(line).length;
    const character = Math.max(0, Math.min(p.character, lineLen));
    return lineStarts[line] + character;
  };

  const positionAt = (offset: number): Position => {
    const off = Math.max(0, Math.min(offset, text.length));
    // Binary search for the last line start ≤ off.
    let lo = 0;
    let hi = lineCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, off - lineStarts[lo]);
  };

  const uri = Uri.parse(doc.uri);

  return {
    uri,
    fileName: uri.fsPath,
    languageId: doc.languageId,
    version: doc.version,
    lineCount,
    isUntitled: uri.scheme === "untitled",
    isClosed: false,
    isDirty: false,
    eol: text.includes("\r\n") ? 2 : 1, // EndOfLine.CRLF : LF
    getText(range?: unknown): string {
      if (range instanceof Range) {
        return text.slice(offsetAt(range.start), offsetAt(range.end));
      }
      return text;
    },
    lineAt(lineOrPos: number | { line: number }): Record<string, unknown> {
      const line = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
      const raw = lineText(line);
      const firstNonWs = raw.search(/\S/);
      return {
        lineNumber: line,
        text: raw,
        range: new Range(line, 0, line, raw.length),
        rangeIncludingLineBreak: new Range(line, 0, line + 1 < lineCount ? line + 1 : line, line + 1 < lineCount ? 0 : raw.length),
        firstNonWhitespaceCharacterIndex: firstNonWs < 0 ? raw.length : firstNonWs,
        isEmptyOrWhitespace: raw.trim().length === 0,
      };
    },
    offsetAt,
    positionAt,
    getWordRangeAtPosition(pos: { line: number; character: number }, regex?: RegExp): Range | undefined {
      const raw = lineText(pos.line);
      const re = new RegExp(regex ? regex.source : DEFAULT_WORD_RE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (pos.character >= start && pos.character <= end) {
          return new Range(pos.line, start, pos.line, end);
        }
        if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width matches
      }
      return undefined;
    },
    validatePosition(p: Position): Position {
      const line = Math.max(0, Math.min(p.line, lineCount - 1));
      return new Position(line, Math.max(0, Math.min(p.character, lineText(line).length)));
    },
    validateRange(r: Range): Range {
      return r;
    },
  };
}

// ── Diagnostics (squiggles) ──────────────────────────────────────────────────
//
// An extension publishes diagnostics through a `DiagnosticCollection`. The shim's
// collection holds the raw `vscode.Diagnostic` objects and, on every change, calls
// back here to serialize them into the plain wire shape + post to the main thread,
// which paints them as Monaco markers. Each collection is one `owner`; we track
// which owners belong to which extension so an unload clears them all.

let diagSeq = 1;
/** extId → owner ids it created, so unload can clear every one. */
const diagOwnersByExt = new Map<string, Set<string>>();

/** Mint a unique owner id for a new DiagnosticCollection, remembering which
 *  extension owns it. */
export function nextDiagnosticOwner(extId: string, name: string): string {
  const owner = `${extId}::diag::${name || "_"}::${diagSeq++}`;
  let set = diagOwnersByExt.get(extId);
  if (!set) {
    set = new Set<string>();
    diagOwnersByExt.set(extId, set);
  }
  set.add(owner);
  return owner;
}

/** Serialize + publish one owner's diagnostics for a document. */
export function pushDiagnostics(owner: string, uri: string, items: unknown[], post: Post): void {
  post({ type: "setDiagnostics", owner, uri, items: serializeDiagnostics(items) });
}

/** Clear an owner's diagnostics — for one uri, or all of them when uri is absent. */
export function clearDiagnostics(owner: string, uri: string | undefined, post: Post): void {
  post({ type: "clearDiagnostics", owner, uri });
}

/** Clear every diagnostic an extension owns (called on unload). */
export function disposeExtensionDiagnostics(extId: string, post: Post): void {
  const set = diagOwnersByExt.get(extId);
  if (!set) return;
  for (const owner of set) post({ type: "clearDiagnostics", owner });
  diagOwnersByExt.delete(extId);
}

function serializeDiagnostics(items: unknown[]): WireDiagnostic[] {
  const out: WireDiagnostic[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const d = it as Record<string, unknown>;
    const range = serializeRange(d.range);
    if (!range) continue; // a diagnostic with no range can't anchor a marker
    out.push({
      range,
      message: typeof d.message === "string" ? d.message : String(d.message ?? ""),
      severity: typeof d.severity === "number" ? d.severity : 0,
      source: typeof d.source === "string" ? d.source : undefined,
      code: serializeCode(d.code),
      tags: Array.isArray(d.tags)
        ? (d.tags.filter((t) => typeof t === "number") as number[])
        : undefined,
      related: serializeRelated(d.relatedInformation),
    });
  }
  return out;
}

/** VS Code `Diagnostic.code` is a string, number, or `{ value, target }`. Monaco
 *  markers take a string/number code; keep the scalar. */
function serializeCode(v: unknown): string | number | undefined {
  if (typeof v === "string" || typeof v === "number") return v;
  if (v && typeof v === "object") {
    const val = (v as { value?: unknown }).value;
    if (typeof val === "string" || typeof val === "number") return val;
  }
  return undefined;
}

function serializeRelated(v: unknown): WireDiagnosticRelated[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WireDiagnosticRelated[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const loc = (r as { location?: unknown }).location as
      | { uri?: unknown; range?: unknown }
      | undefined;
    if (!loc) continue;
    const range = serializeRange(loc.range);
    if (!range) continue;
    let uri = "";
    if (typeof loc.uri === "string") uri = loc.uri;
    else if (loc.uri && typeof (loc.uri as { toString?: unknown }).toString === "function") {
      uri = String((loc.uri as { toString(): string }).toString());
    }
    const message = (r as { message?: unknown }).message;
    out.push({ uri, range, message: typeof message === "string" ? message : String(message ?? "") });
  }
  return out.length ? out : undefined;
}

/** Clear all provider + held-item + diagnostic state (worker reset path). */
export function clearAllProviders(): void {
  providers.clear();
  heldItems.clear();
  diagOwnersByExt.clear();
}

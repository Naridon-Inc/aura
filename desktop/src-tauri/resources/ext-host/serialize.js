"use strict";
// Serialization: turn the two flavours of provider result into the plain
// `langFeatures` wire shapes the frontend's Monaco bridge already understands.
//
//   • DIRECT providers — an extension that called
//     `vscode.languages.registerCompletionItemProvider` returns `vscode.*`
//     objects (CompletionItem / Hover / Diagnostic built from the shim). These go
//     through `serializeCompletions` / `serializeHover` / `serializeProviderDiagnostics`,
//     a faithful port of the web worker's serializer.
//
//   • LANGUAGE SERVERS — a LanguageClient gets raw LSP JSON over the wire. LSP
//     uses slightly different enums (CompletionItemKind and DiagnosticSeverity are
//     both 1-based where VS Code is 0-based) and `textEdit`-shaped insertions.
//     `lspCompletionToWire` / `lspHoverToWire` / `lspDiagnosticsToWire` translate.
//
// Both ends produce IDENTICAL wire shapes, so the frontend can't tell whether a
// suggestion came from a browser worker, a direct Node provider, or an LSP server.

const { SnippetString, MarkdownString, Range } = require("./vscode-shim");

// ── Selector → concrete languages (port of langFeatures.selectorLanguages) ───

/** Pull concrete language ids out of a VS Code DocumentSelector. A wildcard or a
 *  scheme/pattern-only filter contributes no language and is skipped — an honest
 *  no-match beats silently hijacking every editor. */
function selectorLanguages(selector) {
  const out = new Set();
  const add = (s) => {
    if (typeof s === "string") {
      if (s && s !== "*") out.add(s);
    } else if (s && typeof s === "object") {
      const lang = s.language;
      if (typeof lang === "string" && lang && lang !== "*") out.add(lang);
    }
  };
  if (Array.isArray(selector)) selector.forEach(add);
  else add(selector);
  return [...out];
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ── Shared range/markdown serializers (vscode.* objects) ─────────────────────

function serializeRange(v) {
  if (v == null) return undefined;
  let range = v;
  if (!(v instanceof Range) && typeof v === "object") {
    if (v.replacing || v.inserting) range = v.replacing ?? v.inserting;
  }
  if (range instanceof Range) {
    return {
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
    };
  }
  if (range && typeof range === "object" && range.start && range.end) {
    return {
      start: { line: num(range.start.line), character: num(range.start.character) },
      end: { line: num(range.end.line), character: num(range.end.character) },
    };
  }
  return undefined;
}

function serializeMarkdown(v) {
  if (v == null) return undefined;
  if (typeof v === "string") return { value: v, isMarkdown: false };
  if (v instanceof MarkdownString) return { value: v.value, isMarkdown: true };
  if (typeof v === "object" && typeof v.value === "string") return { value: v.value, isMarkdown: true };
  return undefined;
}

// ── Direct provider results (vscode.* objects) ───────────────────────────────

function serializeCompletions(raw, providerId, hold) {
  if (raw == null) return null;
  let items;
  let isIncomplete = false;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "object" && Array.isArray(raw.items)) {
    items = raw.items;
    isIncomplete = !!raw.isIncomplete;
  } else {
    return null;
  }
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const handle = hold ? hold(providerId, it) : null;
    out.push(serializeCompletionItem(it, handle));
  }
  return { items: out, isIncomplete };
}

function serializeCompletionItem(item, handle) {
  let label = "";
  let detailLabel;
  let descriptionLabel;
  const rawLabel = item.label;
  if (typeof rawLabel === "string") {
    label = rawLabel;
  } else if (rawLabel && typeof rawLabel === "object") {
    label = typeof rawLabel.label === "string" ? rawLabel.label : "";
    detailLabel = typeof rawLabel.detail === "string" ? rawLabel.detail : undefined;
    descriptionLabel = typeof rawLabel.description === "string" ? rawLabel.description : undefined;
  }

  let insertText = label;
  let isSnippet = false;
  const ins = item.insertText;
  if (ins instanceof SnippetString) {
    insertText = ins.value;
    isSnippet = true;
  } else if (typeof ins === "string") {
    insertText = ins;
  }

  const tags = Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "number") : undefined;

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
      ? item.commitCharacters.filter((c) => typeof c === "string")
      : undefined,
    handle: handle ?? undefined,
  };
}

function serializeHover(raw) {
  if (!raw || typeof raw !== "object") return null;
  const contents = [];
  const list = Array.isArray(raw.contents) ? raw.contents : raw.contents != null ? [raw.contents] : [];
  for (const c of list) {
    const md = serializeHoverContent(c);
    if (md) contents.push(md);
  }
  if (contents.length === 0) return null;
  return { contents, range: serializeRange(raw.range) };
}

function serializeHoverContent(c) {
  if (typeof c === "string") return { value: c, isMarkdown: false };
  if (c instanceof MarkdownString) return { value: c.value, isMarkdown: true };
  if (c && typeof c === "object" && typeof c.value === "string") {
    if (typeof c.language === "string" && c.language) {
      return { value: "```" + c.language + "\n" + c.value + "\n```", isMarkdown: true };
    }
    return { value: c.value, isMarkdown: true };
  }
  return null;
}

function serializeProviderDiagnostics(items) {
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const range = serializeRange(it.range);
    if (!range) continue;
    out.push({
      range,
      message: typeof it.message === "string" ? it.message : String(it.message ?? ""),
      severity: typeof it.severity === "number" ? it.severity : 0,
      source: typeof it.source === "string" ? it.source : undefined,
      code: serializeCode(it.code),
      tags: Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === "number") : undefined,
      related: serializeProviderRelated(it.relatedInformation),
    });
  }
  return out;
}

function serializeCode(v) {
  if (typeof v === "string" || typeof v === "number") return v;
  if (v && typeof v === "object" && (typeof v.value === "string" || typeof v.value === "number")) return v.value;
  return undefined;
}

function serializeProviderRelated(v) {
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== "object" || !r.location) continue;
    const range = serializeRange(r.location.range);
    if (!range) continue;
    let uri = "";
    const u = r.location.uri;
    if (typeof u === "string") uri = u;
    else if (u && typeof u.toString === "function") uri = String(u.toString());
    out.push({ uri, range, message: typeof r.message === "string" ? r.message : String(r.message ?? "") });
  }
  return out.length ? out : undefined;
}

// ── LSP results → wire ───────────────────────────────────────────────────────

/** LSP ranges already match the wire (0-based line + 0-based character). */
function lspRange(r) {
  if (!r || !r.start || !r.end) return undefined;
  return {
    start: { line: num(r.start.line), character: num(r.start.character) },
    end: { line: num(r.end.line), character: num(r.end.character) },
  };
}

/** LSP `MarkupContent | MarkedString | string` → WireMarkdown. */
function lspMarkup(v) {
  if (v == null) return undefined;
  if (typeof v === "string") return { value: v, isMarkdown: false };
  if (typeof v === "object") {
    if (typeof v.value === "string") {
      // MarkupContent { kind, value } or MarkedString { language, value }
      if (typeof v.language === "string" && v.language) {
        return { value: "```" + v.language + "\n" + v.value + "\n```", isMarkdown: true };
      }
      return { value: v.value, isMarkdown: v.kind === "markdown" };
    }
  }
  return undefined;
}

/** LSP CompletionList | CompletionItem[] → WireCompletionList. `hold` retains the
 *  original LSP item for a later `completionItem/resolve` (returns a handle). */
function lspCompletionToWire(result, hold) {
  if (result == null) return null;
  let items;
  let isIncomplete = false;
  if (Array.isArray(result)) {
    items = result;
  } else if (typeof result === "object" && Array.isArray(result.items)) {
    items = result.items;
    isIncomplete = !!result.isIncomplete;
  } else {
    return null;
  }
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const handle = hold ? hold(it) : null;
    out.push(lspItemToWire(it, handle));
  }
  return { items: out, isIncomplete };
}

/** One LSP CompletionItem → WireCompletionItem. */
function lspItemToWire(it, handle) {
  const label = typeof it.label === "string" ? it.label : String(it.label ?? "");
  const ld = it.labelDetails || {};

  // insertText: prefer a textEdit's newText, else insertText, else the label.
  let insertText = typeof it.insertText === "string" ? it.insertText : label;
  let range;
  const te = it.textEdit;
  if (te && typeof te === "object") {
    if (typeof te.newText === "string") insertText = te.newText;
    range = lspRange(te.range || te.replace || te.insert);
  }
  const isSnippet = it.insertTextFormat === 2; // 2 = Snippet

  const kind = typeof it.kind === "number" ? Math.max(0, it.kind - 1) : undefined; // LSP 1-based → VS Code 0-based
  const tags = Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === "number") : undefined;

  return {
    label,
    detailLabel: typeof ld.detail === "string" ? ld.detail : undefined,
    descriptionLabel: typeof ld.description === "string" ? ld.description : undefined,
    kind,
    tags,
    insertText,
    isSnippet,
    detail: typeof it.detail === "string" ? it.detail : undefined,
    documentation: lspMarkup(it.documentation),
    sortText: typeof it.sortText === "string" ? it.sortText : undefined,
    filterText: typeof it.filterText === "string" ? it.filterText : undefined,
    preselect: typeof it.preselect === "boolean" ? it.preselect : undefined,
    range,
    commitCharacters: Array.isArray(it.commitCharacters)
      ? it.commitCharacters.filter((c) => typeof c === "string")
      : undefined,
    handle: handle ?? undefined,
  };
}

/** LSP Hover → WireHover. */
function lspHoverToWire(h) {
  if (!h || typeof h !== "object") return null;
  const contents = [];
  const list = Array.isArray(h.contents) ? h.contents : h.contents != null ? [h.contents] : [];
  for (const c of list) {
    const md = lspMarkup(c);
    if (md) contents.push(md);
  }
  if (contents.length === 0) return null;
  return { contents, range: lspRange(h.range) };
}

/** LSP Diagnostic[] (from publishDiagnostics) → WireDiagnostic[]. */
function lspDiagnosticsToWire(items) {
  const out = [];
  if (!Array.isArray(items)) return out;
  for (const d of items) {
    if (!d || typeof d !== "object") continue;
    const range = lspRange(d.range);
    if (!range) continue;
    out.push({
      range,
      message: typeof d.message === "string" ? d.message : String(d.message ?? ""),
      // LSP severity is 1-based (Error=1…Hint=4); VS Code/wire is 0-based.
      severity: typeof d.severity === "number" ? Math.max(0, d.severity - 1) : 0,
      source: typeof d.source === "string" ? d.source : undefined,
      code: serializeCode(d.code),
      tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === "number") : undefined,
      related: lspRelated(d.relatedInformation),
    });
  }
  return out;
}

function lspRelated(v) {
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== "object" || !r.location) continue;
    const range = lspRange(r.location.range);
    if (!range) continue;
    out.push({
      uri: typeof r.location.uri === "string" ? r.location.uri : "",
      range,
      message: typeof r.message === "string" ? r.message : String(r.message ?? ""),
    });
  }
  return out.length ? out : undefined;
}

module.exports = {
  selectorLanguages,
  serializeCompletions,
  serializeCompletionItem,
  serializeHover,
  serializeProviderDiagnostics,
  lspCompletionToWire,
  lspItemToWire,
  lspHoverToWire,
  lspDiagnosticsToWire,
};

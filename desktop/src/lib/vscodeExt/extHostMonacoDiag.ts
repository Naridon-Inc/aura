// Main-thread side of the diagnostics bridge (Tier 1, W3).
//
// When a web extension publishes diagnostics through a DiagnosticCollection, the
// worker ships them here as plain `WireDiagnostic`s tagged with an `owner` (one
// per collection) and a document uri. This module paints them as Monaco markers —
// the squiggles + the Problems gutter — via `monaco.editor.setModelMarkers`.
//
// Two things make this less trivial than completions:
//   • Owner isolation. Monaco's marker API is already owner-keyed, so each
//     extension collection maps to its own marker owner and they never clobber
//     each other. Clearing a collection is `setModelMarkers(model, owner, [])`.
//   • Model timing + uri shape. The extension addresses a document by
//     `Uri.file(absPath)` → `file:///abs/path`, but the editor's Monaco model uri
//     (built by @monaco-editor/react from its `path` prop) may use a different
//     scheme. So we match by PATH, not full-uri-string, and we HOLD diagnostics
//     for a not-yet-open document, flushing them when the model is created.
//
// Coordinates: WireDiagnostic positions are VS Code 0-based; Monaco markers are
// 1-based. The +1 conversion lives here, at the boundary.

import type { Monaco } from "@monaco-editor/react";
import type { editor, IDisposable } from "monaco-editor";
import type { WireDiagnostic } from "./langFeatures";

let monacoRef: Monaco | null = null;
let createModelSub: IDisposable | null = null;

/** owner → (wire uri → its diagnostics). Retained so we can (a) re-apply when a
 *  model opens later, and (b) clear precisely. */
const byOwner = new Map<string, Map<string, WireDiagnostic[]>>();

/** Hand in the Monaco namespace (called when the editor mounts). Idempotent;
 *  flushes everything held so far and starts watching for newly-opened models. */
export function setExtHostDiagMonaco(monaco: Monaco): void {
  if (monacoRef === monaco) return;
  monacoRef = monaco;
  for (const [owner, m] of byOwner) for (const uri of m.keys()) apply(owner, uri);
  if (!createModelSub) {
    createModelSub = monaco.editor.onDidCreateModel((model: editor.ITextModel) => {
      // A document just opened — paint any diagnostics held for its path.
      for (const [owner, m] of byOwner) {
        for (const [uri, items] of m) {
          if (modelMatches(model, uri)) {
            monaco.editor.setModelMarkers(model, owner, items.map((d) => toMarker(monaco, d)));
          }
        }
      }
    });
  }
}

/** Set (replace) one owner's diagnostics for a document. */
export function setExtHostDiagnostics(owner: string, uri: string, items: WireDiagnostic[]): void {
  let m = byOwner.get(owner);
  if (!m) {
    m = new Map<string, WireDiagnostic[]>();
    byOwner.set(owner, m);
  }
  m.set(uri, items);
  apply(owner, uri);
}

/** Clear one owner's diagnostics — for one uri, or all of them when uri is absent. */
export function clearExtHostDiagnostics(owner: string, uri?: string): void {
  const m = byOwner.get(owner);
  if (!m) return;
  if (uri === undefined) {
    const uris = [...m.keys()];
    m.clear();
    byOwner.delete(owner);
    if (monacoRef) {
      for (const u of uris) {
        const model = findModel(u);
        if (model) monacoRef.editor.setModelMarkers(model, owner, []);
      }
    }
  } else {
    m.delete(uri);
    if (m.size === 0) byOwner.delete(owner);
    if (monacoRef) {
      const model = findModel(uri);
      if (model) monacoRef.editor.setModelMarkers(model, owner, []);
    }
  }
}

/** Drop every owner's diagnostics (worker crash / reset path). */
export function clearAllDiagnostics(): void {
  if (monacoRef) {
    for (const [owner, m] of byOwner) {
      for (const uri of m.keys()) {
        const model = findModel(uri);
        if (model) monacoRef.editor.setModelMarkers(model, owner, []);
      }
    }
  }
  byOwner.clear();
}

// ── Application ──────────────────────────────────────────────────────────────

/** Paint one owner's diagnostics for one uri, if its model is open. When the
 *  model isn't open yet, the diagnostics stay held and `onDidCreateModel` flushes
 *  them later — so an extension can publish before the file is opened. */
function apply(owner: string, uri: string): void {
  if (!monacoRef) return;
  const model = findModel(uri);
  if (!model) return;
  const items = byOwner.get(owner)?.get(uri) ?? [];
  monacoRef.editor.setModelMarkers(model, owner, items.map((d) => toMarker(monacoRef!, d)));
}

// ── Model matching (path-based, scheme-agnostic) ─────────────────────────────

type MatchableModel = { uri: { path: string; toString(): string } };

function findModel(wireUri: string): editor.ITextModel | null {
  if (!monacoRef) return null;
  for (const model of monacoRef.editor.getModels()) {
    if (modelMatches(model, wireUri)) return model;
  }
  return null;
}

function modelMatches(model: MatchableModel, wireUri: string): boolean {
  if (model.uri.toString() === wireUri) return true;
  const want = pathOf(wireUri);
  const have = model.uri.path;
  if (!want || !have) return false;
  return have === want || endsAtBoundary(have, want) || endsAtBoundary(want, have);
}

/** Pull the path out of a uri string. `file:///a/b` → `/a/b`,
 *  `inmemory://model/a/b` → `/a/b`, a bare `/a/b` stays `/a/b`. */
function pathOf(uriStr: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(\/.*)?$/.exec(uriStr);
  if (m) return m[1] ?? "";
  return uriStr.startsWith("/") ? uriStr : `/${uriStr}`;
}

/** True when `longer` ends with `shorter` AND the cut falls on a path separator,
 *  so `/src/app.ts` matches `/app.ts` but `/myapp.ts` does not match `/app.ts`. */
function endsAtBoundary(longer: string, shorter: string): boolean {
  if (!longer.endsWith(shorter)) return false;
  if (longer.length === shorter.length) return true;
  return longer[longer.length - shorter.length - 1] === "/";
}

// ── Mapping WireDiagnostic → Monaco IMarkerData ──────────────────────────────

function toMarker(monaco: Monaco, d: WireDiagnostic): editor.IMarkerData {
  return {
    severity: toMarkerSeverity(monaco, d.severity),
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source,
    code: d.code != null ? String(d.code) : undefined,
    tags: toMarkerTags(monaco, d.tags),
    relatedInformation: d.related?.map((r) => ({
      resource: monaco.Uri.parse(r.uri),
      message: r.message,
      startLineNumber: r.range.start.line + 1,
      startColumn: r.range.start.character + 1,
      endLineNumber: r.range.end.line + 1,
      endColumn: r.range.end.character + 1,
    })),
  };
}

/** VS Code `DiagnosticSeverity` (Error=0…Hint=3) → Monaco `MarkerSeverity`
 *  (Error=8, Warning=4, Info=2, Hint=1). */
function toMarkerSeverity(monaco: Monaco, sev: number): editor.IMarkerData["severity"] {
  const S = monaco.MarkerSeverity;
  switch (sev) {
    case 1:
      return S.Warning;
    case 2:
      return S.Info;
    case 3:
      return S.Hint;
    default:
      return S.Error;
  }
}

/** VS Code `DiagnosticTag` (Unnecessary=1, Deprecated=2) → Monaco `MarkerTag`
 *  (same values, but go through the live enum to stay correct). */
function toMarkerTags(monaco: Monaco, tags?: number[]): editor.IMarkerData["tags"] {
  if (!tags || tags.length === 0) return undefined;
  const out: NonNullable<editor.IMarkerData["tags"]> = [];
  for (const t of tags) {
    if (t === 1) out.push(monaco.MarkerTag.Unnecessary);
    else if (t === 2) out.push(monaco.MarkerTag.Deprecated);
  }
  return out.length ? out : undefined;
}

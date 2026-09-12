// changeExplain — cached, plain-language before/what/why for one file's change.
//
// The split-diff header shows the real changed pieces instantly (grounded in
// the AST change-note). This layer fetches the richer, model-written story on
// top — what the code USED TO DO, what it does NOW, and WHY it was changed and
// how it works — and holds it so the header paints instantly and silently
// upgrades once the words arrive.
//
// A committed diff is immutable, so its entry is true for the surface's
// lifetime and is held. A working-tree edit is not, and holding one meant the
// account a reviewer read described a diff that had since been edited away —
// see `isImmutable`. Those re-ask.
//
// The WHY is not always Aura's to write: `aura snapshot-file --why` records the
// author's own reason against a file, and the backend now returns it verbatim
// with `why_source: "recorded"`. `whyIsRecorded` is how a surface tells a quote
// from a reading.

import { api, type ChangedSymbol, type ChangeExplanation, type SymbolExplanation } from "./api";

export type { ChangeExplanation };

/** Nothing to describe — the change has no diff. Exported as the counterpart to
 *  {@link FAILED_EXPLANATION}; the two must never be folded back into one. */
export const EMPTY_EXPLANATION: ChangeExplanation = {
  before: "",
  what: "",
  why: "",
  why_source: "none",
  source: "none",
  diff_hash: "",
};

/** What a failed request resolves to. Deliberately NOT {@link
 *  EMPTY_EXPLANATION}: "the request blew up" and "this change has nothing to
 *  describe" are different facts, and collapsing them told a reviewer there was
 *  nothing to say about a change Aura had merely failed to read. */
export const FAILED_EXPLANATION: ChangeExplanation = {
  before: "",
  what: "",
  why: "",
  why_source: "error",
  source: "error",
  diff_hash: "",
};

// Resolved explanations (per repo+file+commit) and in-flight requests, so a
// re-render or a second pane asking for the same change never re-hits the model.
const cache = new Map<string, ChangeExplanation>();
const inflight = new Map<string, Promise<ChangeExplanation>>();

function keyOf(repoRoot: string, file: string, commit?: string | null): string {
  return `${repoRoot}\u0000${file}\u0000${commit ?? ""}`;
}

/** Is this change's content fixed for good?
 *
 *  A commit's diff is immutable, so an explanation of it is true forever and
 *  can be held for the surface's lifetime. A working-tree edit is not: the file
 *  changes under the same key, and keying on (repo, file, commit) with an empty
 *  commit pinned the FIRST account of a file and served it for every later
 *  edit — the reviewer read a description of a diff that no longer existed.
 *  Those re-ask instead. The backend keys its own store by diff content-hash
 *  and answers without waiting on a model, so a re-ask is cheap, and it is the
 *  only thing that keeps the words attached to the change in front of you. */
function isImmutable(commit?: string | null): boolean {
  return !!(commit ?? "").trim();
}

/** Cached before/what/why for a file's change. `commit` scopes it to a past
 *  commit's change; omit for the live working-tree edit. Never throws — a
 *  failure resolves to a result the caller can tell apart from an empty one,
 *  and the header simply keeps its instant, grounded text. */
export async function loadExplanation(
  repoRoot: string,
  file: string,
  commit?: string | null,
): Promise<ChangeExplanation> {
  const key = keyOf(repoRoot, file, commit);
  const durable = isImmutable(commit);
  if (durable) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  // In-flight dedupe applies either way: two panes asking for the same change
  // in the same tick share one request without pinning a stale answer.
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = api
    .explainChange(repoRoot, file, commit ?? undefined)
    .then((r) => {
      if (durable) cache.set(key, r);
      inflight.delete(key);
      return r;
    })
    .catch(() => {
      inflight.delete(key);
      return FAILED_EXPLANATION;
    });
  inflight.set(key, p);
  return p;
}

/** Forget what is held for one change, so the next load re-asks. The retry
 *  control after a failure calls this: it clears the entry and nothing else, so
 *  the reader's scroll position, open pieces and picked symbol all survive. */
export function forgetExplanation(
  repoRoot: string,
  file: string,
  commit?: string | null,
): void {
  const key = keyOf(repoRoot, file, commit);
  cache.delete(key);
  inflight.delete(key);
  symCache.delete(key);
  symInflight.delete(key);
}

/** True when an explanation actually carries readable words (not the empty /
 *  no-model / failed result), so the caller only swaps in real content. */
export function hasExplanation(e: ChangeExplanation | null | undefined): boolean {
  return !!e && !!(e.what.trim() || e.before.trim() || e.why.trim());
}

/** The request failed. Distinct from an empty answer: there may well be
 *  something to say about this change, and Aura did not manage to say it. */
export function explanationFailed(e: ChangeExplanation | null | undefined): boolean {
  return e?.source === "error";
}

/** The `why` is the author's own words, quoted, rather than Aura's reading of
 *  the diff — so the surface attributes it instead of presenting it as Aura's. */
export function whyIsRecorded(e: ChangeExplanation | null | undefined): boolean {
  return e?.why_source === "recorded" && !!e.why.trim();
}

/** The words were mined from the diff because no model was reachable — an
 *  inference, labelled as one so it is never mistaken for a stated reason. */
export function isInferredFromDiff(e: ChangeExplanation | null | undefined): boolean {
  return e?.source === "fallback";
}

/** Per-piece plain-language meanings for one file's change: what each piece
 *  does NOW (new side) and what it USED TO DO (old side), each keyed by the
 *  piece's identifier. `complete` is true once every piece has the model-written
 *  words it needs — while it's false the model is still backfilling and the
 *  caller should re-poll. */
export type SymbolMeanings = {
  now: Map<string, string>;
  before: Map<string, string>;
  complete: boolean;
};

const EMPTY_SYMS: SymbolMeanings = { now: new Map(), before: new Map(), complete: true };

// Resolved per-piece meanings, keyed the same way as the file-level
// explanation. Only a COMPLETE result (every piece carrying the model-written
// words it needs, both sides) is cached; a partial one — where the model is
// still writing some — is returned but NOT cached, so a re-poll re-asks and
// picks up the background backfill.
const symCache = new Map<string, SymbolMeanings>();
const symInflight = new Map<string, Promise<SymbolMeanings>>();

/** Per-piece plain-language meanings for a file's changed symbols. `commit`
 *  scopes it to a past commit's change; omit for the live working-tree edit.
 *  Never throws — a failure or no reachable model resolves to empty maps, and
 *  each node simply keeps its instant, grounded placeholder until the model's
 *  words land on a later poll. */
export async function loadSymbolExplanations(
  repoRoot: string,
  file: string,
  symbols: ChangedSymbol[],
  commit?: string | null,
): Promise<SymbolMeanings> {
  if (!symbols.length) return EMPTY_SYMS;
  const key = keyOf(repoRoot, file, commit);
  const durable = isImmutable(commit);
  if (durable) {
    const hit = symCache.get(key);
    if (hit) return hit;
  }
  const pending = symInflight.get(key);
  if (pending) return pending;

  const p = api
    .explainSymbols(repoRoot, file, symbols, commit ?? undefined)
    .then((rows) => {
      symInflight.delete(key);
      const result = foldMeanings(rows, symbols);
      // Only a fully-resolved answer for an immutable change is durable. A
      // partial one means the model is still backfilling — don't freeze the
      // placeholders in; let a re-poll re-ask and swap in the real words when
      // they arrive. A working-tree change is never durable at all: the pieces
      // themselves change under the same key (see `isImmutable`).
      if (durable && result.complete) symCache.set(key, result);
      return result;
    })
    .catch(() => {
      symInflight.delete(key);
      return EMPTY_SYMS;
    });
  symInflight.set(key, p);
  return p;
}

/** Fold the per-piece rows into now/before maps (dropping empty sides so a
 *  caller can `map.get(id) || fallback`) and decide whether every piece has the
 *  model words it needs: an added piece needs only `now`, a removed piece only
 *  `before`, a modified piece both. */
function foldMeanings(rows: SymbolExplanation[], symbols: ChangedSymbol[]): SymbolMeanings {
  const now = new Map<string, string>();
  const before = new Map<string, string>();
  const byId = new Map<string, SymbolExplanation>();
  for (const r of rows) {
    byId.set(r.identifier, r);
    const n = r.now.trim();
    if (n) now.set(r.identifier, n);
    const b = r.before.trim();
    if (b) before.set(r.identifier, b);
  }
  const complete = symbols.every((s) => {
    const needsNow = s.change !== "deleted";
    const needsBefore = s.change !== "added";
    const okNow = !needsNow || !!byId.get(s.identifier)?.now.trim();
    const okBefore = !needsBefore || !!byId.get(s.identifier)?.before.trim();
    return okNow && okBefore;
  });
  return { now, before, complete };
}

// djb2 — a tiny, stable string hash. The PR diff `body` is the cache identity
// (a PR file has no commit sha), but it's too large to key the module map on
// directly, so we fold it to a short hash. Same diff bytes → same key → the
// model is asked at most once per PR file.
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Cached before/what/why for a PR file's change, where the caller already
 *  holds the raw unified diff (base..head range) and there is no single commit
 *  to scope by. Mirrors {@link loadExplanation}: module-cached + inflight-
 *  deduped, and never throws — a failure or no reachable model resolves to the
 *  empty explanation so the surface keeps its instant, grounded diff. */
export async function loadExplanationForDiff(
  repoRoot: string,
  file: string,
  diff: string,
): Promise<ChangeExplanation> {
  const key = `${repoRoot} ${file} pr:${djb2(diff)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = api
    .explainChangeDiff(repoRoot, file, diff)
    .then((r) => {
      cache.set(key, r);
      inflight.delete(key);
      return r;
    })
    .catch(() => {
      inflight.delete(key);
      return FAILED_EXPLANATION;
    });
  inflight.set(key, p);
  return p;
}

// SplitDiffHeader — the "why this changed" header that sits above the committed
// side-by-side (split) diff.
//
// Replaces the loose prose caption with a shape that mirrors the diff below:
//   1. a MERGED summary block spanning the full width — a plain-language
//      one-liner Aura composes from the real changed pieces, plus a dead-visible
//      WHY / WHEN / WHERE band: why the change was made (the recorded reason),
//      when it landed, and which file it's in.
//   2. a two-column header row aligned to the split panes:
//        • "Previous was this" over the LEFT (old) pane — the pieces that were
//          here before (deleted + the prior shape of modified ones).
//        • "New is this" over the RIGHT (new) pane — the pieces that are here
//          now (added + the new shape of modified ones).
//
// MEANING-FIRST: a non-engineer can't read `AgentRef struct pub struct
// AgentRef(pub String)`. So every piece leads with its real-world MEANING —
// the Code Atlas summary (`aura atlas`) when we have it, otherwise a plain
// "what kind of thing changed, and how" line composed from the AST facts. The
// raw identifier + kind live on a muted "mechanism" line; the full signature is
// tucked into its hover, never shouted. Titles humanize the identifier with the
// SAME helper the Goals surface uses, so the two read the same.
//
// HONESTY: every word here is grounded in the `aura change-note <sha> --json`
// payload (AST diff + call graph, no AI tokens) and the commit's own facts
// (reason / time / path). Nothing is invented — a fact with no real source is
// omitted, not guessed. The full old/new TEXT is the Monaco diff below; this
// header is the reader-facing index over it, height-capped so it never starves
// the diff of room.

import { useEffect, useState } from "react";
import type { AtlasHoverEntry, ChangedSymbol, FileChangeNote } from "../../lib/api";
import { loadAtlasIndex, lookupEntry, type AtlasIndex } from "../../lib/atlasHover";
import { humanizeIdentifier as humanizeWords } from "../../lib/prove";
import {
  loadExplanation,
  loadSymbolExplanations,
  type ChangeExplanation,
  type SymbolMeanings,
} from "../../lib/changeExplain";

/** tree-sitter kind → a short human word. Unknown kinds pass through.
 *  (Mirrors ChangeNoteCard's mapping so the two surfaces read the same.) */
function prettyKind(kind: string): string {
  switch (kind) {
    case "function_item":
    case "function_declaration":
    case "function_definition":
    case "arrow_function":
    case "method_definition":
    case "method_declaration":
      return "fn";
    case "struct_item":
      return "struct";
    case "impl_item":
      return "impl";
    case "class_declaration":
    case "class_definition":
      return "class";
    case "enum_item":
      return "enum";
    case "trait_item":
      return "trait";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
    case "type_item":
      return "type";
    default:
      return kind;
  }
}

/** The same kinds, spelled out as a plain noun for the non-engineer summary
 *  ("function", "class") rather than the terse mechanism word ("fn"). */
function plainKind(kind: string): string {
  switch (prettyKind(kind)) {
    case "fn":
      return "function";
    case "struct":
      return "structure";
    case "impl":
      return "implementation";
    case "class":
      return "class";
    case "enum":
      return "set of options";
    case "trait":
      return "trait";
    case "interface":
      return "interface";
    case "type":
      return "type";
    default:
      return "piece";
  }
}

/** Naive plural for the plain kind nouns above (enough for this small set). */
function plural(noun: string, n: number): string {
  if (n === 1) return noun;
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/** "added" | "modified" | "deleted" → a plain word for the non-engineer. */
function changeWord(change: string): string {
  switch (change) {
    case "added":
      return "added";
    case "deleted":
      return "removed";
    default:
      return "changed";
  }
}

/** Title-cased plain name for a piece, from the SAME humanizer the Goals surface
 *  uses: `senderFor` → "Sender For", `fsm_happy_path` → "Fsm Happy Path". The
 *  atlas title wins when present; this is the always-there fallback. */
function titleize(id: string): string {
  const words = humanizeWords(id).trim();
  if (!words) return id;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A plain-English "what kind of thing changed, and how" line, from the AST
 *  facts alone — the fallback meaning when the atlas has no richer summary. */
function pieceMeaning(s: ChangedSymbol): string {
  const kind = plainKind(s.kind);
  switch (s.change) {
    case "added":
      return `A new ${kind}.`;
    case "deleted":
      return `This ${kind} was removed.`;
    default:
      return `This ${kind} was reworked.`;
  }
}

/** One plain sentence summarising the whole file's change, composed from the
 *  real changed pieces (not the engine's identifier-laden one-liner). Groups by
 *  kind and names the pieces in plain words: "Reworked 2 functions (sender for,
 *  deliver) and 1 class (email dispatcher)." Falls back to the engine note when
 *  there are no tracked symbols (a mode-only or below-symbol change). */
function plainSummary(symbols: ChangedSymbol[], engineNote: string): string {
  if (!symbols.length) return engineNote;
  const added = symbols.filter((s) => s.change === "added").length;
  const removed = symbols.filter((s) => s.change === "deleted").length;
  const verb = removed && !added && removed === symbols.length ? "Removed"
    : added && !removed && added === symbols.length ? "Added"
      : "Reworked";
  // Group by plain kind, preserving first-seen order.
  const groups: { kind: string; names: string[] }[] = [];
  for (const s of symbols) {
    const kind = plainKind(s.kind);
    const g = groups.find((x) => x.kind === kind);
    const name = humanizeWords(s.identifier).trim();
    if (g) g.names.push(name);
    else groups.push({ kind, names: [name] });
  }
  const phrases = groups.map((g) => {
    const head = `${g.names.length} ${plural(g.kind, g.names.length)}`;
    const named = g.names.filter(Boolean);
    return named.length ? `${head} (${named.join(", ")})` : head;
  });
  const list =
    phrases.length <= 1
      ? phrases.join("")
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return `${verb} ${list}.`;
}

/** Relative age of a commit time (unix seconds, tolerating milliseconds) — the
 *  same shape the Goals cards use, so "when" reads consistently across surfaces. */
function relTime(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** A readable absolute timestamp for the "when" hover. */
function absTime(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

/** Split a repo-relative path into a muted folder + emphasised filename so the
 *  "where" reads at a glance without the whole path shouting. */
function whereParts(file: string): { folder: string; base: string } {
  const norm = file.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { folder: "", base: norm };
  return { folder: norm.slice(0, i + 1), base: norm.slice(i + 1) };
}

/** One piece inside a side-column, meaning-first. `showSignature` gates the raw
 *  signature (into the mechanism line's hover) so it only annotates the side it
 *  truthfully belongs to. `entry` is the atlas meaning when we have it. When
 *  `onBringBack` is set, a piece that can be recovered (a changed piece on the
 *  new side, a removed one on the old side) gets an inline "Bring this back" —
 *  surgical undo of just this piece, right where you see what changed. */
function SideSymbol({
  s,
  tone,
  showSignature,
  entry,
  side,
  relFile,
  symbolMeaning,
  meaningOverride,
  onBringBack,
  busySymbol,
}: {
  s: ChangedSymbol;
  tone: string;
  showSignature: boolean;
  entry: AtlasHoverEntry | undefined;
  side: "previous" | "next";
  relFile: string;
  /** The model-written line for THIS piece on THIS side — what this exact
   *  function / class does now (on the "next" side) or used to do (on the
   *  "previous" side). The caller already picked the right side's map, so this
   *  is always the correct era. The most specific meaning we have, so it wins:
   *  it's what makes a multi-piece file's nodes each say something real instead
   *  of "a new function". Arrives after the instant paint and silently upgrades
   *  the node in place. */
  symbolMeaning?: string;
  /** The file-level generated line for this side (what it used to do on the
   *  "previous" side, what it does now on the "next" side). Used only when this
   *  is the single changed piece — then the file-level story IS this piece's
   *  story, so it beats both the atlas summary and the generic fallback. */
  meaningOverride?: string;
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
}) {
  const title = entry?.title?.trim() || titleize(s.identifier);
  // This piece's own model line for this side (the caller passed the right-era
  // map). Empty until the model writes it — the reader-facing node NEVER shows a
  // mined variable name, so while this is empty the node falls through to a
  // plain generic placeholder, then swaps to these words when they land.
  const ownLine = symbolMeaning?.trim() || "";
  // Meaning precedence, most-specific first: this piece's own model line →
  // the file-level generated line for a lone piece → the atlas summary → a
  // plain "what kind of thing changed" fallback. Every path lands on real
  // words, never an empty placeholder.
  const meaning =
    ownLine || meaningOverride?.trim() || entry?.summary?.trim() || pieceMeaning(s);
  const why = s.rationale?.trim() || "";
  // A modified piece has a prior version to restore (shown on the new side); a
  // deleted one can be brought back (shown on the old side). An added piece has
  // no earlier state, so it offers no undo.
  const canBringBack =
    !!onBringBack &&
    ((side === "next" && s.change === "modified") ||
      (side === "previous" && s.change === "deleted"));
  const busy = busySymbol === s.identifier;

  return (
    <li className="flex min-w-0 gap-1.5 leading-snug">
      <span className={"mt-1 w-2 shrink-0 text-center font-mono text-[11px] " + tone}>
        {s.change === "deleted" ? "−" : s.change === "added" ? "+" : "~"}
      </span>
      <div className="min-w-0">
        {/* Meaning-first headline: the real-world name + a plain change word. */}
        <div className="flex items-baseline gap-1.5">
          <span className="text-[12px] font-medium text-text-1">{title}</span>
          <span className="text-[10px] uppercase tracking-wide text-text-5">
            {changeWord(s.change)}
          </span>
        </div>
        {/* What it does / what happened to it, in plain English. */}
        <div className="text-[11px] leading-snug text-text-3">{meaning}</div>
        {/* Why this specific change, when a reason was recorded for the piece. */}
        {why ? (
          <div className="text-[11px] leading-snug text-text-3">
            <span className="text-text-5">Why: </span>
            {why}
          </div>
        ) : null}
        {/* Mechanism on demand: the raw identifier + kind, muted. The full
            signature (the noisiest, most code-shaped part) lives in the hover so
            it's there for an engineer without shouting at everyone else. */}
        <div
          className="mt-0.5 break-words font-mono text-[10px] text-text-5"
          title={showSignature && s.signature ? s.signature : undefined}
        >
          {s.identifier}
          <span className="ml-1.5">{prettyKind(s.kind)}</span>
        </div>
        {/* Surgical undo, right where you see the change. Only a piece with a
            prior saved version (a changed piece on the new side, a removed one
            on the old side) offers it — an added piece has nothing to go back
            to. Arctic-blue = the thing to click. */}
        {canBringBack ? (
          <button
            type="button"
            onClick={() => onBringBack!(s.identifier, relFile)}
            disabled={busy}
            className="mt-1 rounded border border-line-soft px-1.5 py-px text-[10.5px] text-text-3 hover:border-blue hover:text-blue disabled:opacity-60"
            title="Bring just this one piece back to its previous saved version"
          >
            {busy ? "Bringing back…" : "Bring this back"}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** A side-column ("Previous was this" / "New is this"). When the file is
 *  one-sided (a brand-new or fully-removed file) the empty side states that
 *  plainly instead of leaving a blank header. */
function SideColumn({
  label,
  symbols,
  tone,
  showSignature,
  emptyNote,
  index,
  filePath,
  side,
  relFile,
  sideLine,
  symbolMeanings,
  onBringBack,
  busySymbol,
}: {
  label: string;
  symbols: ChangedSymbol[];
  tone: string;
  showSignature: boolean;
  emptyNote: string;
  index: AtlasIndex | null;
  filePath: string | undefined;
  side: "previous" | "next";
  relFile: string;
  /** The generated file-level line for this side. Applied to a lone changed
   *  piece (see SideSymbol.meaningOverride); ignored when several pieces
   *  changed, since one file-level line can't speak for all of them. */
  sideLine?: string;
  /** Per-piece model meanings (identifier → sentence). Gives every node its
   *  own real description — the fix for a multi-piece file where the file-level
   *  line can't be attributed to any single piece. */
  symbolMeanings?: Map<string, string>;
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
}) {
  const lone = symbols.length === 1;
  return (
    <div className="min-w-0 flex-1 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-text-4">{label}</div>
      {symbols.length ? (
        <ul className="mt-1 space-y-1.5">
          {symbols.map((s) => (
            <SideSymbol
              key={`${s.change}:${s.identifier}`}
              s={s}
              tone={tone}
              showSignature={showSignature}
              entry={index ? lookupEntry(index, s.identifier, filePath) : undefined}
              side={side}
              relFile={relFile}
              symbolMeaning={symbolMeanings?.get(s.identifier)}
              meaningOverride={lone ? sideLine : undefined}
              onBringBack={onBringBack}
              busySymbol={busySymbol}
            />
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-[11.5px] leading-relaxed text-text-3">{emptyNote}</div>
      )}
    </div>
  );
}

/** A small dot separator for the compact when/where/who fact row. */
function Dot() {
  return (
    <span aria-hidden className="text-text-5">
      ·
    </span>
  );
}

export function SplitDiffHeader({
  note,
  when,
  author,
  repoRoot,
  commit,
  /** When the diff folds to a single inline column (narrow pane), the two
   *  side-headers can no longer align to left/right — stack them instead. */
  stacked,
  /** When set, each restorable piece offers an inline "Bring this back". Wired
   *  from a session's Changes tab (and the Time machine) so surgical undo lives
   *  right where you see what changed. Omitted on read-only diff views. */
  onBringBack,
  busySymbol,
}: {
  note: FileChangeNote;
  /** When this change landed (commit time, unix seconds). Omitted → no "when". */
  when?: number | null;
  /** Who made it (commit author). Omitted → no "by …". */
  author?: string | null;
  repoRoot: string;
  /** The commit this diff belongs to (unix sha). Scopes the generated
   *  before/what/why to that exact change; omitted → the live working-tree edit. */
  commit?: string | null;
  stacked: boolean;
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
}) {
  // The Code Atlas meaning index for this repo (one shared read per repo).
  // Degrades to null → the side-columns fall back to humanized identifiers.
  const [index, setIndex] = useState<AtlasIndex | null>(null);
  useEffect(() => {
    let alive = true;
    loadAtlasIndex(repoRoot).then((idx) => {
      if (alive) setIndex(idx);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // The richer, model-written story — what it USED TO DO, what it does NOW, and
  // WHY (+ how) — fetched on top of the instant grounded index and cached. The
  // header paints immediately from the change-note; this silently upgrades it in
  // place once the words arrive (no spinner the reader notices).
  const [exp, setExp] = useState<ChangeExplanation | null>(null);
  useEffect(() => {
    let alive = true;
    setExp(null);
    loadExplanation(repoRoot, note.file, commit).then((e) => {
      if (alive) setExp(e);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, note.file, commit]);

  // Per-piece meanings — what EACH changed function/class does NOW and what it
  // USED TO DO, in plain words, always model-written (never a mined variable
  // name). The file-level line above can't be split across several pieces, so
  // this is what makes every "New is this" / "Previous was this" node say
  // something real. The nodes paint from the grounded change-note now; these
  // silently upgrade them in place once the model's per-piece words arrive.
  const [symbolMeanings, setSymbolMeanings] = useState<SymbolMeanings>(() => ({
    now: new Map(),
    before: new Map(),
    complete: true,
  }));
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSymbolMeanings({ now: new Map(), before: new Map(), complete: true });
    // Re-poll while the model is still writing per-piece lines in the
    // background, so the AI words swap in LIVE without the change being
    // reopened. Bounded — a cold agent-CLI spawn is ~20s each, so we give it a
    // generous window then stop and let a later reopen finish the job.
    let tries = 0;
    const MAX_TRIES = 10;
    const poll = () => {
      loadSymbolExplanations(repoRoot, note.file, note.symbols, commit).then((m) => {
        if (!alive) return;
        setSymbolMeanings(m);
        if (!m.complete && tries < MAX_TRIES) {
          tries += 1;
          timer = setTimeout(poll, 3500);
        }
      });
    };
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [repoRoot, note.file, commit, note.symbols]);

  // Collapse the pieces index so a power user can reclaim the full diff height.
  const [open, setOpen] = useState(true);

  // Split the piece delta by which side it lives on. A `modified` piece shows
  // on BOTH sides (it was here before and is here after); its recorded
  // `signature` is the NEW shape, so it only annotates the right column.
  const previous = note.symbols.filter(
    (s) => s.change === "deleted" || s.change === "modified",
  );
  const next = note.symbols.filter(
    (s) => s.change === "added" || s.change === "modified",
  );

  const pieceCount = note.symbols.length;
  const summary = plainSummary(note.symbols, note.note);
  const where = whereParts(note.file);

  // The generated words, when they've arrived and actually carry content.
  const before = exp?.before?.trim() || "";
  const nowDoes = exp?.what?.trim() || "";
  // A brand-new file (nothing on the previous side) has no "before" to show.
  const hasBefore = before.length > 0 && note.symbols.some((s) => s.change !== "added");
  // The file-level Before → Now pair. A lone changed piece already shows this
  // same generated text inline in its column when the index is open, so we only
  // surface the pair when it isn't a repeat: several pieces changed (the pair is
  // the whole-file summary the per-piece rows break down), or the index is
  // collapsed (the pair is then the only place the before/now story lives).
  const showPair = (hasBefore || nowDoes.length > 0) && (pieceCount !== 1 || !open);

  return (
    <div className="shrink-0 border-b border-line-soft bg-bg-1/60">
      {/* Merged summary — the plain one-liner + a dead-visible why/when/where
          band, spanning the full width above both panes. */}
      <div className="border-b border-line-soft px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-text-1">
            {summary}
          </span>
          {pieceCount > 0 ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="shrink-0 rounded px-1.5 py-px text-[10.5px] text-text-4 hover:bg-bg-2 hover:text-text-2"
              title={open ? "Hide the list of changed pieces" : "Show what changed, in plain words"}
            >
              {open ? "Hide pieces" : `Show ${pieceCount} ${pieceCount === 1 ? "piece" : "pieces"}`}
            </button>
          ) : null}
        </div>

        {/* BEFORE → NOW — what this part of the project used to do, and what it
            does now, in plain words. Grounded index paints first; this pair
            silently appears once the generated words arrive and is cached, so
            reopening the same change is instant. A brand-new file has no
            "before", so it shows a single "what this adds" line instead. */}
        {showPair ? (
          hasBefore ? (
            <div
              className={
                "mt-2 grid gap-x-3 gap-y-1.5 " +
                (stacked ? "grid-cols-1" : "grid-cols-2")
              }
            >
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-text-4">Used to</div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-text-3">{before}</div>
              </div>
              {nowDoes ? (
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-text-4">Now</div>
                  <div className="mt-0.5 text-[11.5px] leading-snug text-text-1">{nowDoes}</div>
                </div>
              ) : (
                <div />
              )}
            </div>
          ) : (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wide text-text-4">What this adds</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-text-1">{nowDoes}</div>
            </div>
          )
        ) : null}

        {/* WHEN · WHERE · WHO — the reality, dead-visible. Every fact is real or
            omitted: the commit time, the file it's in, who made it. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-text-4">
          {when != null ? (
            <span title={absTime(when)}>{relTime(when)}</span>
          ) : null}
          {when != null ? <Dot /> : null}
          <span className="text-text-3" title={note.file}>
            {where.folder ? <span className="text-text-5">{where.folder}</span> : null}
            {where.base}
          </span>
          {author ? (
            <>
              <Dot />
              <span title="Who made this change">by {author}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* Two-column header aligned to the split panes (or stacked when the diff
          has folded to one inline column). Height-capped with its own scroll so
          a file with many pieces can't push the actual diff into a sliver — the
          index scrolls here, the diff keeps its room below. */}
      {open ? (
        <div className="max-h-[230px] overflow-y-auto">
          <div className={stacked ? "flex flex-col" : "flex"}>
            <SideColumn
              label="Previous was this"
              symbols={previous}
              tone="text-text-3"
              showSignature={false}
              emptyNote="New file — nothing was here before."
              index={index}
              filePath={note.file}
              side="previous"
              relFile={note.file}
              sideLine={before}
              symbolMeanings={symbolMeanings.before}
              onBringBack={onBringBack}
              busySymbol={busySymbol}
            />
            <div
              className={
                stacked
                  ? "border-t border-line-soft"
                  : "w-px shrink-0 self-stretch bg-line-soft"
              }
              aria-hidden
            />
            <SideColumn
              label="New is this"
              symbols={next}
              tone="text-accent"
              showSignature
              emptyNote="File removed — nothing is here now."
              index={index}
              filePath={note.file}
              side="next"
              relFile={note.file}
              sideLine={nowDoes}
              symbolMeanings={symbolMeanings.now}
              onBringBack={onBringBack}
              busySymbol={busySymbol}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

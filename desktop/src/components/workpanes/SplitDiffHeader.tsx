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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AtlasHoverEntry, ChangedSymbol, FileChangeNote } from "../../lib/api";
import { relativeAgeAuto } from "../../lib/relativeTime";
import { loadAtlasIndex, lookupEntry, type AtlasIndex } from "../../lib/atlasHover";
import { humanizeIdentifier as humanizeWords } from "../../lib/prove";
import { sentenceCase } from "@shared/textCase";
import { countOf } from "@shared/plural";
import {
  explanationFailed,
  forgetExplanation,
  isInferredFromDiff,
  loadExplanation,
  loadSymbolExplanations,
  whyIsRecorded,
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

/** Both forms of the plain noun, together.
 *
 *  They are written side by side because the summary below needs the plural
 *  and no rule can derive it: "enum" is spelled out for the non-engineer as
 *  "set of options", where the HEAD word takes the s. The local rule this
 *  replaces read only the final letter, found an "s", and summarised two
 *  changed enums as "Reworked 2 set of optionses." See lib/plural. */
type PlainKind = { one: string; many: string };

/** The same kinds, spelled out as a plain noun for the non-engineer summary
 *  ("function", "class") rather than the terse mechanism word ("fn"). */
function plainKind(kind: string): PlainKind {
  switch (prettyKind(kind)) {
    case "fn":
      return { one: "function", many: "functions" };
    case "struct":
      return { one: "structure", many: "structures" };
    case "impl":
      return { one: "implementation", many: "implementations" };
    case "class":
      return { one: "class", many: "classes" };
    case "enum":
      return { one: "set of options", many: "sets of options" };
    case "trait":
      return { one: "trait", many: "traits" };
    case "interface":
      return { one: "interface", many: "interfaces" };
    case "type":
      return { one: "type", many: "types" };
    default:
      return { one: "piece", many: "pieces" };
  }
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

/** Plain name for a piece, sharing BOTH steps with the Goals surface — the
 *  humanizer that produces the words and the casing that finishes them:
 *  `senderFor` → "Sender for", `fsm_happy_path` → "Fsm happy path". It shared
 *  only the first step before, and said in this comment that it shared the
 *  answer. The atlas title wins when present; this is the always-there
 *  fallback. */
function titleize(id: string): string {
  const words = humanizeWords(id).trim();
  if (!words) return id;
  return sentenceCase(words);
}

/** A plain-English "what kind of thing changed, and how" line, from the AST
 *  facts alone — the fallback meaning when the atlas has no richer summary. */
function pieceMeaning(s: ChangedSymbol): string {
  const kind = plainKind(s.kind).one;
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
  const groups: { kind: PlainKind; names: string[] }[] = [];
  for (const s of symbols) {
    const kind = plainKind(s.kind);
    const g = groups.find((x) => x.kind.one === kind.one);
    const name = humanizeWords(s.identifier).trim();
    if (g) g.names.push(name);
    else groups.push({ kind, names: [name] });
  }
  const phrases = groups.map((g) => {
    const head = countOf(g.names.length, g.kind.one, g.kind.many);
    const named = g.names.filter(Boolean);
    return named.length ? `${head} (${named.join(", ")})` : head;
  });
  const list =
    phrases.length <= 1
      ? phrases.join("")
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return `${verb} ${list}.`;
}

/** Relative age of a commit time (unix seconds, tolerating milliseconds).
 *
 *  This said it was "the same shape the Goals cards use, so 'when' reads
 *  consistently across surfaces" — while being a hand copy that skipped the
 *  weeks rung the Goals cards have, so a 10-day-old commit read "10d ago"
 *  here and "1w ago" there. Asserting consistency is not the same as sharing
 *  the code that produces it. */
function relTime(value: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeAuto(value);
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

/** The piece's real-world name: the Code Atlas title when we have one, else the
 *  identifier humanized with the SAME helper the Goals surface uses. */
function pieceTitle(s: ChangedSymbol, entry: AtlasHoverEntry | undefined): string {
  return entry?.title?.trim() || titleize(s.identifier);
}

/** Meaning precedence, most-specific first: this piece's own model line for
 *  this side → the file-level generated line when it is the lone changed piece
 *  → the atlas summary → a plain "what kind of thing changed" fallback. Every
 *  path lands on real words, never an empty placeholder.
 *
 *  Shared with the focused-piece caption in the diff below, so clicking a piece
 *  shows down there exactly the sentence it shows up here. */
function pieceLine(
  s: ChangedSymbol,
  symbolMeaning: string | undefined,
  meaningOverride: string | undefined,
  entry: AtlasHoverEntry | undefined,
): string {
  return (
    symbolMeaning?.trim() ||
    meaningOverride?.trim() ||
    entry?.summary?.trim() ||
    pieceMeaning(s)
  );
}

/** Which side-column a piece appears in. A `modified` piece is on both. */
function onSide(s: ChangedSymbol, side: "previous" | "next"): boolean {
  return side === "previous"
    ? s.change === "deleted" || s.change === "modified"
    : s.change === "added" || s.change === "modified";
}

/** The piece the reader clicked, handed up so the diff below can highlight its
 *  lines and carry its plain-language line down there with it. Re-sent whenever
 *  the model finishes writing that line, so the caption upgrades in place
 *  exactly as the node above does. */
export type FocusPick = {
  side: "previous" | "next";
  symbol: ChangedSymbol;
  title: string;
  meaning: string;
};

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
  selected,
  onSelect,
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
  /** This piece is the one currently highlighted in the diff below. */
  selected?: boolean;
  /** Show me this piece in the code: highlight its lines below and caption
   *  them with the same words this node shows. Clicking the selected piece
   *  again clears it. Absent on a surface with no diff underneath. */
  onSelect?: () => void;
}) {
  const title = pieceTitle(s, entry);
  // This piece's own model line for this side (the caller passed the right-era
  // map). Empty until the model writes it — the reader-facing node NEVER shows a
  // mined variable name, so while this is empty the node falls through to a
  // plain generic placeholder, then swaps to these words when they land.
  const meaning = pieceLine(s, symbolMeaning, meaningOverride, entry);
  const why = s.rationale?.trim() || "";
  // A modified piece has a prior version to restore (shown on the new side); a
  // deleted one can be brought back (shown on the old side). An added piece has
  // no earlier state, so it offers no undo.
  const canBringBack =
    !!onBringBack &&
    ((side === "next" && s.change === "modified") ||
      (side === "previous" && s.change === "deleted"));
  const busy = busySymbol === s.identifier;

  // The reader-facing part of the node: name, plain meaning, why, mechanism.
  // Lifted out so it can be wrapped in a button where there is a diff below to
  // point at, and left as plain markup where there isn't.
  const body = (
    <>
      {/* Meaning-first headline: the real-world name + a plain change word. */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-medium text-text-1">{title}</span>
        <span className="section-label">{changeWord(s.change)}</span>
      </div>
      {/* What it does / what happened to it, in plain English. */}
      <div className="text-xs leading-snug text-text-3">{meaning}</div>
      {/* Why this specific change, when a reason was recorded for the piece. */}
      {why ? (
        <div className="text-xs leading-snug text-text-3">
          <span className="text-text-5">Why: </span>
          {why}
        </div>
      ) : null}
      {/* Mechanism on demand: the raw identifier + kind, muted. The full
          signature (the noisiest, most code-shaped part) lives in the hover so
          it's there for an engineer without shouting at everyone else. */}
      <div
        className="mt-0.5 break-words font-mono text-2xs text-text-5"
        title={showSignature && s.signature ? s.signature : undefined}
      >
        {s.identifier}
        <span className="ml-1.5">{prettyKind(s.kind)}</span>
      </div>
    </>
  );

  return (
    <li className="flex min-w-0 gap-1.5 leading-snug">
      <span className={"mt-1 w-2 shrink-0 text-center font-mono text-xs " + tone}>
        {s.change === "deleted" ? "\u2212" : s.change === "added" ? "+" : "~"}
      </span>
      <div className="min-w-0 flex-1">
        {/* Click the piece, see the piece: its lines light up in the code below
            and the same sentence is pinned over them. The rail is the accent
            that also marks those lines, so the two reads as one selection. A
            transparent rail when unpicked keeps the text from shifting. */}
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={!!selected}
            title={
              selected
                ? "Stop highlighting this piece in the code below"
                : "Show this piece in the code below"
            }
            className={
              "-ml-1.5 block w-full rounded border-l-2 pl-1.5 pr-1 text-left hover:bg-state-hover " +
              (selected
                ? "border-[var(--color-accent)] bg-state-hover"
                : "border-transparent")
            }
          >
            {body}
          </button>
        ) : (
          body
        )}
        {/* Surgical undo, right where you see the change. Only a piece with a
            prior saved version (a changed piece on the new side, a removed one
            on the old side) offers it — an added piece has nothing to go back
            to. Arctic-blue = the thing to click. */}
        {canBringBack ? (
          <button
            type="button"
            onClick={() => onBringBack!(s.identifier, relFile)}
            disabled={busy}
            className="mt-1 rounded border border-line-soft px-1.5 py-px text-xs text-text-3 hover:border-blue hover:text-blue disabled:opacity-60"
            title="Bring just this one piece back to its previous saved version"
          >
            {busy ? "Bringing back\u2026" : "Bring this back"}
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
  selectedIdentifier,
  onSelect,
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
  /** The piece currently highlighted in the diff below, if it is on this side. */
  selectedIdentifier?: string | null;
  onSelect?: (identifier: string) => void;
}) {
  const lone = symbols.length === 1;
  return (
    <div className="min-w-0 flex-1 px-3 py-2">
      <div className="section-label">{label}</div>
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
              selected={selectedIdentifier === s.identifier}
              onSelect={onSelect ? () => onSelect(s.identifier) : undefined}
            />
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-sm leading-relaxed text-text-3">{emptyNote}</div>
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

/** Below this body width the two side-by-side columns stop being readable and
 *  Monaco folds its split into one inline column — so the header's Previous/New
 *  pair has to stack to keep saying the truth about what's beside what. Lives
 *  here because it is this header's own constraint; every surface that mounts
 *  it (a session's Changes tab, a pull request's Files tab) measures against
 *  the same number rather than picking its own. */
export const SPLIT_INLINE_PX = 700;

/** Tracks whether a diff body is too narrow for side-by-side columns, so a
 *  caller can hand `stacked` to SplitDiffHeader. Returns the ref to put on the
 *  measured element. */
export function useStackedDiff(): [
  React.RefObject<HTMLDivElement | null>,
  boolean,
] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setNarrow(e.contentRect.width < SPLIT_INLINE_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, narrow];
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
  onFocusPiece,
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
  /** Told which piece the reader picked, so the diff below can highlight it and
   *  caption those lines with the same words this header shows. Re-sent when
   *  the model finishes writing that line. Must be referentially stable — it is
   *  an effect dependency. Omit on a surface with no diff underneath. */
  onFocusPiece?: (pick: FocusPick | null) => void;
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
  // Bumped by the retry control after a failure. It is the only thing retry
  // touches: the picked piece, the open pieces index and the diff's scroll all
  // belong to other state and are left exactly where the reader put them.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setExp(null);
    loadExplanation(repoRoot, note.file, commit).then((e) => {
      if (alive) setExp(e);
    });
    return () => {
      alive = false;
    };
  }, [repoRoot, note.file, commit, retry]);
  const retryExplanation = () => {
    forgetExplanation(repoRoot, note.file, commit);
    setRetry((n) => n + 1);
  };

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

  // Which piece the reader picked, if any. Held here because this is where the
  // pieces are listed; the diff below is told about it rather than owning it.
  const [pick, setPick] = useState<{ side: "previous" | "next"; identifier: string } | null>(
    null,
  );
  // A different file (or a different commit's version of it) is a different set
  // of pieces — carrying a selection across would highlight a name that happens
  // to match in code nobody picked.
  useEffect(() => {
    setPick(null);
  }, [note.file, commit]);

  // Publish the pick, and keep republishing it: this piece's plain-language
  // line is written by the model AFTER the first paint, and the caption pinned
  // over the code below has to upgrade in place exactly as the node here does.
  useEffect(() => {
    if (!onFocusPiece) return;
    if (!pick) {
      onFocusPiece(null);
      return;
    }
    const sideSymbols = note.symbols.filter((x) => onSide(x, pick.side));
    const picked = sideSymbols.find((x) => x.identifier === pick.identifier);
    if (!picked) {
      onFocusPiece(null);
      return;
    }
    const entry = index ? lookupEntry(index, picked.identifier, note.file) : undefined;
    const sideMap = pick.side === "previous" ? symbolMeanings.before : symbolMeanings.now;
    // The file-level line only speaks for a piece when it is the ONLY one that
    // changed on that side — the same rule the column applies.
    const override =
      sideSymbols.length === 1
        ? (pick.side === "previous" ? exp?.before : exp?.what) || undefined
        : undefined;
    onFocusPiece({
      side: pick.side,
      symbol: picked,
      title: pieceTitle(picked, entry),
      meaning: pieceLine(picked, sideMap.get(picked.identifier), override, entry),
    });
  }, [pick, note.symbols, note.file, index, symbolMeanings, exp, onFocusPiece]);

  /** Clicking the picked piece again clears it, so the diff goes back to plain. */
  const choose = (side: "previous" | "next") => (identifier: string) =>
    setPick((prev) =>
      prev && prev.side === side && prev.identifier === identifier
        ? null
        : { side, identifier },
    );

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

  // WHY — why this change was made, and how it now works.
  //
  // This band used to exist here and had gone missing, so a reviewer got the
  // before/after of a change with no account of the reason for it. It is back,
  // and it now says WHOSE account it is. `aura snapshot-file --why` records the
  // author's own words against a file; when one is recorded for this exact
  // revision the backend returns it verbatim and Aura quotes it. Otherwise Aura
  // wrote the sentence by reading the diff, which is a different kind of claim
  // and is marked as one. Nothing is invented for a change nobody explained:
  // with no words at all, the band simply isn't there.
  const why = exp?.why?.trim() || "";
  const whyRecorded = whyIsRecorded(exp);
  const whyAuthor = (exp?.why_author ?? "").trim();
  const failed = explanationFailed(exp);

  return (
    <div className="shrink-0 border-b border-line-soft bg-bg-1/60">
      {/* Merged summary — the plain one-liner + a dead-visible why/when/where
          band, spanning the full width above both panes. */}
      <div className="border-b border-line-soft px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 text-base leading-snug text-text-1">
            {summary}
          </span>
          {pieceCount > 0 ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="shrink-0 rounded px-1.5 py-px text-xs text-text-4 hover:bg-state-hover hover:text-text-2"
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
                <div className="section-label">Used to</div>
                <div className="mt-0.5 text-sm leading-snug text-text-3">{before}</div>
              </div>
              {nowDoes ? (
                <div className="min-w-0">
                  <div className="section-label">Now</div>
                  <div className="mt-0.5 text-sm leading-snug text-text-1">{nowDoes}</div>
                </div>
              ) : (
                <div />
              )}
            </div>
          ) : (
            <div className="mt-2">
              <div className="section-label">What this adds</div>
              <div className="mt-0.5 text-sm leading-snug text-text-1">{nowDoes}</div>
            </div>
          )
        ) : null}

        {why ? (
          <p className="mt-2 text-sm leading-snug text-text-2">
            <span className="text-text-5">
              {whyRecorded ? "Why · " : "Why & how · "}
            </span>
            {why}
            <span
              className="ml-1.5 whitespace-nowrap text-xs text-text-4"
              title={
                whyRecorded
                  ? "The person or agent who made this change wrote this reason down against this file."
                  : isInferredFromDiff(exp)
                    ? "Nobody recorded a reason, and no model was reachable, so Aura worked this out from the change itself."
                    : "Nobody recorded a reason, so Aura worked this out by reading the change itself."
              }
            >
              {whyRecorded
                ? whyAuthor
                  ? `stated by ${whyAuthor}`
                  : "stated"
                : "Aura's reading"}
            </span>
          </p>
        ) : null}

        {/* A failed request is not "nothing to say". The diff below stays fully
            usable either way, and retrying costs the reader nothing they had
            already done — see `retryExplanation`. */}
        {failed ? (
          <p className="mt-2 flex flex-wrap items-baseline gap-1.5 text-sm leading-snug text-text-3">
            <span>Aura couldn&apos;t write an account of this change.</span>
            <button
              type="button"
              onClick={retryExplanation}
              className="rounded px-1.5 py-px text-xs text-text-2 underline decoration-dotted underline-offset-2 hover:bg-state-hover hover:text-text-1"
            >
              Try again
            </button>
          </p>
        ) : null}

        {/* WHEN · WHERE · WHO — the reality, dead-visible. Every fact is real or
            omitted: the commit time, the file it's in, who made it. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-4">
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
              emptyNote="New file. Nothing was here before."
              index={index}
              filePath={note.file}
              side="previous"
              relFile={note.file}
              sideLine={before}
              symbolMeanings={symbolMeanings.before}
              onBringBack={onBringBack}
              busySymbol={busySymbol}
              selectedIdentifier={pick?.side === "previous" ? pick.identifier : null}
              onSelect={onFocusPiece ? choose("previous") : undefined}
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
              emptyNote="File removed. Nothing is here now."
              index={index}
              filePath={note.file}
              side="next"
              relFile={note.file}
              sideLine={nowDoes}
              symbolMeanings={symbolMeanings.now}
              onBringBack={onBringBack}
              busySymbol={busySymbol}
              selectedIdentifier={pick?.side === "next" ? pick.identifier : null}
              onSelect={onFocusPiece ? choose("next") : undefined}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

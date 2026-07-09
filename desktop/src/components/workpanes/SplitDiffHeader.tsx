// SplitDiffHeader — the three-block "why this changed" header that sits above
// the committed side-by-side (split) diff.
//
// Replaces the loose prose caption with a shape that mirrors the diff below:
//   1. a MERGED summary block spanning the full width — the plain-language
//      one-liner Aura composed for this file + the recorded reason (the "why").
//   2. a two-column header row aligned to the split panes:
//        • "Previous was this" over the LEFT (old) pane — the pieces that were
//          here before (deleted + the prior shape of modified ones).
//        • "New is this" over the RIGHT (new) pane — the pieces that are here
//          now (added + the new shape of modified ones).
//
// MEANING-FIRST: a non-engineer can't read `AgentRef struct pub struct
// AgentRef(pub String)`. So every piece leads with its real-world MEANING —
// pulled from the Code Atlas (`aura atlas`): a humanized title ("Agent
// Reference") and a one-line plain-English summary of what it does. The
// recorded per-piece reason rides under it. The raw identifier + kind +
// signature are demoted to a muted, monospace "mechanism on demand" line for
// the engineers who want it. When the atlas hasn't been generated yet, the
// title falls back to a humanized form of the identifier so it still reads.
//
// HONESTY: the change shape comes from the same `aura change-note <sha> --json`
// payload the diff already uses (AST diff + call graph, no AI tokens); the
// meaning comes from the atlas (structural by default). The side-columns NEVER
// invent narrative — they list the real changed pieces on each side. The full
// old/new TEXT is the Monaco diff below; this header is the reader-facing index
// over it, height-capped so it never starves the diff of room.

import { useEffect, useState } from "react";
import type { AtlasHoverEntry, ChangedSymbol, FileChangeNote } from "../../lib/api";
import { loadAtlasIndex, lookupEntry, type AtlasIndex } from "../../lib/atlasHover";

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

/** Fallback title when the atlas has no entry for a piece: turn `fsm_happy_path`
 *  or `AgentRef` into "Fsm Happy Path" / "Agent Ref" so it still reads like
 *  words, not code. */
function humanizeIdentifier(id: string): string {
  const spaced = id
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return id;
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One piece inside a side-column, meaning-first. `showSignature` gates the raw
 *  signature so it only renders on the side it truthfully belongs to. `entry`
 *  is the atlas meaning when we have it. When `onBringBack` is set, a piece that
 *  can be recovered (a changed piece on the new side, a removed one on the old
 *  side) gets an inline "Bring this back" — surgical undo of just this piece,
 *  right where you see what changed. */
function SideSymbol({
  s,
  tone,
  showSignature,
  entry,
  side,
  relFile,
  onBringBack,
  busySymbol,
}: {
  s: ChangedSymbol;
  tone: string;
  showSignature: boolean;
  entry: AtlasHoverEntry | undefined;
  side: "previous" | "next";
  relFile: string;
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
}) {
  const title = entry?.title?.trim() || humanizeIdentifier(s.identifier);
  const meaning = entry?.summary?.trim() || "";
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
        {/* What it does, in plain English. */}
        {meaning ? (
          <div className="text-[11px] leading-snug text-text-3">{meaning}</div>
        ) : null}
        {/* Why this specific change, when a reason was recorded for the piece. */}
        {why ? (
          <div className="text-[11px] leading-snug text-text-3">
            <span className="text-text-5">Why: </span>
            {why}
          </div>
        ) : null}
        {/* Mechanism on demand: the raw identifier + kind + signature, muted so
            engineers can still read the exact shape without it shouting. */}
        <div className="mt-0.5 break-words font-mono text-[10px] text-text-5">
          {s.identifier}
          <span className="ml-1.5">{prettyKind(s.kind)}</span>
          {showSignature && s.signature ? (
            <span className="ml-1.5 text-text-4">{s.signature}</span>
          ) : null}
        </div>
        {/* Surgical undo, right where you see the change. Only a piece with a
            prior saved version (a changed piece on the new side, a removed one
            on the old side) offers it — an added piece has nothing to go back
            to. */}
        {canBringBack ? (
          <button
            type="button"
            onClick={() => onBringBack!(s.identifier, relFile)}
            disabled={busy}
            className="mt-1 rounded border border-line-soft px-1.5 py-px text-[10.5px] text-text-3 hover:border-accent hover:text-accent disabled:opacity-60"
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
  onBringBack?: (symbol: string, relFile: string) => void;
  busySymbol?: string | null;
}) {
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

export function SplitDiffHeader({
  note,
  reason,
  repoRoot,
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
  /** The commit's recorded reason (subject line), when present. */
  reason: string | null;
  repoRoot: string;
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

  return (
    <div className="shrink-0 border-b border-line-soft bg-bg-1/60">
      {/* Merged summary — the one-liner + why, spanning the full width above
          both panes. This carries the narrative; the side-columns stay terse. */}
      <div className="border-b border-line-soft px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 rounded bg-bg-2 px-1.5 py-px text-[10px] uppercase tracking-wide text-text-4">
            Change
          </span>
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-text-1">
            {note.note}
            {reason ? (
              <span className="text-text-3">
                {" "}
                — <span className="italic">{reason}</span>
              </span>
            ) : null}
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
              onBringBack={onBringBack}
              busySymbol={busySymbol}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

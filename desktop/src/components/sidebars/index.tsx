// The three sidebar bodies the nav rail can reach: Files, Git and History.
// Each owns its own data fetch and scroll; a row click opens the detail in
// the main work surface.
//
// It used to hold eight. Impacts, Search, Team (collaboration + sentinel
// inbox + activity), Agents and Zones were all left behind by the chat-first
// sweep — their destinations went away and the panels stayed, exported and
// imported by nobody, for 1,253 lines. Their jobs live elsewhere now: search
// is the command palette, agents and zones are the Team radar, impacts are
// the rail's own alerts. Keeping them cost nothing at runtime and a great
// deal every time someone swept this file for a design change and found
// seven stale panel headers to "fix".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileTree } from "../FileTree";
import { clockTimeFromSecs } from "../../lib/clockTime";
import {
  api,
  type AuditEntry,
  type CommitEntry,
  type IntentEntry,
  type SnapshotEntry,
} from "../../lib/api";
import { IntentMatchChip } from "../IntentMatchChip";
import { ChangesPanel } from "../rightrail/ChangesPanel";
import { CommitGraph } from "../CommitGraph";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { Segment } from "../ui/segment";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Common = { repoRoot: string };

// ── Files (Git-status overlay folded in) ───────────────────────────────

export function FilesSidebar({
  repoRoot,
  selected,
  onSelect,
  onSelectSplit,
}: Common & {
  selected: string | null;
  onSelect: (p: string) => void;
  onSelectSplit?: (p: string, direction: "row" | "column") => void;
}) {
  // The Files tab is the tree, and nothing else. The per-row git-status mark
  // is the FileTree's own job (it reads git_status internally).
  //
  // A band used to sit above it reading "● 59 changed files", on its own 5s
  // `gitDiffStats` poll. It was written when this tab had no neighbour that
  // could say so — but the rail's tab strip, 24px directly above, now carries
  // a Changes tab whose count badge is `diffStats.changed_files`: the same
  // number, off the same call, in the same 310px column. The band restated it
  // and then offered nothing to do about it, while the badge beside it both
  // says the number and takes you to the list. Two pollers for one figure,
  // one of them a dead end.
  return (
    <FileTree
      root={repoRoot}
      selected={selected}
      onSelect={onSelect}
      onSelectSplit={onSelectSplit}
    />
  );
}

// ── Git (Source Control) ───────────────────────────────────────────────
//
// Mirrors what every editor's SCM panel does: branch chip on top, message
// box, list of staged + unstaged + untracked changes. Click a row to open
// the file (the existing diff toggle in the work-surface toolbar then
// shows the diff vs HEAD). Stage / unstage with the per-row +/-, then
// commit. Discard guarded by a confirm — we don't shell out to `git
// clean`, so untracked files stay safe even if you click discard.

export function GitSidebar({
  repoRoot,
  onOpen,
  onBeforeCommit,
}: Common & {
  /** Mode mirrors the row click intent — see ChangesPanel `OpenMode`. */
  onOpen: (path: string, mode: "diff" | "diff-new-tab" | "edit") => void;
  /** Optional pre-flight gate. When supplied, called before
   *  `git commit` runs — return true to proceed, false to abort
   *  (the dialog opener owns surfacing why). Used by the strict-mode
   *  commit guard (Wave B4). */
  onBeforeCommit?: () => Promise<boolean>;
}) {
  return (
    <ChangesPanel
      repoRoot={repoRoot}
      onBeforeCommit={onBeforeCommit}
      onOpenFile={(path, mode) => onOpen(repoFilePath(repoRoot, path), mode)}
    />
  );
}

function repoFilePath(root: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return `${root.replace(/\/$/, "")}/${rel}`;
}


// ── History (intents + snapshots + commits, unified) ──────────────────
//
// Replaces the snapshot-only Timeline. Renders one chronological feed
// where every kind has its own glyph + accent:
//   • intent  — what the agent set out to do
//   • snapshot — pre-edit AST backup
//   • commit  — git history
// Day headers separate the stream so scanning by date is easy.

export type HistoryEvent =
  | { kind: "intent"; ts: number; entry: IntentEntry }
  | { kind: "snapshot"; ts: number; entry: SnapshotEntry }
  | { kind: "commit"; ts: number; entry: CommitEntry }
  | { kind: "audit"; ts: number; entry: AuditEntry };

// Page size per source. The merged feed gets up to 3× this many rows per
// page; we trade a slightly chunky first paint for fewer round-trips.
const HISTORY_PAGE = 200;
const ROW_H = 38;
const HEADER_H = 24;

// Chat-first sweep — audit chip dropped (low-signal; the surface lives
// on the PR review pane). Filter type intentionally stays inclusive so
// older callers that still pass "audit" don't crash; we just collapse
// it to "all" at the chip-row level.
type Filter = "all" | "intent" | "snapshot" | "commit" | "audit";

const HISTORY_FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "intent", label: "Reasons" },
  { value: "snapshot", label: "Save points" },
  { value: "commit", label: "Commits" },
];

// Flat list lets the virtualizer measure rows without nested groups.
type FlatItem =
  | { kind: "header"; day: string }
  | { kind: "event"; ev: HistoryEvent };

export function HistorySidebar({
  repoRoot,
  onOpen,
  initialFilter,
  initialView,
}: Common & {
  onOpen: (ev: HistoryEvent) => void;
  initialFilter?: Filter;
  initialView?: "list" | "graph";
}) {
  const [filter, setFilter] = useState<Filter>(initialFilter ?? "all");
  // List (the merged intent/snapshot/commit/audit timeline) vs Graph (the
  // branch-topology commit rail — VS Code "Source Control → Graph" parity).
  // Initial view honours a deep-link from the Source Control branch-graph
  // button; the in-header toggle owns it thereafter.
  const [view, setView] = useState<"list" | "graph">(initialView ?? "list");
  const [graphReload, setGraphReload] = useState(0);
  // External filter override: when the StatusBar audit chip is clicked
  // it bumps `initialFilter` to "audit". Reflect that here without
  // resetting on every re-render.
  useEffect(() => {
    if (initialFilter && initialFilter !== filter) setFilter(initialFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilter]);
  const [intents, setIntents] = useState<IntentEntry[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [hasMoreIntent, setHasMoreIntent] = useState(true);
  const [hasMoreSnap, setHasMoreSnap] = useState(true);
  const [hasMoreCommit, setHasMoreCommit] = useState(true);
  const [hasMoreAudit, setHasMoreAudit] = useState(true);
  const [loading, setLoading] = useState(true);
  const intentCursor = useRef<number | undefined>(undefined);
  const snapCursor = useRef<number | undefined>(undefined);
  const commitCursor = useRef<number | undefined>(undefined);
  const auditCursor = useRef<number | undefined>(undefined);
  // Bumped on filter/repo change so a stale fetch can't clobber a fresh page.
  const generation = useRef(0);
  const fetching = useRef(false);

  const reset = useCallback(() => {
    generation.current += 1;
    intentCursor.current = undefined;
    snapCursor.current = undefined;
    commitCursor.current = undefined;
    auditCursor.current = undefined;
    setIntents([]);
    setSnapshots([]);
    setCommits([]);
    setAudits([]);
    setHasMoreIntent(filter === "all" || filter === "intent");
    setHasMoreSnap(filter === "all" || filter === "snapshot");
    setHasMoreCommit(filter === "all" || filter === "commit");
    setHasMoreAudit(filter === "all" || filter === "audit");
    setLoading(true);
  }, [filter]);

  const loadPage = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    const myGen = generation.current;
    const wantIntent = filter === "all" || filter === "intent";
    const wantSnap = filter === "all" || filter === "snapshot";
    const wantCommit = filter === "all" || filter === "commit";
    const wantAudit = filter === "all" || filter === "audit";
    try {
      const [iPage, sPage, cList, aPage] = await Promise.all([
        wantIntent && hasMoreIntent
          ? api
              .auraReadIntentLogV2(repoRoot, HISTORY_PAGE, intentCursor.current)
              .catch(() => null)
          : Promise.resolve(null),
        wantSnap && hasMoreSnap
          ? api
              .auraListSnapshotsV2(repoRoot, HISTORY_PAGE, snapCursor.current)
              .catch(() => null)
          : Promise.resolve(null),
        // git_recent_commits has no cursor yet — fetch once on first page.
        wantCommit && hasMoreCommit && commitCursor.current === undefined
          ? api.gitRecentCommits(repoRoot, 200).catch(() => [])
          : Promise.resolve(null),
        wantAudit && hasMoreAudit
          ? api
              .auraReadAuditLogV2(repoRoot, HISTORY_PAGE, auditCursor.current)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (generation.current !== myGen) return;
      if (iPage) {
        setIntents((prev) => [...prev, ...iPage.entries]);
        setHasMoreIntent(iPage.has_more);
        intentCursor.current = iPage.oldest_ts;
      }
      if (sPage) {
        setSnapshots((prev) => [...prev, ...sPage.entries]);
        setHasMoreSnap(sPage.has_more);
        snapCursor.current = sPage.oldest_mtime;
      }
      if (cList) {
        setCommits(cList);
        setHasMoreCommit(false);
        commitCursor.current = 0;
      }
      if (aPage) {
        setAudits((prev) => [...prev, ...aPage.entries]);
        setHasMoreAudit(aPage.has_more);
        auditCursor.current = aPage.oldest_ts;
      }
    } finally {
      if (generation.current === myGen) {
        setLoading(false);
      }
      fetching.current = false;
    }
  }, [repoRoot, filter, hasMoreIntent, hasMoreSnap, hasMoreCommit, hasMoreAudit]);

  // Reset + load first page on repo or filter change.
  useEffect(() => {
    reset();
    // Defer one tick so reset's state lands before loadPage reads it.
    const id = window.setTimeout(() => void loadPage(), 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, filter]);

  const refresh = useCallback(() => {
    reset();
    window.setTimeout(() => void loadPage(), 0);
  }, [reset, loadPage]);

  const events: HistoryEvent[] = useMemo(() => {
    const merged: HistoryEvent[] = [
      ...intents.map((e) => ({ kind: "intent" as const, ts: e.timestamp, entry: e })),
      ...snapshots.map((e) => ({ kind: "snapshot" as const, ts: e.mtime, entry: e })),
      ...commits.map((e) => ({ kind: "commit" as const, ts: e.timestamp, entry: e })),
      ...audits.map((e) => ({ kind: "audit" as const, ts: e.timestamp, entry: e })),
    ];
    merged.sort((a, b) => b.ts - a.ts);
    return merged;
  }, [intents, snapshots, commits, audits]);

  // Build a flat list with day headers inline so the virtualizer sees a
  // single sequence. Headers are short rows; events are ~38px.
  const flat: FlatItem[] = useMemo(() => {
    const out: FlatItem[] = [];
    let lastDay = "";
    for (const ev of events) {
      const d = ev.ts > 0 ? new Date(ev.ts * 1000).toISOString().slice(0, 10) : "—";
      if (d !== lastDay) {
        out.push({ kind: "header", day: d });
        lastDay = d;
      }
      out.push({ kind: "event", ev });
    }
    return out;
  }, [events]);

  const hasMore = hasMoreIntent || hasMoreSnap || hasMoreCommit || hasMoreAudit;
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flat.length + (hasMore ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      if (i >= flat.length) return ROW_H;
      return flat[i].kind === "header" ? HEADER_H : ROW_H;
    },
    overscan: 8,
  });

  // Trigger load when the sentinel row is rendered (overscan ensures this
  // fires ~200px before the user actually reaches the bottom).
  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    if (!hasMore || loading) return;
    const last = items[items.length - 1];
    if (last && last.index >= flat.length) {
      void loadPage();
    }
  }, [items, hasMore, loading, flat.length, loadPage]);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-2 h-9 px-3 border-b border-line-soft flex-shrink-0 min-w-0">
        <span className="section-label shrink-0">
          History
        </span>
        {/* List = the merged timeline; Graph = the branch-topology rail
            (VS Code "Source Control → Graph" parity). */}
        <Segment
          value={view}
          onChange={setView}
          size="xs"
          ariaLabel="History view"
          className="shrink-0"
          options={[
            { value: "list", label: "List", title: "Timeline list" },
            { value: "graph", label: "Graph", title: "Branch graph" },
          ]}
        />
        <div className="flex-1 min-w-0 flex items-center justify-end">
          {view === "list" && (
            <Select
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              options={HISTORY_FILTER_OPTIONS}
              className="text-xs h-6 w-auto"
            />
          )}
        </div>
        {/* Refresh belongs to whichever view is showing. It used to be
            gated on `list`, and the graph's own refresh lived in a header
            this host switches off — so in Graph view the panel had no way
            to reload at all. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => (view === "graph" ? setGraphReload((k) => k + 1) : refresh())}
          title="Refresh"
          className="shrink-0 text-text-4 hover:text-text-1"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </Button>
      </header>
      {view === "graph" ? (
        <div className="flex-1 min-h-0">
          <CommitGraph repoRoot={repoRoot} reloadToken={graphReload} />
        </div>
      ) : (
      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto">
        {loading && flat.length === 0 ? (
          <HintLoading />
        ) : flat.length === 0 ? (
          <HistoryEmpty filter={filter} />
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {items.map((vi) => {
              const isSentinel = vi.index >= flat.length;
              const item = isSentinel ? null : flat[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {isSentinel ? (
                    <div className="px-4 py-2 text-text-4 text-xs">
                      {loading ? <AsciiSpinner /> : "·"}
                    </div>
                  ) : item!.kind === "header" ? (
                    <div className="section-label px-4 pt-3 pb-1">
                      {item!.day}
                    </div>
                  ) : (
                    <HistoryRow
                      ev={item!.ev}
                      onOpen={() => onOpen(item!.ev)}
                      repoRoot={repoRoot}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function HistoryRow({
  ev,
  onOpen,
  repoRoot,
}: {
  ev: HistoryEvent;
  onOpen: () => void;
  repoRoot: string;
}) {
  // Event KIND is carried by the row's glyph and its label — inking each kind
  // its own colour (violet / amber / green) made a scrolling history read as
  // confetti and taught nothing. Only a real failure keeps colour.
  const tone =
    ev.kind === "audit" && ev.entry.severity === "fail"
      ? "text-red"
      : "text-text-3";
  const time = ev.ts ? hhmm(ev.ts) : "";
  const [primary, secondary] = labelFor(ev);
  // Intent-only: changeset preview chip + right-click split/merge.
  const intentChangeset =
    ev.kind === "intent" ? ev.entry.changeset ?? null : null;
  const fileCount = intentChangeset?.files?.length ?? 0;
  const sourceTag = intentChangeset?.source ?? null;
  function handleContext(e: React.MouseEvent) {
    if (ev.kind !== "intent") return;
    e.preventDefault();
    window.dispatchEvent(
      new CustomEvent("aura:open-intent-edit", {
        detail: { intentTs: ev.entry.timestamp },
      }),
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={handleContext}
      className="w-full flex items-start gap-3 px-4 py-1.5 hover:bg-state-hover text-left"
      title={ev.kind === "intent" ? "Right-click to split or merge" : undefined}
    >
      <span className={`text-2xs mt-0.5 w-12 ${tone}`}>
        {kindBadge(ev.kind)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-text-1 text-sm truncate flex items-center gap-1.5">
          {ev.kind === "commit" && (
            <IntentMatchChip repoRoot={repoRoot} sha={ev.entry.sha} />
          )}
          <span className="truncate">{primary}</span>
        </div>
        {secondary && (
          <div className="text-text-3 text-xs truncate font-mono">{secondary}</div>
        )}
        {ev.kind === "intent" && (fileCount > 0 || sourceTag) && (
          <div className="flex items-center gap-1 mt-0.5">
            {fileCount > 0 && (
              <span className="text-2xs px-1 rounded bg-bg-2 text-text-3">
                {fileCount} file{fileCount === 1 ? "" : "s"}
              </span>
            )}
            {sourceTag && sourceTag !== "manual" && (
              <span className="text-2xs px-1 rounded bg-bg-2 text-text-4 font-mono">
                {sourceTag}
              </span>
            )}
          </div>
        )}
      </div>
      <span className="text-text-4 text-xs tabular-nums mt-0.5">{time}</span>
    </button>
  );
}

// Plain-language badge for each history row. The discriminant (ev.kind)
// stays as-is for logic; this is display-only so vibecoders read why /
// save point, not VCS internals.
function kindBadge(kind: string): string {
  switch (kind) {
    case "intent":
      return "reason";
    case "snapshot":
      return "save";
    case "commit":
      return "commit";
    default:
      return "review";
  }
}

function labelFor(ev: HistoryEvent): [string, string] {
  if (ev.kind === "intent") {
    return [ev.entry.intent || "(no reason)", ev.entry.agent || ""];
  }
  if (ev.kind === "snapshot") {
    return [ev.entry.file, ev.entry.id];
  }
  if (ev.kind === "commit") {
    return [ev.entry.subject, `${ev.entry.sha} · ${ev.entry.author}`];
  }
  return [
    ev.entry.summary || ev.entry.kind || "(audit event)",
    [ev.entry.kind, ev.entry.branch, ev.entry.commit].filter(Boolean).join(" · "),
  ];
}

// One clock for the whole app — see lib/clockTime.
const hhmm = (secs: number): string => clockTimeFromSecs(secs);

// ── shared bits ────────────────────────────────────────────────────────

// Waiting state for a whole panel. Padded like a row of content so the panel
// doesn't jump when the list arrives — and it draws the app's ONE loading
// mark, the braille spinner, rather than spelling out "loading…".
function HintLoading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="text-sm px-4 py-3"
    >
      <AsciiSpinner />
    </div>
  );
}

// Per-filter empty-state copy. Each variant nudges the user toward the
// action that produces the missing kind of history.
function HistoryEmpty({ filter }: { filter: Filter }) {
  let title = "No history yet";
  // Opened "As you work," which is true of this feed — save points land on an
  // edit — but false of the safety net, and a reader takes the two for one
  // thing. The next sentence already names both triggers, so the opener was
  // carrying no information and one wrong implication.
  let body =
    "Aura keeps a running history. The reasons behind your changes, save points, and commits. Make an edit or a commit and they'll show up here.";
  if (filter === "intent") {
    title = "No reasons yet";
    body =
      "Every change can carry a reason. The why behind it. Aura writes one before each commit, or you can add your own.";
  } else if (filter === "snapshot") {
    title = "No save points yet";
    body =
      "Save points are automatic backups Aura takes before edits, so you can always come back to a known-good moment. Edit a file and one appears.";
  } else if (filter === "commit") {
    title = "No commits yet";
    body =
      "No commits yet for this project. Once you commit, the rows show up here grouped by day.";
  }
  return (
    <div className="px-4 py-4">
      <div className="text-text-2 text-sm font-medium">{title}</div>
      <div className="text-text-4 text-xs mt-1 leading-snug">{body}</div>
    </div>
  );
}

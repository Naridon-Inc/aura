// Sidebar bodies — one per nav-rail tab. Each body owns its own data
// fetch + scroll. Selecting a row in a list-style sidebar (Plan/Impacts/
// Timeline) opens the detail in the main work surface; for now most
// just render the list and the main pane stays editor/hero.
//
// The Plan/Impacts/Timeline/Team bodies share scaffolding with the
// workpane components in ../workpanes — we re-use those components
// directly so there's exactly one renderer per dataset.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileText } from "lucide-react";
import { FileTree } from "../FileTree";
import {
  ImpactsPane,
  ConflictPane,
} from "../workpanes";
import {
  api,
  type AuditEntry,
  type CliResult,
  type CommitEntry,
  type IntentEntry,
  type SentinelAgent,
  type SentinelMessage,
  type SnapshotEntry,
  type ZoneRule,
} from "../../lib/api";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";
import { IntentMatchChip } from "../IntentMatchChip";
import { ChangesPanel } from "../rightrail/ChangesPanel";
import { CommitGraph } from "../CommitGraph";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

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
  // Files tab still hosts the FileTree; the per-row git-status indicator
  // is the FileTree's job (it consumes git_status internally). When the
  // working tree is dirty we surface a tiny header chip so the user can
  // see "dirty" at a glance without opening the Git pane.
  const [dirty, setDirty] = useState(0);
  const visible = useDocumentVisibility();
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const stats = await api.gitDiffStats(repoRoot);
        if (!cancelled) setDirty(stats.changed_files);
      } catch {
        /* offline / no git — leave at 0 */
      }
    }
    tick();
    if (!visible) return;
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible]);

  return (
    <div className="h-full flex flex-col">
      {dirty > 0 && (
        <div className="flex items-center gap-2 h-6 px-3 text-[11px] text-text-3 border-b border-line-soft flex-shrink-0">
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--color-amber)",
            }}
          />
          <span>{dirty} changed file{dirty === 1 ? "" : "s"}</span>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <FileTree
          root={repoRoot}
          selected={selected}
          onSelect={onSelect}
          onSelectSplit={onSelectSplit}
        />
      </div>
    </div>
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

// ── Impacts (with Conflict folded in below) ────────────────────────────

export function ImpactsSidebar({ repoRoot }: Common) {
  // Stack: critical impacts on top, then merge/sentinel conflicts below.
  // Both use the same row visual (severity tag + path), so the user
  // doesn't context-switch between two visual languages. ConflictPane
  // own scroll is fine — the outer flex keeps both visible with a
  // shared scrollable region by giving each a min-height of 0.
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 border-b border-line-soft">
        <ImpactsPane repoRoot={repoRoot} />
      </div>
      <div className="flex-1 min-h-0">
        <ConflictPane repoRoot={repoRoot} />
      </div>
    </div>
  );
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
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider shrink-0">
          History
        </span>
        {/* List = the merged timeline; Graph = the branch-topology rail
            (VS Code "Source Control → Graph" parity). */}
        <div className="flex items-center gap-0.5 rounded bg-bg-2 p-0.5 shrink-0">
          {(["list", "graph"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`text-[10.5px] px-1.5 h-5 rounded capitalize ${
                view === v
                  ? "bg-bg-0 text-text-1 shadow-sm"
                  : "text-text-4 hover:text-text-2"
              }`}
              title={v === "graph" ? "Branch graph" : "Timeline list"}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 flex items-center justify-end">
          {view === "list" && (
            <Select
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              options={HISTORY_FILTER_OPTIONS}
              className="text-[11px] h-6 w-auto"
            />
          )}
        </div>
        {view === "list" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={refresh}
            title="Refresh"
            className="shrink-0 text-text-4 hover:text-text-1"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
          </Button>
        )}
      </header>
      {view === "graph" ? (
        <div className="flex-1 min-h-0">
          <CommitGraph repoRoot={repoRoot} showHeader={false} />
        </div>
      ) : (
      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto">
        {loading && flat.length === 0 ? (
          <Hint>loading…</Hint>
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
                    <div className="px-4 py-2 text-text-4 text-[11px]">
                      {loading ? "loading…" : "·"}
                    </div>
                  ) : item!.kind === "header" ? (
                    <div className="px-4 pt-3 pb-1 text-text-3 text-[10.5px] uppercase tracking-wider">
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
  const tone =
    ev.kind === "intent"
      ? "text-violet"
      : ev.kind === "snapshot"
        ? "text-amber"
        : ev.kind === "commit"
          ? "text-accent-green"
          : ev.entry.severity === "fail"
            ? "text-red"
            : "text-amber";
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
      className="w-full flex items-start gap-3 px-4 py-1.5 hover:bg-bg-2 text-left"
      title={ev.kind === "intent" ? "Right-click to split or merge" : undefined}
    >
      <span className={`text-[10px] uppercase tracking-wider mt-0.5 w-12 ${tone}`}>
        {kindBadge(ev.kind)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-text-1 text-[12px] truncate flex items-center gap-1.5">
          {ev.kind === "commit" && (
            <IntentMatchChip repoRoot={repoRoot} sha={ev.entry.sha} />
          )}
          <span className="truncate">{primary}</span>
        </div>
        {secondary && (
          <div className="text-text-3 text-[11px] truncate font-mono">{secondary}</div>
        )}
        {ev.kind === "intent" && (fileCount > 0 || sourceTag) && (
          <div className="flex items-center gap-1 mt-0.5">
            {fileCount > 0 && (
              <span className="text-[10px] px-1 rounded bg-bg-2 text-text-3">
                {fileCount} file{fileCount === 1 ? "" : "s"}
              </span>
            )}
            {sourceTag && sourceTag !== "manual" && (
              <span className="text-[10px] px-1 rounded bg-bg-2 text-text-4 font-mono">
                {sourceTag}
              </span>
            )}
          </div>
        )}
      </div>
      <span className="text-text-4 text-[10.5px] tabular-nums mt-0.5">{time}</span>
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

function hhmm(secs: number): string {
  const d = new Date(secs * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

// ── Search (semantic-toggle folded in) ─────────────────────────────────

type SearchMode = "text" | "semantic";

// One parsed grep hit (ripgrep-style "path:line[:col]:text").
type GrepHit = { path: string; line: number; col?: number; text: string };

// The flat row model the search list renders: a file header, a match under
// it, or a line we couldn't parse (kept verbatim, never faked into structure).
type SearchRow =
  | { kind: "file"; path: string; count: number }
  | { kind: "hit"; path: string; line: number; text: string }
  | { kind: "raw"; text: string };

function parseGrepLine(line: string): GrepHit | null {
  const m = /^(.+?):(\d+):(?:(\d+):)?(.*)$/.exec(line);
  if (!m) return null;
  return {
    path: m[1]!,
    line: Number(m[2]),
    col: m[3] ? Number(m[3]) : undefined,
    text: m[4] ?? "",
  };
}

// Group hits by file (insertion order), header + its matches; unparsable
// lines fall through as raw rows at the end.
function buildSearchRows(lines: string[]): SearchRow[] {
  const groups = new Map<string, GrepHit[]>();
  const order: string[] = [];
  const raws: string[] = [];
  for (const ln of lines) {
    const hit = parseGrepLine(ln);
    if (hit) {
      let bucket = groups.get(hit.path);
      if (!bucket) {
        bucket = [];
        groups.set(hit.path, bucket);
        order.push(hit.path);
      }
      bucket.push(hit);
    } else {
      raws.push(ln);
    }
  }
  const rows: SearchRow[] = [];
  for (const p of order) {
    const hits = groups.get(p)!;
    rows.push({ kind: "file", path: p, count: hits.length });
    for (const h of hits) rows.push({ kind: "hit", path: p, line: h.line, text: h.text });
  }
  for (const r of raws) rows.push({ kind: "raw", text: r });
  return rows;
}

function splitRelPath(p: string): { dir: string; base: string } {
  const segs = p.split("/");
  const base = segs.pop() ?? p;
  return { dir: segs.join("/"), base };
}

// Highlight the matched query inside a line of result text.
function SearchHighlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="rounded-[3px] bg-accent/20 text-accent">
        {text.slice(at, at + q.length)}
      </span>
      {text.slice(at + q.length)}
    </>
  );
}

export function SearchSidebar({ repoRoot }: Common) {
  const [mode, setMode] = useState<SearchMode>("text");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  function run() {
    if (!query.trim()) return;
    setLoading(true);
    setSubmitted(query.trim());
    const args = mode === "text"
      ? ["grep", query]
      : ["semantic", "search", query];
    api
      .auraCli(repoRoot, args)
      .then((r) => setResults(r.stdout.split("\n").filter(Boolean).slice(0, 400)))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }

  const rows = useMemo(() => buildSearchRows(results), [results]);
  const fileCount = useMemo(
    () => rows.filter((r) => r.kind === "file").length,
    [rows],
  );
  const hitCount = useMemo(
    () => rows.filter((r) => r.kind === "hit").length,
    [rows],
  );

  function openHit(path: string, line: number) {
    const abs = path.startsWith("/") ? path : `${repoRoot}/${path}`;
    window.dispatchEvent(
      new CustomEvent("aura:open-file", { detail: { path: abs, line } }),
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center h-9 px-4 border-b border-line-soft flex-shrink-0">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Search
        </span>
        <div className="ml-auto flex items-center gap-0.5 text-[10.5px]">
          <ModeChip active={mode === "text"} onClick={() => setMode("text")}>exact</ModeChip>
          <ModeChip active={mode === "semantic"} onClick={() => setMode("semantic")}>meaning</ModeChip>
        </div>
      </header>
      <div className="px-3 py-2 border-b border-line-soft flex-shrink-0">
        <Input
          type="text"
          placeholder={mode === "text" ? "Find exact text…" : "Describe what you're looking for…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          className="h-7 text-[12px]"
        />
        {!loading && hitCount > 0 && (
          <div className="mt-1.5 text-[10.5px] text-text-4">
            {hitCount} {hitCount === 1 ? "result" : "results"} in {fileCount}{" "}
            {fileCount === 1 ? "file" : "files"}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {loading ? (
          <Hint>Searching…</Hint>
        ) : rows.length === 0 ? (
          <Hint>{query ? "No matches" : "Type to search"}</Hint>
        ) : (
          rows.map((row, i) => {
            if (row.kind === "file") {
              const { dir, base } = splitRelPath(row.path);
              return (
                <div
                  key={`f:${row.path}:${i}`}
                  className="flex items-center gap-1.5 px-3 pt-2.5 pb-1"
                >
                  <FileText className="h-3 w-3 shrink-0 text-text-4" />
                  <span className="truncate text-[11.5px] font-medium text-text-1">
                    {base}
                  </span>
                  {dir && (
                    <span className="truncate text-[10.5px] text-text-4">{dir}</span>
                  )}
                  <span className="ml-auto shrink-0 text-[10px] text-text-5">
                    {row.count}
                  </span>
                </div>
              );
            }
            if (row.kind === "hit") {
              return (
                <button
                  type="button"
                  key={`h:${row.path}:${row.line}:${i}`}
                  onClick={() => openHit(row.path, row.line)}
                  className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-bg-2"
                >
                  <span className="w-8 shrink-0 text-right text-[10.5px] tabular-nums text-text-5">
                    {row.line}
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-text-2">
                    <SearchHighlight text={row.text.trim()} query={submitted} />
                  </span>
                </button>
              );
            }
            return (
              <div
                key={`r:${i}`}
                className="px-3 py-1 font-mono text-[11.5px] text-text-3 truncate"
              >
                {row.text}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 h-5 rounded uppercase tracking-wider transition-colors ${
        active ? "bg-bg-2 text-text-1" : "text-text-4 hover:text-text-2"
      }`}
    >
      {children}
    </button>
  );
}

// ── Team (project sharing + peers) ──────────────────────────────────────
// The old "Team" sidebar — collaboration + orchestration + activity +
// sentinel inbox — was retired in the chat-first sweep. Team commands
// now live behind `/team` and orchestration behind `/orchestrate` in
// the Manager chat. The sub-panes below remain for future re-use.

export function TeamSidebar({ repoRoot }: Common) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 border-b border-line-soft" style={{ maxHeight: 360 }}>
        <CollaborationPane repoRoot={repoRoot} />
      </div>
      <div className="flex-shrink-0 border-b border-line-soft" style={{ maxHeight: "40%" }}>
        <ActivityPane repoRoot={repoRoot} />
      </div>
      <div className="flex-shrink-0" style={{ maxHeight: "40%" }}>
        <SentinelInboxPane repoRoot={repoRoot} />
      </div>
    </div>
  );
}

type CollaborationState = {
  linked: boolean;
  configured: boolean;
  peers: number;
  liveRunning: boolean;
  livePid: number | null;
};

const EMPTY_COLLABORATION: CollaborationState = {
  linked: false,
  configured: false,
  peers: 0,
  liveRunning: false,
  livePid: null,
};

function CollaborationPane({ repoRoot }: Common) {
  const [state, setState] = useState<CollaborationState>(EMPTY_COLLABORATION);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invitee, setInvitee] = useState("shahabas");
  const [inviteCommand, setInviteCommand] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [joinUsername, setJoinUsername] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const visible = useDocumentVisibility();

  const refresh = useCallback(async () => {
    setLoading(true);
    const [team, peers, live] = await Promise.all([
      safeAuraCli(repoRoot, ["team", "status"]),
      safeAuraCli(repoRoot, ["team", "list", "--json"]),
      api.auraLiveStatus(repoRoot).catch(() => null),
    ]);
    const parsedPeers = parsePeerCount(peers.stdout);
    const teamText = `${team.stdout}\n${team.stderr}`;
    const peerText = `${peers.stdout}\n${peers.stderr}`;
    setState({
      linked: /\bteam-managed\b/.test(teamText),
      configured: !/No mothership (token|URL) configured/i.test(peerText),
      peers: parsedPeers,
      liveRunning: Boolean(live?.running),
      livePid: live?.pid ?? null,
    });
    setLoading(false);
  }, [repoRoot]);

  useEffect(() => {
    refresh();
    if (!visible) return;
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh, visible]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<string>) => {
      if (busy) return;
      setBusy(key);
      setNotice(null);
      try {
        const msg = await action();
        setNotice(msg);
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [busy, refresh],
  );

  return (
    <>
      <header className="flex items-center h-9 px-4 border-b border-line-soft">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Collaboration
        </span>
        <span className="ml-2 text-text-4 text-[10.5px] tabular-nums">
          {state.peers}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          title="Refresh collaboration"
          className="ml-auto text-text-4 hover:text-text-1"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </Button>
      </header>
      <div className="px-4 py-3 space-y-3 overflow-y-auto" style={{ maxHeight: 320 }}>
        <div className="grid grid-cols-2 gap-1.5">
          <StatusPill label="Team" active={state.configured} />
          <StatusPill label="Project" active={state.linked} />
          <StatusPill label="Live" active={state.liveRunning} />
          <StatusPill label={`${state.peers} peers`} active={state.peers > 0} />
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <TeamButton
            disabled={busy !== null}
            active={busy === "host"}
            onClick={() =>
              runAction("host", async () => {
                const r = await api.auraCli(repoRoot, ["host", "start"]);
                return cliOutput(r);
              })
            }
          >
            Start hub
          </TeamButton>
          <TeamButton
            disabled={busy !== null}
            active={busy === "link"}
            onClick={() =>
              runAction("link", async () => {
                const r = await api.auraCli(repoRoot, ["team", "link"]);
                return cliOutput(r);
              })
            }
          >
            Link project
          </TeamButton>
          <TeamButton
            disabled={busy !== null}
            active={busy === "live"}
            onClick={() =>
              runAction("live", async () => {
                if (state.liveRunning) {
                  await api.auraLiveStop(repoRoot);
                  return "Aura Live stopped.";
                }
                await api.auraCli(repoRoot, ["team", "link"]);
                const s = await api.auraLiveStart(repoRoot);
                return s.pid ? `Aura Live running as pid ${s.pid}.` : "Aura Live running.";
              })
            }
          >
            {state.liveRunning ? "Stop live" : "Start live"}
          </TeamButton>
          <TeamButton
            disabled={busy !== null}
            active={busy === "ping"}
            onClick={() =>
              runAction("ping", async () => {
                const r = await api.auraCli(repoRoot, ["ping"]);
                return cliOutput(r);
              })
            }
          >
            Ping
          </TeamButton>
        </div>

        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <Input
              value={invitee}
              onChange={(e) => setInvitee(e.target.value)}
              placeholder="username"
              className="min-w-0 flex-1 h-7 text-[11.5px]"
            />
            <TeamButton
              disabled={busy !== null}
              active={busy === "invite"}
              onClick={() =>
                runAction("invite", async () => {
                  const name = invitee.trim() || "teammate";
                  const r = await api.auraCli(repoRoot, [
                    "host",
                    "invite",
                    "--for-user",
                    name,
                    "--max-uses",
                    "1",
                  ]);
                  const out = cliOutput(r);
                  const token = extractJoinToken(out);
                  setInviteCommand(token ? `aura join ${token}` : "");
                  return out;
                })
              }
            >
              Invite
            </TeamButton>
          </div>
          {inviteCommand && (
            <Input
              value={inviteCommand}
              readOnly
              className="w-full h-7 text-[10.5px] text-text-2 font-mono"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <textarea
            value={joinToken}
            onChange={(e) => setJoinToken(e.target.value)}
            placeholder="join token"
            rows={2}
            className="w-full resize-none bg-bg-1 border border-line-soft rounded px-2 py-1.5 text-[11.5px] text-text-1 placeholder-text-4 focus:outline-none focus:border-accent"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              value={joinUsername}
              onChange={(e) => setJoinUsername(e.target.value)}
              placeholder="username"
              className="min-w-0 h-7 text-[11.5px]"
            />
            <Input
              value={joinPassword}
              onChange={(e) => setJoinPassword(e.target.value)}
              placeholder="password"
              type="password"
              className="min-w-0 h-7 text-[11.5px]"
            />
          </div>
          <TeamButton
            disabled={busy !== null || !joinToken.trim() || !joinUsername.trim() || !joinPassword}
            active={busy === "join"}
            onClick={() =>
              runAction("join", async () => {
                const raw = joinToken.trim();
                const token = raw.replace(/^aura\s+join\s+/, "").trim();
                const r = await api.auraCli(repoRoot, [
                  "join",
                  token,
                  "--username",
                  joinUsername.trim(),
                  "--password",
                  joinPassword,
                ]);
                if (r.status === 0) {
                  await api.auraCli(repoRoot, ["team", "link"]);
                }
                return cliOutput(r);
              })
            }
            full
          >
            Join team
          </TeamButton>
        </div>

        {loading && <div className="text-text-4 text-[11px]">checking...</div>}
        {notice && (
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-text-3 bg-bg-0 border border-line-soft rounded px-2 py-1.5">
            {notice}
          </pre>
        )}
        {state.liveRunning && state.livePid && (
          <div className="text-[10.5px] text-text-4 font-mono">live pid {state.livePid}</div>
        )}
      </div>
    </>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="h-6 rounded border border-line-soft bg-bg-1 px-2 flex items-center gap-1.5 min-w-0">
      <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-green" : "bg-amber"}`} />
      <span className="text-[10.5px] text-text-3 truncate">{label}</span>
    </div>
  );
}

function TeamButton({
  children,
  disabled,
  active,
  full,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  full?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${full ? "w-full" : ""} h-7 px-2 rounded border border-line-soft text-[11.5px] text-text-2 hover:text-text-1 hover:bg-bg-2 disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? "bg-bg-2 text-text-1" : "bg-bg-1"
      }`}
    >
      {active ? "..." : children}
    </button>
  );
}

async function safeAuraCli(repoRoot: string, args: string[]): Promise<CliResult> {
  try {
    return await api.auraCli(repoRoot, args);
  } catch (e) {
    return { stdout: "", stderr: String(e), status: -1 };
  }
}

function cliOutput(r: CliResult): string {
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  return out || (r.status === 0 ? "Done." : `Command exited ${r.status}.`);
}

function parsePeerCount(raw: string): number {
  const data = parseJson(raw);
  const total = Number(data?.total_active ?? 0);
  return Number.isFinite(total) ? total : 0;
}

function parseJson(raw: string): any | null {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function extractJoinToken(raw: string): string {
  const match = raw.match(/aura\s+join\s+([^\s]+)/);
  return match?.[1] ?? "";
}

// ── Sentinel inbox pane (structured replacement for raw peer dump) ────
//
// Reads `.aura/sentinel/messages/` via `sentinel_inbox`. Each row is a
// message with from-agent/from-session metadata + the body. Clicking a
// row marks it as read by the desktop session and exposes an inline
// reply composer that calls `sentinel_send` with `to_session` set to
// the original sender so it lands in their inbox specifically (not as
// a broadcast). Polls every 4 s while the tab is visible.

const DESKTOP_SESSION = "desktop";

function SentinelInboxPane({ repoRoot }: Common) {
  const [messages, setMessages] = useState<SentinelMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const visible = useDocumentVisibility();

  const refresh = useCallback(async () => {
    try {
      const list = await api.sentinelInbox(repoRoot);
      setMessages(list);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    refresh();
    if (!visible) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh, visible]);

  const unread = useMemo(
    () => messages.filter((m) => !m.read_by.includes(DESKTOP_SESSION)).length,
    [messages],
  );

  return (
    <>
      <header className="flex items-center h-9 px-4 border-b border-line-soft">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Inbox
        </span>
        <span className="text-text-4 text-[11px] tabular-nums ml-2">
          {messages.length}
        </span>
        {unread > 0 && (
          <span className="ml-1.5 text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-accent text-bg-0 font-medium">
            {unread}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          title="Refresh inbox"
          className="ml-auto text-text-4 hover:text-text-1"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </Button>
      </header>
      <div className="overflow-y-auto" style={{ maxHeight: 260 }}>
        {loading ? (
          <Hint>loading…</Hint>
        ) : messages.length === 0 ? (
          <Hint>no messages — teammates' broadcasts and DMs land here</Hint>
        ) : (
          <ul className="flex flex-col">
            {messages.map((m) => (
              <SentinelInboxRow
                key={m.id}
                message={m}
                repoRoot={repoRoot}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function SentinelInboxRow({
  message,
  repoRoot,
  onChanged,
}: {
  message: SentinelMessage;
  repoRoot: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const isUnread = !message.read_by.includes(DESKTOP_SESSION);
  const isBroadcast = message.to_session === "";

  const expand = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && isUnread) {
      try {
        await api.sentinelMarkRead(repoRoot, message.id, DESKTOP_SESSION);
        onChanged();
      } catch {
        // best-effort
      }
    }
  }, [open, isUnread, message.id, repoRoot, onChanged]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api.sentinelSend(
        repoRoot,
        DESKTOP_SESSION,
        DESKTOP_SESSION,
        message.from_session,
        body,
      );
      setDraft("");
      setOpen(false);
      onChanged();
    } catch {
      // best-effort; user can retry from the same row.
    } finally {
      setSending(false);
    }
  }, [draft, sending, repoRoot, message.from_session, onChanged]);

  return (
    <li className="border-b border-line-soft/40 last:border-b-0">
      <button
        type="button"
        onClick={expand}
        className={`w-full text-left px-4 py-2 flex items-baseline gap-2 hover:bg-bg-2 ${
          isUnread ? "bg-bg-2/40" : ""
        }`}
      >
        {isUnread && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
        )}
        <span className="text-text-1 text-[12px] font-medium truncate">
          {message.from_agent || "?"}
        </span>
        {message.from_session && (
          <span className="text-text-4 text-[10px] font-mono truncate">
            {message.from_session.slice(0, 8)}
          </span>
        )}
        {isBroadcast && (
          <span className="text-[9px] uppercase tracking-wider text-text-4 px-1 py-0.5 rounded border border-line-soft">
            all
          </span>
        )}
        <span className="text-text-4 text-[10px] tabular-nums ml-auto flex-shrink-0">
          {formatRelative(message.timestamp)}
        </span>
      </button>
      {!open && (
        <div className="px-4 pb-2 text-[12px] text-text-2 truncate">
          {message.content}
        </div>
      )}
      {open && (
        <div className="px-4 pb-3 space-y-2">
          <div className="text-[12px] text-text-1 leading-relaxed whitespace-pre-wrap">
            {message.content}
          </div>
          <div className="flex items-start gap-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={`Reply to ${message.from_agent || "sender"}…`}
              rows={2}
              className="flex-1 text-[12px] bg-bg-2 border border-line-soft rounded px-2 py-1.5 text-text-1 placeholder-text-4 focus:outline-none focus:border-accent resize-none"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={send}
              disabled={!draft.trim() || sending}
              className="text-[11px]"
            >
              {sending ? "…" : "Send"}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Activity feed pane (used inside TeamSidebar) ──────────────────────

type ActivityEvent = {
  at: number;
  actor: string;
  verb: string;
  target: string;
  summary?: string;
  link?: string;
};

function ActivityPane({ repoRoot }: Common) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .auraCli(repoRoot, ["activity", "tail", "-n", "30", "--json"])
      .then((r: CliResult) => {
        const text = (r.stdout || "").trim();
        if (!text || r.status !== 0) {
          setEvents([]);
          return;
        }
        try {
          setEvents(JSON.parse(text) as ActivityEvent[]);
        } catch {
          setEvents([]);
        }
      })
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [repoRoot]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <>
      <header className="flex items-center h-9 px-4 border-b border-line-soft">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Activity
        </span>
        <span className="text-text-4 text-[11px] tabular-nums ml-2">{events.length}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          title="Refresh activity"
          className="ml-auto text-text-4 hover:text-text-1"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </Button>
      </header>
      <div className="overflow-y-auto" style={{ maxHeight: 200 }}>
        {loading ? (
          <Hint>loading…</Hint>
        ) : events.length === 0 ? (
          <Hint>no activity yet — create a task or claim one to see events</Hint>
        ) : (
          <ul className="flex flex-col">
            {events.map((ev, i) => (
              <li
                key={`${ev.at}-${i}`}
                className="px-4 py-1.5 text-[12px] flex items-baseline gap-2 border-b border-line-soft/40 last:border-b-0"
              >
                <span className="text-text-4 text-[10px] tabular-nums w-10 flex-shrink-0">
                  {formatRelative(ev.at)}
                </span>
                <span className="text-text-1 truncate">
                  <span className="text-sky-300">{ev.actor}</span>{" "}
                  <span className="text-text-3">{ev.verb}</span>{" "}
                  <span className="text-amber-300 font-mono text-[11px]">{ev.target}</span>
                  {ev.summary && (
                    <span className="text-text-3"> — {ev.summary}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function formatRelative(unix: number): string {
  const now = Date.now() / 1000;
  const diff = now - unix;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return new Date(unix * 1000).toLocaleDateString();
}

// ── Agents (live sentinel presence) ───────────────────────────────────
//
// One card per agent the SentinelManager has registered in
// .aura/sentinel/claims/. Heartbeat older than 30 s grays out the
// status dot — agent is probably gone but we leave it in case it
// re-checks-in before the next poll. Card actions:
//   • Send  — invokes onSend(agentId, sessionId) so the host can open
//             a sentinel-message composer or PTY tab.
//   • Release — drops the claim file via aura sentinel release.
// Polls every 3 s; stale-while-revalidate so the list doesn't blink.

export function AgentsSidebar({
  repoRoot,
  onSend,
  onRoute,
}: Common & {
  onSend?: (agent: SentinelAgent) => void;
  onRoute?: (agent: SentinelAgent) => void;
}) {
  const [agents, setAgents] = useState<SentinelAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.sentinelAgents(repoRoot);
      setAgents(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  const visibleAgents = useDocumentVisibility();
  useEffect(() => {
    refresh();
    if (!visibleAgents) return;
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh, visibleAgents]);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center h-9 px-4 border-b border-line-soft flex-shrink-0">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Agents
        </span>
        <span className="ml-2 text-text-4 text-[10.5px] tabular-nums">
          {agents.length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          title="Refresh"
          className="ml-auto text-text-4 hover:text-text-1"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </Button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <Hint>loading…</Hint>
        ) : error ? (
          <Hint>{error}</Hint>
        ) : agents.length === 0 ? (
          <Hint>no agents registered yet</Hint>
        ) : (
          agents.map((a) => (
            <AgentCard
              key={a.session_id}
              agent={a}
              onSend={onSend ? () => onSend(a) : undefined}
              onRoute={onRoute ? () => onRoute(a) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  onSend,
  onRoute,
}: {
  agent: SentinelAgent;
  onSend?: () => void;
  onRoute?: () => void;
}) {
  const stale = agent.last_heartbeat > 0
    ? (Date.now() / 1000 - agent.last_heartbeat) > 30
    : false;
  const ageStr = relAge(agent.last_heartbeat);
  const monogram = (agent.agent_id || "?").charAt(0).toUpperCase();
  // First claim is what we surface as "current zone" — rough but
  // matches the SentinelManager's append-on-claim ordering.
  const firstClaim = agent.claims[0];
  return (
    <div className="border-b border-line-soft px-4 py-2.5 hover:bg-bg-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center justify-center rounded-sm bg-bg-card text-text-2 flex-shrink-0"
          style={{ width: 18, height: 18, fontSize: 10, fontWeight: 600 }}
        >
          {monogram}
        </span>
        <span className="text-text-1 text-[12px] truncate flex-1 min-w-0">
          {agent.agent_id || "agent"}
        </span>
        <span
          title={stale ? "stale heartbeat" : "alive"}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: stale ? "var(--text-5, #555)" : "var(--color-accent-green, #4ade80)",
          }}
        />
      </div>
      <div className="text-text-4 text-[10.5px] font-mono mt-0.5 truncate">
        {agent.session_id.slice(0, 12)} · pid {agent.pid || "—"} · {ageStr}
      </div>
      {firstClaim && (
        <div className="text-text-3 text-[11px] mt-1 truncate" title={firstClaim.file_path}>
          ↳ {firstClaim.file_path}
          {firstClaim.function_name ? ` · ${firstClaim.function_name}` : ""}
        </div>
      )}
      {(onSend || onRoute) && (
        <div className="flex items-center gap-1 mt-1.5 opacity-60 hover:opacity-100 transition-opacity">
          {onSend && (
            <button
              type="button"
              onClick={onSend}
              className="text-[10.5px] uppercase tracking-wider px-2 h-5 rounded bg-bg-1 border border-line-soft text-text-3 hover:text-text-1"
            >
              send
            </button>
          )}
          {onRoute && (
            <button
              type="button"
              onClick={onRoute}
              className="text-[10.5px] uppercase tracking-wider px-2 h-5 rounded bg-bg-1 border border-line-soft text-text-3 hover:text-text-1"
            >
              route prompt
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Zones (active claim rules) ─────────────────────────────────────────
//
// Each row is one zone-rule file: glob list, owning session, mode
// (warn|block) and age. × releases the rule via `aura zones release`.

export function ZonesSidebar({ repoRoot }: Common) {
  const [zones, setZones] = useState<ZoneRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.zoneList(repoRoot);
      setZones(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  const visibleZones = useDocumentVisibility();
  useEffect(() => {
    refresh();
    if (!visibleZones) return;
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
  }, [refresh, visibleZones]);

  async function release(id: string) {
    if (!window.confirm(`Release zone ${id}?`)) return;
    setBusy(id);
    try {
      await api.zoneRelease(repoRoot, id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center h-9 px-4 border-b border-line-soft flex-shrink-0">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Zones
        </span>
        <span className="ml-2 text-text-4 text-[10.5px] tabular-nums">
          {zones.length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          title="Refresh"
          className="ml-auto text-text-4 hover:text-text-1"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </Button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <Hint>loading…</Hint>
        ) : error ? (
          <Hint>{error}</Hint>
        ) : zones.length === 0 ? (
          <Hint>no active zone rules — claim files via /zones to coordinate</Hint>
        ) : (
          <ZoneGroupedList
            zones={zones}
            busy={busy}
            onRelease={release}
          />
        )}
      </div>
    </div>
  );
}

// Groups zones by owning session so multiple claims by the same agent
// collapse into one card. "You" badge fires when session_id matches the
// desktop session (best-effort: empty session_ids fall through to the
// generic "system" bucket so legacy claims still render).
function ZoneGroupedList({
  zones,
  busy,
  onRelease,
}: {
  zones: ZoneRule[];
  busy: string | null;
  onRelease: (zoneId: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ZoneRule[]>();
    for (const z of zones) {
      const owner = z.session_id || "system";
      const arr = map.get(owner);
      if (arr) arr.push(z);
      else map.set(owner, [z]);
    }
    // Mine first, then by most-recent claim within each group.
    return Array.from(map.entries())
      .map(([owner, list]) => {
        const sorted = list.slice().sort((a, b) => b.mtime - a.mtime);
        return { owner, zones: sorted, latest: sorted[0]?.mtime ?? 0 };
      })
      .sort((a, b) => {
        const aMine = a.owner === DESKTOP_SESSION ? 1 : 0;
        const bMine = b.owner === DESKTOP_SESSION ? 1 : 0;
        if (aMine !== bMine) return bMine - aMine;
        return b.latest - a.latest;
      });
  }, [zones]);

  return (
    <ul className="flex flex-col">
      {groups.map((g) => {
        const mine = g.owner === DESKTOP_SESSION;
        return (
          <li key={g.owner} className="border-b border-line-soft">
            <div className="flex items-baseline gap-2 px-4 pt-2 pb-1">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  mine ? "bg-sky-400" : "bg-amber"
                }`}
              />
              <span className="text-text-1 text-[12px] font-mono truncate">
                {g.owner === "system" ? "system" : g.owner.slice(0, 16)}
              </span>
              {mine && (
                <span className="text-[9px] uppercase tracking-wider text-sky-400 px-1 py-0.5 rounded border border-sky-400/40">
                  you
                </span>
              )}
              <span className="text-text-4 text-[10.5px] tabular-nums ml-auto">
                {g.zones.length}
              </span>
            </div>
            {g.zones.map((z) => (
              <div
                key={z.zone_id}
                className="group flex items-start gap-2 px-4 py-1.5 hover:bg-bg-2"
              >
                <span
                  className={`text-[10px] uppercase tracking-wider mt-0.5 w-9 flex-shrink-0 ${
                    z.mode === "block" ? "text-red" : "text-amber"
                  }`}
                  title={`mode=${z.mode || "warn"}`}
                >
                  {z.mode || "warn"}
                </span>
                <div className="flex-1 min-w-0">
                  <div
                    className="text-text-2 text-[11.5px] font-mono truncate"
                    title={z.patterns.join(" · ")}
                  >
                    {z.patterns.join("  ") || z.zone_id}
                  </div>
                  <div className="text-text-4 text-[10.5px] font-mono mt-0.5">
                    {relAge(z.mtime)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRelease(z.zone_id)}
                  disabled={busy === z.zone_id || !mine}
                  title={mine ? "Release zone" : "Only the owner can release"}
                  className="w-5 h-5 rounded text-text-4 hover:text-red hover:bg-bg-3 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ×
                </button>
              </div>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

function relAge(ts: number): string {
  if (!ts || ts <= 0) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

// ── shared bits ────────────────────────────────────────────────────────

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="text-text-4 text-[11.5px] px-4 py-3">{children}</div>;
}

// Per-filter empty-state copy. Each variant nudges the user toward the
// action that produces the missing kind of history.
function HistoryEmpty({ filter }: { filter: Filter }) {
  let title = "No history yet";
  let body =
    "As you work, Aura keeps a running history — the reasons behind your changes, save points, and commits. Make an edit or a commit and they'll show up here.";
  if (filter === "intent") {
    title = "No reasons yet";
    body =
      "Every change can carry a reason — the why behind it. Aura writes one before each commit, or you can add your own.";
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
      <div className="text-text-2 text-[12px] font-medium">{title}</div>
      <div className="text-text-4 text-[11px] mt-1 leading-snug">{body}</div>
    </div>
  );
}

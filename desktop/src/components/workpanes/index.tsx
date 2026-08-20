// Work-pane bodies — these replace the editor in the main work-surface
// when their corresponding nav-rail icon is active. Each pane reads
// from the project's `.aura/` directory via the matching Tauri command.
//
// Mirrors aura-term/src/ui/panes/*.rs. Keep these read-only for now —
// editing the underlying state happens through `aura` CLI commands the
// user runs from the terminal pane.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  api,
  type ConflictItem,
  type ImpactAlert,
  type SnapshotEntry,
  type WaveFile,
  type CliResult,
} from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { clockTimeFromSecs } from "../../lib/clockTime";
import { Button } from "../ui/button";
import { ResourcePill } from "../TopBar";
import {
  fetchConflicts,
  fetchImpacts,
  resolveImpact,
} from "../../lib/ambientCache";

// ── shared scaffold ────────────────────────────────────────────────────

export function PaneShell({
  title,
  loading,
  empty,
  emptyHint,
  onRefresh,
  children,
}: {
  /** The pane's name — set it ONLY where this shell is the sole thing naming
   *  the surface (a sidebar panel). When the shell fills a TAB, leave it out:
   *  the tab already carries the name, and printing it again 4px below is the
   *  reader being told twice where they just chose to go. */
  title?: string;
  loading?: boolean;
  empty?: boolean;
  /** Friendly empty-state copy for this pane; defaults to "nothing to show". */
  emptyHint?: React.ReactNode;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  // No title and nothing to click means no bar — an empty 36px rule across the
  // top is chrome that draws a line and says nothing.
  const showHeader = !!title || !!onRefresh;
  return (
    <div className="h-full w-full flex flex-col">
      {showHeader && (
      <header className="flex items-center h-9 px-4 border-b border-line-soft flex-shrink-0">
        {title && (
          <span className="section-label">
            {title}
          </span>
        )}
        {onRefresh && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            title="Refresh"
            className="ml-auto text-text-4 hover:text-text-1"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
          </Button>
        )}
      </header>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <Hint>loading…</Hint>
        ) : empty ? (
          <Hint>{emptyHint ?? "nothing to show"}</Hint>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-text-4 text-sm px-4 py-6">{children}</div>
  );
}

function useFetched<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    setLoading(true);
    fn()
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, loading, refresh };
}

// ── Plan ───────────────────────────────────────────────────────────────

export function PlanPane({ repoRoot }: { repoRoot: string }) {
  const { data, loading, refresh } = useFetched<WaveFile[]>(
    () => api.auraListWaves(repoRoot),
    [repoRoot],
  );
  return (
    <PaneShell title="Plan" loading={loading} empty={!data?.length} onRefresh={refresh}>
      {data?.map((w) => (
        <PlanRow key={w.path} wave={w} />
      ))}
    </PaneShell>
  );
}

function PlanRow({ wave }: { wave: WaveFile }) {
  const tone =
    wave.status === "active"
      ? "text-accent-green"
      : wave.status === "locked"
        ? "text-amber"
        : wave.status === "done"
          ? "text-text-3"
          : "text-text-4";
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line-soft hover:bg-state-hover">
      <span className={`text-2xs ${tone}`}>
        {wave.status}
      </span>
      <span className="text-text-1 text-base font-medium flex-1 truncate">
        {wave.name.replace(/\.xml$/, "")}
      </span>
      <span className="text-text-3 text-xs tabular-nums">
        {wave.waves} {wave.waves === 1 ? "wave" : "waves"}
      </span>
    </div>
  );
}

// ── Impacts ────────────────────────────────────────────────────────────

export function ImpactsPane({ repoRoot }: { repoRoot: string }) {
  const { data, loading, refresh } = useFetched<ImpactAlert[]>(
    () => fetchImpacts(repoRoot),
    [repoRoot],
  );
  // `aura_read_impacts` returns acknowledged alerts too; every other consumer
  // drops the resolved ones client-side. Without this filter, clicking
  // "Acknowledge" would re-show the row on the next refresh (the button looks
  // broken) and the reassuring empty state could never appear.
  const live = data?.filter((a) => !a.resolved) ?? [];
  const isEmpty = live.length === 0;
  return (
    // No title: this shell fills a tab, and the tab says "Impacts on me".
    <PaneShell loading={loading} onRefresh={refresh}>
      {isEmpty ? (
        <ImpactsEmptyState />
      ) : (
        live.map((a) => (
          <ImpactRow
            key={a.id || `${a.function}-${a.timestamp}`}
            alert={a}
            repoRoot={repoRoot}
            onResolved={refresh}
          />
        ))
      )}
    </PaneShell>
  );
}

// Educating empty state — this pane is conditional in the rail (it only
// appears when there's something reaching your work), but it can still be
// opened from the Overview or a deep link with nothing pending. Rather than
// a dead "nothing to show", explain in plain language what the feature is
// FOR, so the first time someone lands here they understand it — and feel
// reassured that quiet means safe.
function ImpactsEmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-12">
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center mb-4"
        style={{ background: "color-mix(in oklab, var(--color-accent-green) 14%, transparent)" }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 5 5.5v5.2c0 4.4 3 7.3 7 8.8 4-1.5 7-4.4 7-8.8V5.5Z" />
          <path d="m9 11.5 2 2 4-4.2" />
        </svg>
      </div>
      <div className="text-text-1 text-md font-semibold mb-1.5">Nothing's reaching your work</div>
      <p className="text-text-3 text-sm leading-relaxed max-w-[360px]">
        When a teammate changes a function on another branch that your code leans
        on, Aura spots it and lists it here, so a change you didn't make can't
        quietly break you. Right now nothing your work depends on has moved, so
        you're clear.
      </p>
      <p className="text-text-4 text-xs leading-relaxed max-w-[360px] mt-3">
        You'll also see a count next to <span className="text-text-2">Impacts on me</span> in
        the sidebar the moment something needs your eyes.
      </p>
    </div>
  );
}

function ImpactRow({
  alert,
  repoRoot,
  onResolved,
}: {
  alert: ImpactAlert;
  repoRoot: string;
  onResolved: () => void;
}) {
  const editor = useEditorStore();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sev =
    alert.severity === "critical"
      ? "bg-red text-white"
      : alert.severity === "high"
        ? "bg-amber text-bg-0"
        : alert.severity === "medium"
          ? "bg-blue text-bg-0"
          : "bg-bg-2 text-text-2";

  const resolvedPath = useMemo(() => {
    if (!alert.file) return null;
    if (alert.file.startsWith("/")) return alert.file;
    return `${repoRoot.replace(/\/$/, "")}/${alert.file.replace(/^\//, "")}`;
  }, [alert.file, repoRoot]);

  const acknowledge = useCallback(async () => {
    if (!alert.id || busy) return;
    setBusy(true);
    try {
      await resolveImpact(repoRoot, alert.id);
      onResolved();
    } catch {
      // best-effort; refresh would re-show the row if write didn't take.
      setBusy(false);
    }
  }, [alert.id, repoRoot, busy, onResolved]);

  const takeOver = useCallback(async () => {
    if (!resolvedPath) return;
    try {
      await editor.open(resolvedPath, { defaultView: "diff" });
    } catch {
      // openFile is best-effort; missing file simply leaves the row.
    }
  }, [resolvedPath, editor]);

  return (
    <div className="px-4 py-3 border-b border-line-soft hover:bg-state-hover">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-2xs px-1.5 py-0.5 rounded ${sev}`}>
          {alert.severity || "info"}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-text-1 text-base font-mono truncate hover:text-accent text-left flex-1 min-w-0"
        >
          {alert.function || "(unknown)"}
        </button>
        {alert.branch && (
          <span className="text-text-4 text-xs truncate">@ {alert.branch}</span>
        )}
      </div>
      {alert.message && (
        <div className="text-text-2 text-sm leading-relaxed mb-2">
          {alert.message}
        </div>
      )}
      {expanded && (
        <div className="text-xs text-text-3 mb-2 space-y-0.5 font-mono">
          {alert.file && <div>file: {alert.file}</div>}
          {alert.timestamp > 0 && (
            <div>at: {new Date(alert.timestamp * 1000).toLocaleString()}</div>
          )}
          {alert.id && <div>id: {alert.id}</div>}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={acknowledge}
          disabled={busy || !alert.id}
          className="text-xs px-2 py-1 rounded border border-line-soft text-text-2 hover:text-text-1 hover:bg-state-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "…" : "Acknowledge"}
        </button>
        <button
          type="button"
          onClick={takeOver}
          disabled={!resolvedPath}
          className="text-xs px-2 py-1 rounded border border-line-soft text-text-2 hover:text-text-1 hover:bg-state-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Take over
        </button>
      </div>
    </div>
  );
}

// (The Trace "Memory" surface is `dialogs/MemoryDialog`, which reads Aura's
//  own memory engine — `.aura/memory.json` via cmd_memory. An earlier
//  `MemoryPane` here just dumped Claude Code's ~/.claude/**/MEMORY.md, a
//  different agent's private notes; it was never wired into the rail and has
//  been removed to keep one honest home for Memory.)

// ── Timeline ───────────────────────────────────────────────────────────

const TIMELINE_PAGE = 200;
const TL_ROW_H = 36;
const TL_HEADER_H = 24;

type TLRow =
  | { kind: "header"; day: string }
  | { kind: "snap"; s: SnapshotEntry };

export function TimelinePane({ repoRoot }: { repoRoot: string }) {
  const [snaps, setSnaps] = useState<SnapshotEntry[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const cursor = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const fetching = useRef(false);

  const reset = useCallback(() => {
    generation.current += 1;
    cursor.current = undefined;
    setSnaps([]);
    setHasMore(true);
    setLoading(true);
  }, []);

  const loadPage = useCallback(async () => {
    if (fetching.current || !hasMore) return;
    fetching.current = true;
    const myGen = generation.current;
    try {
      const page = await api
        .auraListSnapshotsV2(repoRoot, TIMELINE_PAGE, cursor.current)
        .catch(() => null);
      if (generation.current !== myGen) return;
      if (page) {
        setSnaps((prev) => [...prev, ...page.entries]);
        setHasMore(page.has_more);
        cursor.current = page.oldest_mtime;
      } else {
        setHasMore(false);
      }
    } finally {
      if (generation.current === myGen) setLoading(false);
      fetching.current = false;
    }
  }, [repoRoot, hasMore]);

  useEffect(() => {
    reset();
    const id = window.setTimeout(() => void loadPage(), 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  const refresh = useCallback(() => {
    reset();
    window.setTimeout(() => void loadPage(), 0);
  }, [reset, loadPage]);

  const flat: TLRow[] = useMemo(() => {
    const out: TLRow[] = [];
    let lastDay = "";
    for (const s of snaps) {
      const d = s.mtime > 0 ? new Date(s.mtime * 1000).toISOString().slice(0, 10) : "—";
      if (d !== lastDay) {
        out.push({ kind: "header", day: d });
        lastDay = d;
      }
      out.push({ kind: "snap", s });
    }
    return out;
  }, [snaps]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flat.length + (hasMore ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      if (i >= flat.length) return TL_ROW_H;
      return flat[i].kind === "header" ? TL_HEADER_H : TL_ROW_H;
    },
    overscan: 8,
  });

  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    if (!hasMore || loading) return;
    const last = items[items.length - 1];
    if (last && last.index >= flat.length) {
      void loadPage();
    }
  }, [items, hasMore, loading, flat.length, loadPage]);

  return (
    <div className="h-full w-full flex flex-col">
      <header className="flex items-center h-9 px-4 border-b border-line-soft flex-shrink-0">
        <span className="section-label">
          Timeline
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
      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto">
        {loading && flat.length === 0 ? (
          <Hint>Loading…</Hint>
        ) : flat.length === 0 ? (
          <Hint>No history here yet. It fills in as you and the AI make changes.</Hint>
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
              const row = isSentinel ? null : flat[vi.index];
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
                      {loading ? "loading…" : "·"}
                    </div>
                  ) : row!.kind === "header" ? (
                    <div className="section-label px-4 pt-3 pb-1">
                      {row!.day}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-2 hover:bg-state-hover">
                      <span className="text-text-3 text-xs tabular-nums">
                        {hhmm(row!.s.mtime)}
                      </span>
                      <span className="text-text-1 text-base font-mono truncate flex-1">
                        {row!.s.file}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// One clock for the whole app — see lib/clockTime.
const hhmm = (secs: number): string => clockTimeFromSecs(secs);

// ── Conflict ───────────────────────────────────────────────────────────

export function ConflictPane({ repoRoot }: { repoRoot: string }) {
  const { data, loading, refresh } = useFetched<ConflictItem[]>(
    () => fetchConflicts(repoRoot),
    [repoRoot],
  );
  return (
    <PaneShell title="Conflict" loading={loading} empty={!data?.length} onRefresh={refresh}>
      {data?.map((c, i) => (
        <ConflictRow key={i} item={c} />
      ))}
    </PaneShell>
  );
}

function ConflictRow({ item }: { item: ConflictItem }) {
  const kindColor =
    item.kind === "git"
      ? "text-amber"
      : item.kind === "sentinel"
        ? "text-violet"
        : "text-red";
  return (
    <div className="px-4 py-3 border-b border-line-soft hover:bg-state-hover">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-2xs ${kindColor}`}>
          {item.kind}
        </span>
        <span className="text-text-1 text-base font-mono truncate">
          {item.label}
        </span>
      </div>
      {item.detail && (
        <div className="text-text-3 text-sm font-mono truncate">
          {item.detail}
        </div>
      )}
    </div>
  );
}

// Orchestration pane retired — surface now lives behind the
// `/orchestrate` chat slash command (see chatSlashHandler.ts).

// ── Doctor ─────────────────────────────────────────────────────────────

export function DoctorPane({ repoRoot }: { repoRoot: string }) {
  const [res, setRes] = useState<CliResult | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    setLoading(true);
    api
      .auraCli(repoRoot, ["doctor"])
      .then((r) => setRes(r))
      .catch(() => setRes(null))
      .finally(() => setLoading(false));
  }, [repoRoot]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const body = ((res?.stdout || "") + (res?.stderr || "")).trim();
  return (
    <PaneShell title="Doctor" loading={loading} empty={!body} onRefresh={refresh}>
      {/* Live process + memory monitor — its trigger used to live in the
          footer status strip; it now sits here in Project health, the one
          "how's my project doing" surface. Click it for the per-process CPU /
          memory breakdown of every aura binary + spawned agent CLI. */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line-soft">
        <span className="text-xs text-text-4">Live processes &amp; memory</span>
        <ResourcePill />
      </div>
      <pre className="text-sm font-mono leading-relaxed text-text-2 px-4 py-3 whitespace-pre-wrap">
        {body}
      </pre>
    </PaneShell>
  );
}

// ── Proof ──────────────────────────────────────────────────────────────

export function ProofPane({ repoRoot }: { repoRoot: string }) {
  const [res, setRes] = useState<CliResult | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    setLoading(true);
    api
      .auraCli(repoRoot, ["goal-trace", "list"])
      .then((r) => setRes(r))
      .catch(() => setRes(null))
      .finally(() => setLoading(false));
  }, [repoRoot]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const body = ((res?.stdout || "") + (res?.stderr || "")).trim();
  return (
    <PaneShell title="Proof" loading={loading} empty={!body} onRefresh={refresh}>
      <pre className="text-sm font-mono leading-relaxed text-text-2 px-4 py-3 whitespace-pre-wrap">
        {body}
      </pre>
    </PaneShell>
  );
}

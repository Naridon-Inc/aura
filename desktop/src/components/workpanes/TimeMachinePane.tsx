// TimeMachinePane — the "Time machine" Trace tool (replaces the old
// Rewind form).
//
// Meaning-first recovery for non-engineers. The left is a timeline of every
// moment your code changed (newest at top), built entirely from the real
// intent log. Pick a moment to *travel* to it: when it was, who/which AI did
// it, the why in plain words, and exactly what changed around it — then bring
// back just one piece (one function/class) without disturbing the rest.
//
// No "type a function name" form on the happy path: the pieces you can bring
// back are the symbols that *actually* changed at that moment (from
// `aura change-note <sha>`). A bare by-name fallback stays for the rare case
// where a moment has no committed symbols. See trace/TimeMachineFiles.
//
// Honesty note: Aura's surgical restore (`aura rewind <symbol> <file>`) brings
// a symbol back to its previous saved version — so "Bring this back" is framed
// as "undo this change", and Aura snapshots the current state first so the undo
// is itself undoable. Whole-repo time travel (`aura restore`, a hard git reset
// that nukes uncommitted work) is deliberately NOT surfaced here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Maximize2, RefreshCw } from "lucide-react";
import {
  api,
  type ClaudeSession,
  type IntentRow,
  type SnapshotEntry,
} from "../../lib/api";
import { fetchSessions, peekSessions } from "../../lib/sessionsCache";
import { fetchIntentRows, peekIntentRows } from "../../lib/intentCache";
import { peekCache, writeCache } from "../../lib/resourceCache";
import { Button } from "../ui/button";
import { collapseAutoStubSessions, type SessionDisplayRow } from "../../lib/sessionMeta";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { TraceToolbar } from "../ui/trace-page";
import { TraceTimeline } from "../ui/trace-timeline";
import { MomentDetail, MomentEntry } from "../trace/TimeMachineMoment";
import "../trace/time-machine.css";

// Newest-first recovery moments, folded per session. Only moments that
// actually touched files belong on a recovery timeline — telemetry / empty
// intents would be dead ends. Pure, so the cached seed and the live refresh
// derive the timeline identically.
function buildTimeline(
  rows: IntentRow[],
  claude: ClaudeSession[],
): SessionDisplayRow[] {
  const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  return collapseAutoStubSessions(sorted, claude).filter(
    (d) => (d.row.changeset?.files?.length ?? 0) > 0,
  );
}

export function TimeMachinePane({
  repoRoot,
  defaultIdentifier,
  defaultFile,
  onExpand,
}: {
  repoRoot: string;
  defaultIdentifier?: string | null;
  defaultFile?: string | null;
  /** When set, a maximize affordance in the header opens the immersive
   *  full-screen Time machine. Omitted when the pane is *already* full-screen
   *  (the wizard renders it without this). */
  onExpand?: () => void;
}) {
  // Last-known bundle for this root, read once at mount. A tab switch fully
  // unmounts the pane, so without this every visit re-shells three IPC calls
  // behind "loading…" before the first moment appears. `load` revalidates
  // immediately underneath and re-anchors the selection.
  const [seed] = useState(() => {
    const claude = peekSessions(repoRoot) ?? [];
    return {
      display: buildTimeline(peekIntentRows(repoRoot, 120) ?? [], claude),
      claude,
      snaps: peekCache<SnapshotEntry[]>(`snapshots:${repoRoot}`) ?? [],
    };
  });
  const [displayRows, setDisplayRows] = useState<SessionDisplayRow[]>(
    seed.display,
  );
  const [sessions, setSessions] = useState<ClaudeSession[]>(seed.claude);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>(seed.snaps);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTs, setSelectedTs] = useState<number | null>(
    seed.display[0]?.row.timestamp ?? null,
  );
  // Mount-time clock. Every row's age is rendered from its own absolute
  // timestamp against this, so a cached moment still reads its true age.
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  const aliveRef = useRef(true);
  // Mirror of the current selection so a refresh can keep the user on the
  // moment they were reading instead of snapping back to newest. Kept in a
  // ref so `load` doesn't have to depend on `selectedTs` (which would re-run
  // it on every click).
  const selectedTsRef = useRef<number | null>(null);
  useEffect(() => {
    selectedTsRef.current = selectedTs;
  }, [selectedTs]);
  // The prefill we last steered the selection to. Lets us tell a plain
  // refresh (same prefill → keep the user's moment) apart from the tab being
  // re-opened on a different symbol/file (new prefill → jump to it).
  const lastPrefillRef = useRef<string | null>(null);

  const prefillFile = (defaultFile ?? "").trim();
  const prefillId = (defaultIdentifier ?? "").trim();

  const load = useCallback(async () => {
    if (!repoRoot) {
      setDisplayRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    // Re-anchor the selection on top of a freshly derived timeline. Shared by
    // the cached paint and the fresh one so both land on the same moment.
    const applyTimeline = (rows: IntentRow[], claude: ClaudeSession[]) => {
      const display = buildTimeline(rows, claude);
      setDisplayRows(display);
      setSessions(claude);
      // A fresh prefill (tab opened on a new symbol/file) wins; a plain
      // refresh keeps the user on the moment they were reading if it still
      // exists; otherwise fall back to the prefill match, else the newest.
      const prefillChanged = prefillFile !== "" && prefillFile !== lastPrefillRef.current;
      lastPrefillRef.current = prefillFile;
      const prefMatch = prefillFile
        ? display.find((d) =>
            (d.row.changeset?.files ?? []).some(
              (f) => f.path === prefillFile || f.path.endsWith("/" + prefillFile) || prefillFile.endsWith("/" + f.path),
            ),
          )
        : undefined;
      const prevSel = selectedTsRef.current;
      const keepPrev =
        !prefillChanged && prevSel != null && display.some((d) => d.row.timestamp === prevSel);
      setSelectedTs(keepPrev ? prevSel : ((prefMatch ?? display[0])?.row.timestamp ?? null));
    };

    // Stale-while-revalidate. The rows and the session list come off the
    // caches the other Trace panes fill, so a cached paint is instant and the
    // refresh below runs underneath. Ages are computed from each row's own
    // absolute timestamp, so a cached row is never dated as if it just
    // happened. The snapshot list has no shared reader — this is its only
    // caller — so it keeps its own cache entry.
    const snapsKey = `snapshots:${repoRoot}`;
    const cachedRows = peekIntentRows(repoRoot, 120);
    const cachedSnaps = peekCache<SnapshotEntry[]>(snapsKey);
    if (cachedRows) applyTimeline(cachedRows, peekSessions(repoRoot) ?? []);
    if (cachedSnaps) setSnapshots(cachedSnaps);

    try {
      const [data, cs, snaps] = await Promise.all([
        fetchIntentRows(repoRoot, 120),
        fetchSessions(repoRoot).catch(() => [] as ClaudeSession[]),
        api.auraListSnapshots(repoRoot).catch(() => [] as SnapshotEntry[]),
      ]);
      const rows = Array.isArray(data) ? data : [];
      const claude = Array.isArray(cs) ? cs : [];
      const snapList = Array.isArray(snaps) ? snaps : [];
      writeCache(snapsKey, snapList);
      if (!aliveRef.current) return;
      applyTimeline(rows, claude);
      setSnapshots(snapList);
      setNowSecs(Math.floor(Date.now() / 1000));
    } catch (e) {
      if (!aliveRef.current) return;
      // Keep a cached timeline on screen — those moments are still real and
      // still recoverable; replacing them with an error would strand the user.
      if (!cachedRows) {
        setError(e instanceof Error ? e.message : String(e));
        setDisplayRows([]);
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [repoRoot, prefillFile]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  const selected = useMemo(
    () => displayRows.find((d) => d.row.timestamp === selectedTs) ?? null,
    [displayRows, selectedTs],
  );
  const selectedIndex = useMemo(
    () => displayRows.findIndex((d) => d.row.timestamp === selectedTs),
    [displayRows, selectedTs],
  );

  return (
    <div className="ui-tm">
      {/* What this place is FOR, and nothing else: on a destination this
          frightening ("can I undo what the agent did without losing my own
          work?") the sentence is the header. */}
      <TraceToolbar
        search={
          <span className="ui-trace-toolbar-meta ui-tm-lede">
            Travel back to any moment and bring back just one piece. The rest of your work stays put.
          </span>
        }
      >
        {onExpand && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onExpand}
            title="Open full screen"
            aria-label="Open the Time machine full screen"
          >
            <Maximize2 />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void load()}
          disabled={loading}
          title="Refresh timeline"
          aria-label="Refresh timeline"
        >
          <RefreshCw />
        </Button>
      </TraceToolbar>

      {error ? (
        <ErrorState
          title="Couldn’t load your timeline"
          message={error}
          onRetry={() => void load()}
        />
      ) : loading && displayRows.length === 0 ? (
        <LoadingState label="Reading your timeline…" />
      ) : displayRows.length === 0 ? (
        <EmptyState
          icon={History}
          title="Your timeline is empty"
          body="Every time you or an AI changes your code, that moment shows up here, with the why and everything that changed around it. Then you can travel back and bring any single piece back, cleanly."
        />
      ) : (
        <div className="ui-tm-body">
          <div className="ui-tm-rail">
            <TraceTimeline label="Moments your code changed, newest first">
              {displayRows.map((d, i) => (
                <MomentEntry
                  key={`${d.row.timestamp}-${d.row.agent_id}-${i}`}
                  display={d}
                  sessions={sessions}
                  nowSecs={nowSecs}
                  selected={d.row.timestamp === selectedTs}
                  onSelect={() => setSelectedTs(d.row.timestamp)}
                />
              ))}
            </TraceTimeline>
          </div>
          <div className="ui-tm-detail">
            {selected ? (
              <MomentDetail
                key={selected.row.timestamp}
                repoRoot={repoRoot}
                display={selected}
                sessions={sessions}
                snapshots={snapshots}
                nowSecs={nowSecs}
                stepsBack={selectedIndex}
                prefillId={prefillId}
                prefillFile={prefillFile}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// LoopPanel — the desktop surface over the shared `aura-loop` dependency
// graph (`.aura/a2a/`). It reads the SAME unified `ready_view` the CLI's
// `aura loop run` and the chat's `/loop` command read, so what the panel
// shows, what the runner dispatches, and what chat reports can never drift.
//
// Three affordances, matching the three loop verbs:
//   • Sync   → project the human task board (incl. Jira-imported cards) into
//              the graph (`loop_sync_board`), reconciling dependencies.
//   • Run    → claim the ready set and fan it out through the native Aura
//              brain (`loop_run_native`) — the same dispatcher the
//              Orchestrator uses, not a shelled-out CLI.
//   • lanes  → ready / working / blocked partitions, each node carrying its
//              priority and (when imported) a JIRA chip.

import { useCallback, useEffect, useState } from "react";
import { ListChecks, Loader2, Play, RefreshCw } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { api } from "../../lib/api";
import type { LoopTask, ReadyViewDto } from "../../lib/api";
import { Button } from "../ui/button";
import { StatusChip, type ChipTone } from "../ui/statusChip";

type Props = {
  /** Repo whose `.aura/a2a/` graph this panel reads. Null → inert empty state. */
  repoRoot: string | null;
};

const PRIORITY_TONE: Record<string, ChipTone> = {
  critical: "red",
  high: "amber",
  medium: "blue",
  low: "neutral",
};

/** One node row: title, a priority chip (unless low), and a JIRA chip when
 *  the node was projected from an externally-imported board card. */
function LoopRow({ task, note }: { task: LoopTask; note?: string }) {
  const showPriority = task.priority && task.priority !== "low";
  const isJira = task.external_source === "jira" && !!task.external_id;
  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5 rounded border border-line-soft bg-bg-1">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-text-1 leading-snug truncate" title={task.title}>
          {task.title}
        </div>
        {note && <div className="text-[10.5px] text-text-3 mt-0.5">{note}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {isJira && (
          <StatusChip tone="blue" dense>
            JIRA {task.external_id}
          </StatusChip>
        )}
        {showPriority && (
          <StatusChip tone={PRIORITY_TONE[task.priority] ?? "neutral"} dense dot>
            {task.priority}
          </StatusChip>
        )}
      </div>
    </div>
  );
}

function Lane({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wider text-text-3 flex items-center gap-1.5">
        {title}
        <span className="text-text-3/70">· {count}</span>
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

export function LoopPanel({ repoRoot }: Props) {
  const [view, setView] = useState<ReadyViewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "sync" | "run">(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    try {
      setView(await api.loopReadyView(repoRoot));
    } catch (e) {
      setNote(`Couldn't read the loop graph: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSync = async () => {
    if (!repoRoot || busy) return;
    setBusy("sync");
    setNote(null);
    try {
      const r = await api.loopSyncBoard(repoRoot);
      setNote(
        `Synced ${r.synced} node${r.synced === 1 ? "" : "s"} (${r.created} new, ${r.updated} updated) · ${r.edges} edge${r.edges === 1 ? "" : "s"}.`,
      );
      await refresh();
    } catch (e) {
      setNote(`Sync failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onRun = async () => {
    if (!repoRoot || busy) return;
    setBusy("run");
    setNote(null);
    try {
      const r = await api.loopRunNative(repoRoot);
      setNote(
        r.dispatched.length === 0
          ? "Nothing ready to dispatch — try Sync first."
          : `Dispatched ${r.dispatched.length} into the Aura brain${r.ready_remaining > 0 ? ` · ${r.ready_remaining} more ready` : ""}.`,
      );
      await refresh();
    } catch (e) {
      setNote(`Run failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const counts = view?.counts;
  const empty =
    !!view &&
    counts!.ready + counts!.blocked + counts!.working + counts!.done + counts!.other === 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-line-soft flex items-center gap-2">
        <ListChecks size={14} className="text-text-3 shrink-0" />
        <span className="text-[11px] uppercase tracking-wider text-text-3 flex-1">Loop</span>
        {counts && (
          <span className="text-[10.5px] text-text-3">
            {counts.ready} ready · {counts.working} working · {counts.blocked} blocked
          </span>
        )}
        <Button
          variant="subtle"
          size="xs"
          onClick={onSync}
          disabled={!repoRoot || busy !== null}
          title="Project the task board (incl. Jira) into the dependency graph"
        >
          {busy === "sync" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          <span className="ml-1">Sync</span>
        </Button>
        <Button
          variant="accentSoft"
          size="xs"
          onClick={onRun}
          disabled={!repoRoot || busy !== null || (counts?.ready ?? 0) === 0}
          title="Claim the ready set and dispatch it into the native Aura brain"
        >
          {busy === "run" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Play size={12} />
          )}
          <span className="ml-1">Run</span>
        </Button>
      </div>

      {note && (
        <div className="px-3 py-1.5 text-[11px] text-text-2 border-b border-line-soft bg-bg-1">
          {note}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-3">
        {!repoRoot ? (
          <div className="text-text-3 text-xs">Open a project to use the loop.</div>
        ) : loading && !view ? (
          <div className="text-text-3 text-xs flex items-center gap-2">
            <AsciiSpinner /> Reading loop graph…
          </div>
        ) : empty ? (
          <div className="text-text-3 text-xs leading-relaxed">
            The dependency graph is empty. <strong>Sync</strong> to project the task board
            (including any Jira-imported cards) into the graph, then <strong>Run</strong> to
            dispatch the ready set into the Aura brain.
          </div>
        ) : view ? (
          <>
            <Lane title="Ready" count={view.ready.length}>
              {view.ready.map((t) => (
                <LoopRow key={t.id} task={t} />
              ))}
            </Lane>
            <Lane title="Working" count={view.working.length}>
              {view.working.map((t) => (
                <LoopRow key={t.id} task={t} note="dispatched · running on the Aura brain" />
              ))}
            </Lane>
            <Lane title="Blocked" count={view.blocked.length}>
              {view.blocked.map((b) => (
                <LoopRow
                  key={b.task.id}
                  task={b.task}
                  note={`waiting on ${b.unmet.length} dependenc${b.unmet.length === 1 ? "y" : "ies"}`}
                />
              ))}
            </Lane>
            <Lane title="Done" count={view.done.length}>
              {view.done.slice(0, 8).map((t) => (
                <LoopRow key={t.id} task={t} />
              ))}
            </Lane>
          </>
        ) : null}
      </div>
    </div>
  );
}

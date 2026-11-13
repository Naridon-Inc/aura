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
//
// It sits in the manager's side aside beside the plan, so it is built from the
// same task-detail sections: a "Loop" section carrying the counts, the two
// verbs and the last result, then one section per lane of task rows.

import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw } from "lucide-react";

import { AsciiSpinner } from "../ui/ascii-spinner";
import { api } from "../../lib/api";
import type { LoopTask, ReadyViewDto } from "../../lib/api";
import { fetchReadyView } from "../../lib/loopCache";
import { Button } from "../ui/button";
import { ErrorNote, LoadingState } from "../ui/state";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import { TaskDetailMeta, TaskDetailNote, TaskDetailSection } from "../ui/tasks-detail";
import "../ui/loop-panel.css";

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
    <div className="ui-task-dependency ui-loop-row">
      <span className="ui-tasks-dependency-text">
        <span className="ui-tasks-dependency-label">
          <span title={task.title}>{task.title}</span>
        </span>
        {note && <small className="ui-tasks-dependency-detail">{note}</small>}
      </span>
      {(isJira || showPriority) && (
        <span className="ui-tasks-dependency-end">
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
        </span>
      )}
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
    <TaskDetailSection title={title} count={count}>
      <div className="ui-tasks-dependency-list">{children}</div>
    </TaskDetailSection>
  );
}

export function LoopPanel({ repoRoot }: Props) {
  const [view, setView] = useState<ReadyViewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "sync" | "run">(null);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    try {
      setView(await fetchReadyView(repoRoot));
    } catch (e) {
      setNote({ text: `Couldn't read the loop graph: ${String(e)}`, failed: true });
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
      setNote({
        text: `Synced ${r.synced} node${r.synced === 1 ? "" : "s"} (${r.created} new, ${r.updated} updated) · ${r.edges} edge${r.edges === 1 ? "" : "s"}.`,
        failed: false,
      });
      await refresh();
    } catch (e) {
      setNote({ text: `Sync failed: ${String(e)}`, failed: true });
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
      setNote({
        text:
          r.dispatched.length === 0
            ? "Nothing ready to dispatch. Try Sync first."
            : `Dispatched ${r.dispatched.length} into the Aura brain${r.ready_remaining > 0 ? ` · ${r.ready_remaining} more ready` : ""}.`,
        failed: false,
      });
      await refresh();
    } catch (e) {
      setNote({ text: `Run failed: ${String(e)}`, failed: true });
    } finally {
      setBusy(null);
    }
  };

  const counts = view?.counts;
  const empty =
    !!view &&
    counts!.ready + counts!.blocked + counts!.working + counts!.done + counts!.other === 0;

  const actions = (
    <span className="ui-loop-actions">
      <Button
        variant="ghost"
        size="xs"
        onClick={onSync}
        disabled={!repoRoot || busy !== null}
        title="Project the task board (incl. Jira) into the dependency graph"
      >
        {/* Work in flight wears the library's activity mark, as the
            repository's own sync button does. */}
        {busy === "sync" ? <AsciiSpinner size={12} /> : <RefreshCw />}
        Sync
      </Button>
      <Button
        variant="secondary"
        size="xs"
        onClick={onRun}
        disabled={!repoRoot || busy !== null || (counts?.ready ?? 0) === 0}
        title="Claim the ready set and dispatch it into the native Aura brain"
      >
        {/* Run is not: its resting glyph is a triangle, and a spinning
            triangle is nothing. So the house spinner takes over while the
            dispatch is in flight. */}
        {busy === "run" ? <AsciiSpinner size={12} /> : <Play />}
        Run
      </Button>
    </span>
  );

  return (
    <>
      <TaskDetailSection title="Loop" action={actions}>
        {counts && (
          <TaskDetailMeta
            parts={[
              `${counts.ready} ready`,
              `${counts.working} working`,
              `${counts.blocked} blocked`,
            ]}
          />
        )}
        {note &&
          (note.failed ? (
            <ErrorNote className="ui-loop-note">{note.text}</ErrorNote>
          ) : (
            <TaskDetailNote>{note.text}</TaskDetailNote>
          ))}
        {!repoRoot ? (
          <TaskDetailNote>Open a repository to use the loop.</TaskDetailNote>
        ) : loading && !view ? (
          <LoadingState label="Reading loop graph…" className="ui-loop-loading" />
        ) : empty ? (
          <TaskDetailNote>
            The dependency graph is empty. <strong>Sync</strong> to project the task board
            (including any Jira-imported cards) into the graph, then <strong>Run</strong> to
            dispatch the ready set into the Aura brain.
          </TaskDetailNote>
        ) : null}
      </TaskDetailSection>

      {view && !empty && (
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
      )}
    </>
  );
}

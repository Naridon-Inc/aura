// The actions for every selected task at once: move to a state, assign,
// set labels, archive or delete. Each runs through the bulk endpoints and
// reports how many tasks it changed, and how many it couldn't, so a
// partial run is visible.
//
// The selection lives with the caller, which passes the ids in along with
// a way to clear them, so any view with multi-select can use this bar.

import { useState } from "react";

import {
  api,
  type BulkOpResult,
  type TaskLabel,
  type TaskState,
  type TeamMember,
} from "../../lib/api";
import { askConfirm } from "../ui/ask";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TaskSelectionBar, TaskSelectionDivider } from "../ui/tasks-selection-bar";

type Props = {
  repoRoot: string;
  selectedIds: string[];
  /** The repository's states, for "Move to". */
  taskStates: TaskState[];
  /** The repository's labels, for "Labels". */
  taskLabels: TaskLabel[];
  /** The team, for "Assign". */
  members: TeamMember[];
  /** Clear the selection. Called after a run where every task succeeded. */
  onCleared: () => void;
  /** Re-read the tasks after a change. */
  onChanged: () => Promise<void> | void;
};

type Kind = "state" | "assign" | "label" | "archive" | "delete";

const BUSY_LABEL: Record<Kind, string> = {
  state: "Moving…",
  assign: "Assigning…",
  label: "Labeling…",
  archive: "Archiving…",
  delete: "Deleting…",
};

export function BulkActionToolbar({
  repoRoot,
  selectedIds,
  taskStates,
  taskLabels,
  members,
  onCleared,
  onChanged,
}: Props) {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [result, setResult] = useState<BulkOpResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (selectedIds.length === 0) return null;

  const run = async (kind: Kind, op: () => Promise<BulkOpResult>) => {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const out = await op();
      setResult(out);
      await onChanged();
      // Every task changed: the selection has done its job. Some failed:
      // keep it so the failures can be tried again.
      if (out.errors.length === 0) onCleared();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    const n = selectedIds.length;
    const ok = await askConfirm({
      title: `Delete ${n} task${n === 1 ? "" : "s"}?`,
      body: 'This drops the tasks, their relations and comments. The activity log keeps a final "deleted" entry.',
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (ok) void run("delete", () => api.tasksBulkDelete(repoRoot, selectedIds));
  };

  const status = error
    ? { text: error, tone: "error" as const }
    : busy
      ? { text: BUSY_LABEL[busy], tone: "neutral" as const }
      : result
        ? result.errors.length === 0
          ? { text: `${result.affected.length} updated`, tone: "neutral" as const }
          : {
              text: `${result.affected.length} updated · ${result.errors.length} failed`,
              tone: "error" as const,
            }
        : null;
  const locked = busy != null;

  return (
    <TaskSelectionBar count={selectedIds.length} status={status} onClear={onCleared} busy={locked}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" disabled={locked}>
            Move to
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          {taskStates.length === 0 ? (
            <DropdownMenuLabel>No states in this repository</DropdownMenuLabel>
          ) : (
            taskStates.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onSelect={() =>
                  void run("state", () => api.tasksBulkStateChange(repoRoot, selectedIds, s.id))
                }
              >
                <span
                  className="ui-tasks-selection-swatch"
                  style={s.color ? { background: s.color } : undefined}
                  aria-hidden
                />
                {s.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" disabled={locked}>
            Assign
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuItem
            onSelect={() => void run("assign", () => api.tasksBulkAssign(repoRoot, selectedIds, []))}
          >
            Unassigned
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {members.length === 0 ? (
            <DropdownMenuLabel>No team members</DropdownMenuLabel>
          ) : (
            members.map((m) => (
              <DropdownMenuItem
                key={m.handle}
                onSelect={() =>
                  void run("assign", () => api.tasksBulkAssign(repoRoot, selectedIds, [m.handle]))
                }
              >
                {m.name || m.handle}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" disabled={locked}>
            Labels
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuItem
            onSelect={() => void run("label", () => api.tasksBulkLabel(repoRoot, selectedIds, []))}
          >
            Remove all labels
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {taskLabels.length === 0 ? (
            <DropdownMenuLabel>No labels in this repository</DropdownMenuLabel>
          ) : (
            taskLabels.map((l) => (
              <DropdownMenuItem
                key={l.id}
                onSelect={() =>
                  void run("label", () => api.tasksBulkLabel(repoRoot, selectedIds, [l.id]))
                }
              >
                <span
                  className="ui-tasks-selection-swatch"
                  style={l.color ? { background: l.color } : undefined}
                  aria-hidden
                />
                {l.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <TaskSelectionDivider />

      <Button
        variant="ghost"
        size="xs"
        disabled={locked}
        onClick={() => void run("archive", () => api.tasksBulkArchive(repoRoot, selectedIds))}
      >
        Archive
      </Button>
      <Button variant="outlineDestructive" size="xs" disabled={locked} onClick={() => void confirmDelete()}>
        Delete
      </Button>
    </TaskSelectionBar>
  );
}

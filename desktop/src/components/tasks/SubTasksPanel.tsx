// SubTasksPanel — the task detail's Sub-tasks section: a progress bar, then
// every descendant in a table (Work / Priority / Status / Assignee). Status is
// the same glyph menu a list row wears and patches the child on the spot;
// clicking a row's title opens that sub-task.
//
// Data: `api.tasksSubtree` returns the root + every descendant depth-first;
// the root is dropped and each row's depth is recovered by walking
// `parent_id` up to the current task. An `aura:tasks:mutated` listener keeps
// the table live when a sibling edit or status change lands elsewhere.

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { Plus } from "lucide-react";

import { api, type Task, type TaskStatus, type TeamMember } from "../../lib/api";
import { fetchTeam } from "../../lib/teamCache";
import { useEditorStore } from "../../lib/editorStore";
import { percent } from "../../lib/percent";
import { AssigneeStack } from "../AssigneePicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Progress } from "../ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { TaskDetailNote, TaskDetailSection } from "../ui/tasks-detail";
import { TaskFormError } from "../ui/tasks-form";
import { TASK_PRIORITY_LABEL, TaskPriorityBars, TaskStatusTag } from "./taskGlyphs";
import { TaskIdChip } from "./TaskIdChip";

import "../ui/tasks-detail-sections.css";

type SubTaskRow = { task: Task; depth: number };

export function SubTasksPanel({
  task,
  allTasks,
  repoRoot,
  onCreateChild,
  onOpenChild,
  readOnly = false,
}: {
  task: Task;
  allTasks: Task[];
  repoRoot: string;
  onCreateChild?: (parentId: string, title: string) => Promise<void>;
  /** When set, a row click routes into the host's own sub-task surface
   *  (the detail pane's Sub-tasks tab) instead of stacking a fresh
   *  full-screen detail overlay. Falls back to opening a new overlay. */
  onOpenChild?: (childId: string) => void;
  readOnly?: boolean;
}): JSX.Element {
  const editor = useEditorStore();
  const [subtree, setSubtree] = useState<Task[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.tasksSubtree(repoRoot, task.id);
      // The root is the current task; the table lists its descendants only.
      setSubtree(rows.filter((r) => r.id !== task.id));
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot, task.id]);

  // Resolve handles → names for the assignee avatars. Members are
  // non-essential; an empty list just renders raw-handle initials.
  useEffect(() => {
    let alive = true;
    fetchTeam(repoRoot)
      .then((team) => {
        if (alive) setMembers(team?.members ?? []);
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh, allTasks]);

  // The board broadcasts `aura:tasks:mutated` after every write; refetch so
  // an inline status change here (or a sibling edit elsewhere) keeps the
  // table, and its progress bar, honest.
  useEffect(() => {
    const onMutate = () => void refresh();
    window.addEventListener("aura:tasks:mutated", onMutate);
    return () => window.removeEventListener("aura:tasks:mutated", onMutate);
  }, [refresh]);

  const rows = useMemo<SubTaskRow[]>(() => {
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    const depthOf = (node: Task): number => {
      let d = 0;
      let cur: Task | undefined = node;
      while (cur && cur.parent_id && cur.parent_id !== task.id) {
        cur = byId.get(cur.parent_id);
        d += 1;
        if (d > 12) break; // pathological guard
      }
      return d;
    };
    return subtree.map((t) => ({ task: t, depth: depthOf(t) }));
  }, [subtree, allTasks, task.id]);

  const total = rows.length;
  const doneCount = rows.filter((r) => r.task.status === "done").length;
  const pct = percent(doneCount, total);
  const canCreate = !readOnly && typeof onCreateChild === "function";

  const submitChild = async () => {
    const next = draft.trim();
    if (!next || creating || !onCreateChild) return;
    setCreating(true);
    setError(null);
    try {
      await onCreateChild(task.id, next);
      setDraft("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const changeStatus = useCallback(
    async (childId: string, status: TaskStatus) => {
      setError(null);
      try {
        await api.tasksUpdate(repoRoot, { id: childId, status });
        // Every other task surface re-reads; our own listener refreshes too.
        window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [repoRoot, refresh],
  );

  const openChild = useCallback(
    (childId: string) => {
      if (onOpenChild) onOpenChild(childId);
      else editor.openTaskDetail(childId, repoRoot);
    },
    [editor, repoRoot, onOpenChild],
  );

  const closeComposer = () => {
    setAdding(false);
    setDraft("");
  };

  return (
    <TaskDetailSection
      title="Sub-tasks"
      count={total}
      action={
        canCreate && !adding ? (
          <Button variant="ghost" size="xs" onClick={() => setAdding(true)} title="Add a sub-task">
            <Plus aria-hidden />
            Add
          </Button>
        ) : undefined
      }
    >
      {total === 0 ? (
        <TaskDetailNote>
          No sub-tasks yet. Break this into smaller pieces when it's too big to
          finish in one go; each piece can go to a different person or agent.
        </TaskDetailNote>
      ) : (
        <>
          <div className="ui-tasks-subtasks-progress">
            <Progress value={pct} aria-label={`${pct}% of sub-tasks done`} />
            <span>{pct}% done</span>
          </div>
          <div className="ui-tasks-subtasks">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Work</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assignee</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ task: child, depth }) => (
                  <TableRow key={child.id}>
                    <TableCell>
                      <div
                        className="ui-tasks-subtask-work"
                        style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
                      >
                        {depth > 0 && (
                          <span className="ui-tasks-subtask-tree" aria-hidden>
                            └
                          </span>
                        )}
                        <TaskIdChip sequenceId={child.sequence_id} />
                        <button
                          type="button"
                          className="ui-tasks-subtask-title"
                          onClick={() => openChild(child.id)}
                          title={child.title}
                        >
                          {child.title || "(untitled)"}
                        </button>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* The bars plus the word, because the column is headed
                          Priority. Not a coloured chip: on this board colour
                          means progress, not rank. */}
                      <span className="ui-tasks-subtask-priority">
                        <TaskPriorityBars priority={child.priority} />
                        {TASK_PRIORITY_LABEL[child.priority] ?? child.priority}
                      </span>
                    </TableCell>
                    <TableCell>
                      <TaskStatusTag
                        state={null}
                        status={child.status}
                        named
                        onStatus={
                          readOnly ? undefined : (next) => void changeStatus(child.id, next)
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {child.assignee_ids.length > 0 ? (
                        <AssigneeStack
                          handles={child.assignee_ids}
                          members={members}
                          dense
                          maxAvatars={2}
                        />
                      ) : (
                        <span className="ui-tasks-subtask-none">None</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {canCreate && adding && (
        <div className="ui-tasks-subtask-add">
          <Input
            size="small"
            type="text"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitChild();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeComposer();
              }
            }}
            onBlur={() => {
              if (!draft.trim() && !creating) closeComposer();
            }}
            placeholder="Sub-task title. Enter to add, Esc to cancel"
            aria-label="Sub-task title"
            disabled={creating}
          />
          <Button
            size="xs"
            onClick={() => void submitChild()}
            disabled={creating || draft.trim().length === 0}
          >
            {creating ? "Adding…" : "Add"}
          </Button>
        </div>
      )}

      {error && <TaskFormError>{error}</TaskFormError>}
    </TaskDetailSection>
  );
}

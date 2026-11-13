// Relations: every link from this task to another — blocked by, blocks,
// duplicates, relates to. The backend stores the mirror of each link, so
// the rows where this task is the source cover both directions without
// listing anything twice.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { api, type Task, type TaskRelation, type TaskRelationKind } from "../../lib/api";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { TaskDependencyLinks, TaskDetailNote, TaskDetailSection } from "../ui/tasks-detail";
import { TaskFormError } from "../ui/tasks-form";
import { taskDependencyItem } from "./TaskDetailBlocks";

const RELATION_KINDS: { id: TaskRelationKind; label: string }[] = [
  { id: "blocked_by", label: "Blocked by" },
  { id: "blocks", label: "Blocks" },
  { id: "duplicates", label: "Duplicates" },
  { id: "relates_to", label: "Relates to" },
];

export function RelationsCard({
  task,
  allTasks,
  repoRoot,
  onOpenTask,
}: {
  task: Task;
  allTasks: Task[];
  repoRoot: string;
  /** Opens a linked task; only tasks on this board can be opened. */
  onOpenTask: (id: string) => void;
}) {
  const [relations, setRelations] = useState<TaskRelation[]>([]);
  const [adding, setAdding] = useState(false);
  const [draftKind, setDraftKind] = useState<TaskRelationKind>("blocked_by");
  const [draftTarget, setDraftTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRelations(await api.tasksRelationsForTask(repoRoot, task.id));
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot, task.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const outgoing = relations.filter((r) => r.source_id === task.id);
  const byId = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  const targetOf = new Map(outgoing.map((r) => [r.id, r.target_id]));

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addRelation = () => {
    const target = draftTarget.trim();
    if (!target || target === task.id) return;
    void run(async () => {
      await api.tasksRelationsCreate(repoRoot, task.id, target, draftKind);
      setDraftTarget("");
      setAdding(false);
    });
  };
  const removeRelation = (relationId: string) =>
    void run(() => api.tasksRelationsDelete(repoRoot, relationId));
  const open = (relationId: string) => {
    const target = targetOf.get(relationId);
    if (target && byId.has(target)) onOpenTask(target);
  };

  // Everything but this task, less what is already linked at the chosen kind.
  const candidates = useMemo(() => {
    const linked = new Set(outgoing.filter((r) => r.kind === draftKind).map((r) => r.target_id));
    return allTasks.filter((t) => t.id !== task.id && !linked.has(t.id));
  }, [allTasks, outgoing, draftKind, task.id]);

  const groups = RELATION_KINDS.map((k) => ({
    ...k,
    rows: outgoing.filter((r) => r.kind === k.id),
  })).filter((g) => g.rows.length > 0);

  return (
    <TaskDetailSection
      title="Relations"
      count={outgoing.length}
      action={
        !adding && (
          <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add
          </Button>
        )
      }
    >
      {outgoing.length === 0 && !adding && (
        <TaskDetailNote>
          No relations. Link this task to others to track dependencies, duplicates, or related
          work.
        </TaskDetailNote>
      )}
      {groups.map((g) => (
        <div key={g.id} className="ui-tasks-relation-group">
          <h5>{g.label}</h5>
          <TaskDependencyLinks
            items={g.rows.map((r) => ({ ...taskDependencyItem(r.target_id, byId), id: r.id }))}
            onOpen={open}
            onRemove={removeRelation}
            removeLabel="Remove link"
            disabled={busy}
          />
        </div>
      ))}
      {adding && (
        <div className="ui-tasks-relation-add">
          <Select
            value={draftKind}
            onChange={(v) => setDraftKind(v as TaskRelationKind)}
            options={RELATION_KINDS.map((k) => ({ value: k.id, label: k.label }))}
            aria-label="Relation kind"
          />
          <Select
            value={draftTarget}
            onChange={setDraftTarget}
            options={candidates.map((t) => ({
              value: t.id,
              label: `AURA-${t.sequence_id} · ${t.title}`,
            }))}
            placeholder="Pick a task"
            aria-label="Linked task"
          />
          <div className="ui-tasks-relation-actions">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setAdding(false);
                setDraftTarget("");
              }}
            >
              Cancel
            </Button>
            <Button size="xs" onClick={addRelation} disabled={busy || !draftTarget}>
              {busy ? "Linking…" : "Link"}
            </Button>
          </div>
        </div>
      )}
      {error && <TaskFormError>{error}</TaskFormError>}
    </TaskDetailSection>
  );
}

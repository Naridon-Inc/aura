// The task's description: rendered markdown (with @mention chips) that
// turns into the editor on click, so editing stays out of the way until
// it is wanted.

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import type { Task, TeamMember, UpdateTaskInput } from "../../lib/api";
import { TiptapEditor } from "../notes/TiptapEditor";
import { Button } from "../ui/button";
import { TaskDetailSection } from "../ui/tasks-detail";
import { TaskMarkdown } from "./TaskMarkdown";

export function DescriptionCard({
  task,
  members,
  onPatch,
}: {
  task: Task;
  members: TeamMember[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  useEffect(() => {
    setDraft(task.description);
    setEditing(false);
  }, [task.id, task.description]);

  const dirty = draft.trim() !== task.description.trim();
  const save = async () => {
    if (dirty) await onPatch({ id: task.id, description: draft });
    setEditing(false);
  };
  const cancel = () => {
    setDraft(task.description);
    setEditing(false);
  };

  return (
    <TaskDetailSection
      title="Description"
      action={
        editing ? (
          <div className="ui-tasks-detail-actions">
            <Button variant="ghost" size="xs" onClick={cancel}>
              Cancel
            </Button>
            <Button size="xs" onClick={() => void save()} disabled={!dirty}>
              Save
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <div className="ui-tasks-description-editor">
          <TiptapEditor
            value={draft}
            onChange={setDraft}
            placeholder="Describe the work, paste a spec, drop @mentions…"
            dense
            autoFocus
          />
        </div>
      ) : task.description.trim() ? (
        <div className="ui-tasks-description" onClick={() => setEditing(true)}>
          <TaskMarkdown source={task.description} members={members} />
        </div>
      ) : (
        <Button variant="ghost" size="xs" className="ui-tasks-detail-add" onClick={() => setEditing(true)}>
          <Plus aria-hidden />
          Add a description
        </Button>
      )}
    </TaskDetailSection>
  );
}

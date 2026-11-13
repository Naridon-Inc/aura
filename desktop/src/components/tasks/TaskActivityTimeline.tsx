// What has happened to a task, oldest change last: the activity log drawn
// as a timeline, then the linked pull request and the proof, and — once the
// task is done — the button that saves it as a proof.

import { useCallback, useEffect, useState } from "react";

import { api, type Task, type TaskActivity, type UpdateTaskInput } from "../../lib/api";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { relativeAgeFromIso } from "../../lib/relativeTime";
import { Button } from "../ui/button";
import { Timeline, type TimelineEntry } from "../ui/timeline";
import { TaskDetailNote, TaskDetailSection } from "../ui/tasks-detail";
import { TaskFormError } from "../ui/tasks-form";
import { summariseActivity } from "./taskActivitySummary";

function when(iso: string): string {
  return iso ? relativeAgeFromIso(iso) : "";
}

export function TaskActivityTimeline({
  task,
  repoRoot,
  onPatch,
}: {
  task: Task;
  repoRoot: string;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  const [events, setEvents] = useState<TaskActivity[] | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintMsg, setMintMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEvents(await api.tasksActivityList(repoRoot, task.id, 25));
    } catch {
      // The log is a nicety beside the task itself; an unreadable one falls
      // back to the created/updated stamps below rather than an error.
      setEvents([]);
    }
  }, [repoRoot, task.id]);

  useEffect(() => {
    setMintMsg(null);
    void refresh();
  }, [refresh, task.updated_at]);

  const mintProof = async () => {
    if (minting) return;
    setMinting(true);
    setMintMsg(null);
    try {
      const content = [task.title, task.description].filter(Boolean).join("\n\n");
      const beadId = await api.tasksMintBead(repoRoot, task.id, content);
      await onPatch({ id: task.id, bead_id: beadId });
      setMintMsg({ ok: true, text: `Proof saved · ${beadId}` });
    } catch (e) {
      setMintMsg({ ok: false, text: String(e) });
    } finally {
      setMinting(false);
    }
  };

  const entries: TimelineEntry[] =
    events && events.length > 0
      ? events.map((ev, i) => ({
          id: ev.id,
          title: `${ev.actor_handle} ${summariseActivity(ev)}`,
          detail: when(ev.created_at),
          tone: i === 0 ? "active" : "neutral",
        }))
      : [
          { id: "updated", title: "Updated", detail: when(task.updated_at) },
          { id: "created", title: "Created", detail: when(task.created_at) },
        ];

  return (
    <TaskDetailSection
      title="Activity"
      count={events?.length}
      action={
        !task.bead_id ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={minting || task.status !== "done"}
            onClick={() => void mintProof()}
            title={
              task.status === "done"
                ? "Save this finished task as a proof a teammate can check and pick up"
                : "Available once the task is done"
            }
          >
            {minting ? "Saving…" : "Mark as proof"}
          </Button>
        ) : undefined
      }
    >
      <Timeline entries={entries} />
      {task.linked_pr && (
        <TaskDetailNote>
          Pull request{" "}
          <a href={task.linked_pr.url} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick}>
            {task.linked_pr.repo}#{task.linked_pr.number}
          </a>
        </TaskDetailNote>
      )}
      {task.bead_id && <TaskDetailNote>Proof {task.bead_id}</TaskDetailNote>}
      {mintMsg &&
        (mintMsg.ok ? (
          <TaskDetailNote>{mintMsg.text}</TaskDetailNote>
        ) : (
          <TaskFormError>{mintMsg.text}</TaskFormError>
        ))}
    </TaskDetailSection>
  );
}

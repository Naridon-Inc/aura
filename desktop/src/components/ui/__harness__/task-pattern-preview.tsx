import { useState } from "react";
import { TaskManager, RunningTasksDialog, type DetailedTask } from "../task-details";
import { Button } from "../button";
import { Timeline } from "../timeline";
export function TaskPatternPreview() {
  const [tasks, setTasks] = useState<DetailedTask[]>([
    {
      id: "review",
      subject: "Review existing shortcuts",
      description: "Read the current keyboard bindings.",
      status: "completed",
      owner: "You",
      blocks: ["build"],
    },
    {
      id: "build",
      subject: "Build keyboard navigation",
      description: "Connect arrow navigation and Escape handling.",
      status: "in_progress",
      owner: "Agent",
      blockedBy: ["review"],
      blocks: ["verify"],
    },
    { id: "verify", subject: "Verify focus restoration", status: "pending", blockedBy: ["build"] },
  ]);
  const [closing, setClosing] = useState(false),
    [notice, setNotice] = useState("");
  return (
    <section>
      <TaskManager tasks={tasks} onChange={setTasks} />
      <Timeline
        entries={tasks.map((task) => ({
          id: task.id,
          title: task.subject,
          tone:
            task.status === "in_progress"
              ? "active"
              : task.status === "pending"
                ? "incomplete"
                : "neutral",
        }))}
      />
      <Button size="sm" variant="outline" onClick={() => setClosing(true)}>
        Close with running tasks
      </Button>
      <RunningTasksDialog
        open={closing}
        onOpenChange={setClosing}
        tasks={tasks.filter((task) => task.status === "in_progress").map((task) => task.subject)}
        onKeepRunning={() => setNotice("View closed; preview tasks continue.")}
        onStopAndClose={() => {
          setTasks(
            tasks.map((task) =>
              task.status === "in_progress" ? { ...task, status: "pending" } : task,
            ),
          );
          setNotice("Preview tasks stopped and view closed.");
        }}
      />
      <output className="lab-pattern-output" aria-live="polite">
        {notice}
      </output>
    </section>
  );
}

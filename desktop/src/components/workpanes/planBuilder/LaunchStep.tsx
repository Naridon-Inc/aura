// The plan builder's last page: what is about to start, and the two ways to
// start it — hand it to Aura now, or keep it for later.

import { ArrowRight, Bookmark, Send } from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { ErrorNote } from "../../ui/state";
import { taskCount, type EditablePlan } from "./planModel";
import "../../ui/plan-builder.css";

export function LaunchStep({
  goal,
  plan,
  projectLabel,
  busy,
  error,
  onSave,
  onSend,
}: {
  goal: string;
  plan: EditablePlan | null;
  projectLabel: string;
  busy: "none" | "save" | "manager";
  error: string | null;
  onSave: () => void;
  onSend: () => void;
}) {
  const waves = plan?.waves.length ?? 0;
  const tasks = taskCount(plan);
  const off = busy !== "none" || !plan;
  return (
    <>
      <header>
        <h1>Start the plan</h1>
        <p className="ui-plan-goal-quote">{goal}</p>
        <small className="ui-plan-summary">
          {waves} {waves === 1 ? "wave" : "waves"} · {tasks} {tasks === 1 ? "task" : "tasks"} ·{" "}
          {projectLabel}
        </small>
      </header>
      <div className="ui-cloud-agent-connections ui-plan-launch" role="group" aria-label="How to start">
        <button type="button" disabled={off} onClick={onSend}>
          <Send size={16} aria-hidden />
          <span>{busy === "manager" ? "Starting Aura…" : "Send to Aura"}</span>
          <small>Hands each task to its agent</small>
          {busy === "manager" ? <AsciiSpinner size={10} /> : <ArrowRight size={14} aria-hidden />}
        </button>
        <button type="button" disabled={off} onClick={onSave}>
          <Bookmark size={16} aria-hidden />
          <span>{busy === "save" ? "Saving…" : "Save for later"}</span>
          <small>Run it from the Plan sidebar</small>
          {busy === "save" ? <AsciiSpinner size={10} /> : <ArrowRight size={14} aria-hidden />}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </>
  );
}

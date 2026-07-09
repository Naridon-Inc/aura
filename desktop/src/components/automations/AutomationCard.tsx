// One automation recipe, rendered as a compact WHEN → DO → THEN card with an
// Active toggle, Run-now, edit and delete. No bulky cards: tight rows, the
// trigger/action lines are plain language (see automationsCopy).

import { Pencil, Play, Trash2 } from "lucide-react";
import { Switch } from "../ui/switch";
import type { Automation } from "../../lib/api";
import {
  describeAction,
  describeNextRun,
  describeTrigger,
} from "./automationsCopy";

export function AutomationCard({
  automation,
  running,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
}: {
  automation: Automation;
  running: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const a = automation;
  return (
    <div className={`auto-recipe ${a.enabled ? "" : "is-paused"}`}>
      <div className="auto-recipe-rows">
        <div className="auto-recipe-row">
          <span className="auto-recipe-key">When</span>
          <span className="auto-recipe-val">{describeTrigger(a.trigger)}</span>
        </div>
        <div className="auto-recipe-row">
          <span className="auto-recipe-key">Do</span>
          <span className="auto-recipe-val">{describeAction(a.action)}</span>
        </div>
        {a.then_action && (
          <div className="auto-recipe-row">
            <span className="auto-recipe-key">Then</span>
            <span className="auto-recipe-val">{describeAction(a.then_action)}</span>
          </div>
        )}
      </div>

      <div className="auto-recipe-side">
        <div className="auto-recipe-state">
          <Switch
            checked={a.enabled}
            onCheckedChange={onToggle}
            aria-label={a.enabled ? "Pause automation" : "Activate automation"}
          />
          <span className={`auto-recipe-next ${a.enabled ? "on" : ""}`}>
            {describeNextRun(a)}
          </span>
        </div>
        <div className="auto-recipe-actions">
          <button
            type="button"
            className="auto-icon-btn run"
            onClick={onRunNow}
            disabled={running}
            title="Run now"
          >
            <Play size={13} />
            <span>{running ? "Running…" : "Run now"}</span>
          </button>
          <button
            type="button"
            className="auto-icon-btn"
            onClick={onEdit}
            title="Edit automation"
            aria-label="Edit automation"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            className="auto-icon-btn danger"
            onClick={onDelete}
            title="Delete automation"
            aria-label="Delete automation"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

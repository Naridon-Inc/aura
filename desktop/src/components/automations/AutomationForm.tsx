// Compact inline "New / Edit automation" form — NOT a bulky modal.
//
// Three blocks: WHEN (cadence + time + optional weekday), DO (an action + its
// params), and an optional THEN (a second action). Save builds an
// `AutomationInput` and hands it up. Everything is plain language; the only
// raw control is the time picker (a native HH:MM input).

import { useMemo, useState } from "react";
import { SegmentedControl } from "../ui/segmented";
import { Select } from "../ui/select";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Field } from "../ui/field";
import { Button } from "../ui/button";
import type {
  Action,
  Automation,
  AutomationInput,
  Cadence,
  NoteSummary,
  Trigger,
  WriteMode,
} from "../../lib/api";
import {
  ACTION_KIND_OPTIONS,
  CADENCE_OPTIONS,
  localTzOffsetMin,
  PAGE_SCOPE_OPTIONS,
  WEEKDAY_OPTIONS,
  WRITE_MODE_OPTIONS,
} from "./automationsCopy";

export type AgentChoice = { id: string; label: string; available: boolean };

/** Pre-fill for the WHEN→DO from a starter recipe / template. */
export type FormSeed = {
  name?: string;
  trigger?: Trigger;
  action?: Action;
};

function emptyTrigger(): Trigger {
  return {
    kind: "schedule",
    cadence: "weekdays",
    time_hm: "09:00",
    weekday: 0,
    tz_offset_min: localTzOffsetMin(),
  };
}

function defaultActionFor(kind: Action["kind"], firstAgent: string): Action {
  switch (kind) {
    case "run_agent":
      return { kind: "run_agent", agent: firstAgent, prompt: "", model: null };
    case "run_pr_review":
      return { kind: "run_pr_review", base: "main" };
    case "post_to_page":
      return {
        kind: "post_to_page",
        page: { scope: "team", bucket: "", id: null, title: "" },
        mode: "append",
        body_source: { source: "last_run_output" },
      };
    case "create_task":
      return { kind: "create_task", title: "", description: null, agent_assignee: null };
    default:
      return { kind: "run_pr_review", base: "main" };
  }
}

export function AutomationForm({
  agents,
  pages,
  seed,
  existing,
  onCancel,
  onSave,
}: {
  agents: AgentChoice[];
  pages: NoteSummary[];
  seed?: FormSeed;
  existing?: Automation;
  onCancel: () => void;
  onSave: (input: AutomationInput) => void;
}) {
  const firstAgent = agents[0]?.id ?? "claude";

  const [name, setName] = useState(existing?.name ?? seed?.name ?? "");
  const [trigger, setTrigger] = useState<Trigger>(
    existing?.trigger ?? seed?.trigger ?? emptyTrigger(),
  );
  const [action, setAction] = useState<Action>(
    existing?.action ?? seed?.action ?? defaultActionFor("run_agent", firstAgent),
  );
  const [thenOn, setThenOn] = useState<boolean>(!!existing?.then_action);
  const [thenAction, setThenAction] = useState<Action>(
    existing?.then_action ?? defaultActionFor("post_to_page", firstAgent),
  );

  const agentOptions = useMemo(
    () => agents.map((a) => ({ value: a.id, label: a.label, disabled: !a.available })),
    [agents],
  );

  const valid = isActionValid(action) && (!thenOn || isActionValid(thenAction));

  const submit = () => {
    if (!valid) return;
    onSave({
      name: name.trim() || "Automation",
      enabled: existing?.enabled ?? true,
      trigger,
      action,
      then_action: thenOn ? thenAction : null,
    });
  };

  return (
    <div className="auto-formx">
      <Field label="Name">
        <Input
          value={name}
          placeholder="e.g. Standup digest"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      {/* WHEN */}
      <div className="auto-formx-block">
        <div className="auto-formx-key">When</div>
        <TriggerEditor trigger={trigger} onChange={setTrigger} />
      </div>

      {/* DO */}
      <div className="auto-formx-block">
        <div className="auto-formx-key">Do</div>
        <ActionEditor
          action={action}
          onChange={setAction}
          agents={agentOptions}
          pages={pages}
          firstAgent={firstAgent}
        />
      </div>

      {/* THEN (optional) */}
      <div className="auto-formx-block">
        <label className="auto-formx-then-toggle">
          <input
            type="checkbox"
            checked={thenOn}
            onChange={(e) => setThenOn(e.target.checked)}
          />
          <span>Then do one more thing</span>
        </label>
        {thenOn && (
          <ActionEditor
            action={thenAction}
            onChange={setThenAction}
            agents={agentOptions}
            pages={pages}
            firstAgent={firstAgent}
          />
        )}
      </div>

      <div className="auto-formx-foot">
        <Button variant="accentSoft" size="sm" disabled={!valid} onClick={submit}>
          {existing ? "Save changes" : "Save automation"}
        </Button>
        <Button variant="subtle" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function isActionValid(a: Action): boolean {
  switch (a.kind) {
    case "run_agent":
      return a.prompt.trim().length > 0;
    case "create_task":
      return a.title.trim().length > 0;
    default:
      return true;
  }
}

// ── WHEN editor ───────────────────────────────────────────────────────────

function TriggerEditor({
  trigger,
  onChange,
}: {
  trigger: Trigger;
  onChange: (t: Trigger) => void;
}) {
  const setCadence = (cadence: Cadence) =>
    onChange({ ...trigger, cadence, tz_offset_min: localTzOffsetMin() });

  return (
    <div className="auto-formx-grid">
      <Field label="How often">
        <Select
          value={trigger.cadence}
          onChange={(v) => setCadence(v as Cadence)}
          options={CADENCE_OPTIONS}
        />
      </Field>

      {trigger.cadence === "weekly" && (
        <Field label="On">
          <Select
            value={String(trigger.weekday ?? 0)}
            onChange={(v) => onChange({ ...trigger, weekday: Number(v) })}
            options={WEEKDAY_OPTIONS}
          />
        </Field>
      )}

      <Field
        label="At"
        hint={trigger.cadence === "hourly" ? "minutes past the hour" : undefined}
      >
        <input
          type="time"
          className="auto-time"
          value={trigger.time_hm}
          onChange={(e) =>
            onChange({ ...trigger, time_hm: e.target.value || "09:00" })
          }
        />
      </Field>
    </div>
  );
}

// ── action editor (shared by DO and THEN) ─────────────────────────────────

function ActionEditor({
  action,
  onChange,
  agents,
  pages,
  firstAgent,
}: {
  action: Action;
  onChange: (a: Action) => void;
  agents: { value: string; label: string; disabled?: boolean }[];
  pages: NoteSummary[];
  firstAgent: string;
}) {
  const setKind = (kind: Action["kind"]) => onChange(defaultActionFor(kind, firstAgent));

  return (
    <div className="auto-formx-action">
      <Field label="Action">
        <Select
          value={action.kind}
          onChange={(v) => setKind(v as Action["kind"])}
          options={ACTION_KIND_OPTIONS}
        />
      </Field>

      {action.kind === "run_agent" && (
        <>
          <Field label="Agent">
            <Select
              value={action.agent}
              onChange={(v) => onChange({ ...action, agent: v })}
              options={agents}
            />
          </Field>
          <Field label="What should it do?" error={action.prompt.trim() ? undefined : "Required"}>
            <Textarea
              rows={3}
              value={action.prompt}
              placeholder="Summarize yesterday's commits into a standup digest…"
              onChange={(e) => onChange({ ...action, prompt: e.target.value })}
            />
          </Field>
        </>
      )}

      {action.kind === "run_pr_review" && (
        <Field label="Compare against" hint="branch to review your changes against">
          <Input
            value={action.base ?? ""}
            placeholder="main"
            onChange={(e) => onChange({ ...action, base: e.target.value || null })}
          />
        </Field>
      )}

      {action.kind === "post_to_page" && (
        <PostToPageEditor action={action} onChange={onChange} pages={pages} />
      )}

      {action.kind === "create_task" && (
        <>
          <Field label="Task title" error={action.title.trim() ? undefined : "Required"}>
            <Input
              value={action.title}
              placeholder="e.g. Triage overnight errors"
              onChange={(e) => onChange({ ...action, title: e.target.value })}
            />
          </Field>
          <Field label="Details" optional>
            <Textarea
              rows={2}
              value={action.description ?? ""}
              placeholder="Optional description"
              onChange={(e) =>
                onChange({ ...action, description: e.target.value || null })
              }
            />
          </Field>
          <Field label="Assign to agent" optional hint="leave blank for a human task">
            <Input
              value={action.agent_assignee ?? ""}
              placeholder="claude"
              onChange={(e) =>
                onChange({ ...action, agent_assignee: e.target.value || null })
              }
            />
          </Field>
        </>
      )}
    </div>
  );
}

function PostToPageEditor({
  action,
  onChange,
  pages,
}: {
  action: Extract<Action, { kind: "post_to_page" }>;
  onChange: (a: Action) => void;
  pages: NoteSummary[];
}) {
  const pageOptions = useMemo(() => {
    const opts = [{ value: "", label: "New Page each time" }];
    for (const p of pages) {
      if (p.archived_at) continue;
      opts.push({ value: p.id, label: p.title || "(untitled)" });
    }
    return opts;
  }, [pages]);

  const selected = action.page.id ?? "";

  return (
    <>
      <Field label="Scope">
        <Select
          value={action.page.scope}
          onChange={(v) =>
            onChange({ ...action, page: { ...action.page, scope: v } })
          }
          options={PAGE_SCOPE_OPTIONS}
        />
      </Field>
      <Field label="Page">
        <Select
          value={selected}
          onChange={(v) => {
            const match = pages.find((p) => p.id === v);
            onChange({
              ...action,
              page: {
                ...action.page,
                id: v || null,
                title: match?.title ?? action.page.title,
              },
            });
          }}
          options={pageOptions}
        />
      </Field>
      {!selected && (
        <Field label="New Page title">
          <Input
            value={action.page.title ?? ""}
            placeholder="Standup"
            onChange={(e) =>
              onChange({ ...action, page: { ...action.page, title: e.target.value } })
            }
          />
        </Field>
      )}
      <Field label="Write mode">
        <SegmentedControl<WriteMode>
          value={action.mode}
          onChange={(mode) => onChange({ ...action, mode })}
          options={WRITE_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          ariaLabel="Write mode"
        />
      </Field>
    </>
  );
}

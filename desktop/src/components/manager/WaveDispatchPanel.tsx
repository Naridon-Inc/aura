// Aura Orchestrator — Wave Dispatch panel (v0.2.31 LL.1, task #340).
//
// Replaces the single-agent Run button on PlanCard with a manager-of-
// managers fan-out surface. The user sees one row per lane (one lane
// per todo on the plan), each with:
//
//   - status pill (queued / running / done / conflict / cancelled / failed)
//   - per-lane brain override dropdown (defaults to "active brain")
//   - live progress (text tail from the lane's Brain::chat stream)
//   - cancel-lane button
//
// Dispatching the wave fires `orchestrator_dispatch_wave` and subscribes
// to `orchestrator-wave:<wave_id>` for live updates. The parent manager
// only ever sees each lane's summary (NOT the full transcript) — that's
// how the fan-out preserves the parent's context budget.
//
// The composed change-set surfaces at the bottom of the panel as a
// unified diff so the user can inspect every lane's output in one place
// before merging.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  api,
  type BrainDescriptor,
  type LaneOutcome,
  type LaneSpec,
  type PendingPlan,
  type TokenLedger,
  type UnifiedChange,
  type WaveOutcome,
  type WavePlan,
  type ZoneConflict,
} from "../../lib/api";
import { Play } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { ErrorNote } from "../ui/state";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import { Switch } from "../ui/switch";
import { compactNumber } from "../../lib/compactNumber";
import { WORK_STATE, laneState, type WorkState } from "../../lib/workState";
import "../ui/log-note.css";
import "../ui/wave-dispatch.css";

// This panel printed the runner's enum in the runner's case — QUEUED, RUNNING,
// CONFLICT — to someone who asked for a feature, and it reserved amber for a
// collision while the plan graph beside it used amber for a healthy running
// lane. The concern behind that choice still holds and is still met: a running
// lane and a collided one must not look alike. They don't — running is amber
// and a collision is red, with the failures, because both mean "look here".
/** The app's word for a lane's state, as the shared chip's tone. Severity, as
 *  in WORK_STATE: a collision and a failure share red, running is amber. */
const LANE_TONE: Record<WorkState, ChipTone> = {
  queued: "neutral",
  ready: "neutral",
  working: "amber",
  blocked: "neutral",
  paused: "neutral",
  conflict: "red",
  done: "green",
  failed: "red",
  cancelled: "neutral",
};

type Props = {
  plan: PendingPlan;
  /** Optional repo root — wired into lane zones so the conflict
   *  detector resolves to absolute paths consistent with the rest of
   *  the manager surface. */
  repoRoot?: string | null;
  /** Notifies the parent (typically PlanCard) when the wave finishes
   *  so it can compose follow-up UI (replace Build with "Approved",
   *  surface the unified diff, etc). */
  onWaveComplete?: (outcome: WaveOutcome) => void;
};

export function WaveDispatchPanel({ plan, repoRoot: _repoRoot, onWaveComplete }: Props) {
  const [brains, setBrains] = useState<BrainDescriptor[]>([]);
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [outcome, setOutcome] = useState<WaveOutcome | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ledger-driven auto-routing. Mirrors `BrainSettings.auto_route`; when
  // on, lanes left on "active brain" are bound by the dispatcher to the
  // Agent Skill Ledger's best provider for their taxonomy cell.
  const [autoRoute, setAutoRoute] = useState(true);

  // Wave id is derived from the plan id so the panel re-mounting onto
  // the same plan reuses the same wave. Lanes started under the prior
  // mount will replay via `orchestratorWaveStatus` on mount.
  const waveId = useMemo(() => `wave:${plan.id}`, [plan.id]);

  useEffect(() => {
    let cancelled = false;
    void api
      .brainListDescriptors()
      .then((list) => {
        if (!cancelled) setBrains(list);
      })
      .catch(() => {
        // Picker is best-effort — if the brain registry fails to load
        // the panel still works with "active brain" everywhere.
      });
    void api
      .brainGetSettings()
      .then((s) => {
        if (!cancelled) setAutoRoute(s.auto_route ?? true);
      })
      .catch(() => {
        // Settings best-effort — default to auto-route on.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleAutoRoute = useCallback(async () => {
    const next = !autoRoute;
    setAutoRoute(next); // optimistic
    try {
      await api.brainSetAutoRoute(next);
    } catch (e) {
      setAutoRoute(!next); // revert on failure
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [autoRoute]);

  // Replay any pre-existing wave for this plan id (e.g. user closed
  // and reopened the tab while a lane was still running).
  useEffect(() => {
    let cancelled = false;
    void api
      .orchestratorWaveStatus(waveId)
      .then((w) => {
        if (!cancelled && w) setOutcome(w);
      })
      .catch(() => {
        // No prior wave — fresh panel.
      });
    return () => {
      cancelled = true;
    };
  }, [waveId]);

  // Subscribe to live wave updates. Dispatcher emits the full snapshot
  // on every lane state change so we can replace `outcome` wholesale.
  useEffect(() => {
    let unsub: (() => void) | null = null;
    void (async () => {
      unsub = await listen<WaveOutcome>(`orchestrator-wave:${waveId}`, (evt) => {
        setOutcome(evt.payload);
        // Fire completion callback when every lane has reached a terminal
        // state (Done | Failed | Cancelled | Conflict).
        const everyTerminal = evt.payload.lanes.every((l) =>
          l.status === "done" ||
          l.status === "failed" ||
          l.status === "cancelled" ||
          l.status === "conflict",
        );
        if (everyTerminal) {
          onWaveComplete?.(evt.payload);
        }
      });
    })();
    return () => {
      if (unsub) unsub();
    };
  }, [waveId, onWaveComplete]);

  const dispatchWave = useCallback(async () => {
    if (dispatching) return;
    setDispatching(true);
    setError(null);
    try {
      const lanes: LaneSpec[] = plan.todos.map((todo, idx) => ({
        objective: todo.description,
        zones: todo.file_refs ?? [],
        mode: null,
        brain_override: overrides[idx] && overrides[idx] !== "__active"
          ? overrides[idx]
          : null,
        label: `Lane ${idx + 1}`,
      }));
      const wavePlan: WavePlan = { wave_id: waveId, lanes };
      const seed = await api.orchestratorDispatchWave(wavePlan);
      setOutcome(seed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDispatching(false);
    }
  }, [dispatching, plan.todos, overrides, waveId]);

  const cancelLane = useCallback(async (laneId: string) => {
    try {
      await api.orchestratorCancelLane(laneId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Derive a lookup for conflicts so the per-lane row can render an
  // inline warning without a second pass through the array.
  const conflictsByLane = useMemo(() => {
    const map: Record<string, ZoneConflict> = {};
    if (outcome) {
      for (const c of outcome.conflicts) {
        map[c.lane_id] = c;
      }
    }
    return map;
  }, [outcome]);

  const lanes = outcome?.lanes ?? [];
  const hasDispatched = lanes.length > 0;

  return (
    <section className="ui-wave" data-testid="wave-dispatch-panel" aria-label="Orchestrator">
      <header className="ui-wave-head">
        <span className="ui-wave-title" title={waveId}>
          Orchestrator
          <small>
            {plan.todos.length} lane{plan.todos.length === 1 ? "" : "s"}
          </small>
        </span>
        <label
          className="ui-wave-auto"
          title={
            autoRoute
              ? "Aura is picking the brain for each lane you haven't set yourself, going by which one has done this kind of work best before. Click to turn off."
              : "Off. Every lane you haven't set yourself uses the brain you have selected. Click to let Aura pick instead."
          }
        >
          <Switch
            checked={autoRoute}
            onCheckedChange={() => void toggleAutoRoute()}
            aria-label="Auto-route: let Aura pick the brain for each lane"
          />
          Auto-route
        </label>
        {!hasDispatched && (
          <Button
            type="button"
            size="xs"
            onClick={dispatchWave}
            disabled={dispatching || plan.todos.length === 0}
            title="Start every step of the plan at once, each on its own brain"
          >
            {dispatching ? <AsciiSpinner size={12} /> : <Play />}
            {dispatching ? "Dispatching…" : "Dispatch wave"}
          </Button>
        )}
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {!hasDispatched && (
        <ol className="ui-wave-lanes">
          {plan.todos.map((todo, idx) => (
            <li key={idx} className="ui-wave-lane">
              <span className="ui-wave-index">{idx + 1}</span>
              <div className="ui-wave-lane-body">
                <p>{todo.description}</p>
                {todo.file_refs && todo.file_refs.length > 0 && (
                  <small className="ui-wave-zones">zones: {todo.file_refs.join(", ")}</small>
                )}
              </div>
              <BrainPicker
                value={overrides[idx] ?? "__active"}
                brains={brains}
                autoRoute={autoRoute}
                onChange={(v) =>
                  setOverrides((prev) => ({ ...prev, [idx]: v }))
                }
              />
            </li>
          ))}
        </ol>
      )}

      {hasDispatched && (
        <ol className="ui-wave-lanes">
          {lanes.map((lane, idx) => (
            <LaneRow
              key={lane.lane_id}
              idx={idx}
              lane={lane}
              autoRoute={autoRoute}
              conflict={conflictsByLane[lane.lane_id]}
              onCancel={() => cancelLane(lane.lane_id)}
            />
          ))}
        </ol>
      )}

      {outcome && outcome.unified_changes.length > 0 && (
        <UnifiedChangeset changes={outcome.unified_changes} />
      )}

      {outcome?.tokens && outcome.tokens.done_lanes > 0 && (
        <WaveTokenMeter ledger={outcome.tokens} />
      )}
    </section>
  );
}

/** The honest Orchestrator token meter. Shows both sides a user cares
 *  about after a "is this costing me more?" worry: what fan-out
 *  compression SAVED the coordinator's context, and the fan-out OVERHEAD
 *  it added vs. a linear run. Every figure is a heuristic estimate — the
 *  "~" is load-bearing honesty, not decoration. */
function WaveTokenMeter({ ledger }: { ledger: TokenLedger }) {
  const { transcript_tokens, summary_tokens, saved_tokens, overhead_tokens, done_lanes } = ledger;
  return (
    <div
      className="ui-wave-meter"
      title={
        "Heuristic ~3.5-chars/token estimates, not provider-billed counts.\n" +
        `${done_lanes} lane${done_lanes === 1 ? "" : "s"} produced ~${compactNumber(transcript_tokens)} tokens of transcript; ` +
        `the coordinator only reads the ~${compactNumber(summary_tokens)}-token summaries, ` +
        `so summarisation kept ~${compactNumber(saved_tokens)} out of its context.\n` +
        `Fan-out overhead ~${compactNumber(overhead_tokens)} is the per-lane coordination prompt a single linear run would not pay.`
      }
    >
      <strong>Coordinator context</strong>
      <span>lanes produced ~{compactNumber(transcript_tokens)}</span>
      <span aria-hidden>→</span>
      <span>you read ~{compactNumber(summary_tokens)}</span>
      <span data-tone="green">saved ~{compactNumber(saved_tokens)}</span>
      <span className="ui-wave-meter-end">fan-out overhead ~{compactNumber(overhead_tokens)}</span>
    </div>
  );
}

function BrainPicker({
  value,
  brains,
  autoRoute,
  onChange,
}: {
  value: string;
  brains: BrainDescriptor[];
  autoRoute: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      className="ui-wave-brain"
      align="end"
      aria-label={
        autoRoute
          ? "Leave this on auto and Aura picks the brain for this lane, going by what has worked before; or choose one yourself here."
          : "Per-lane brain override (defaults to the active brain)"
      }
      options={[
        {
          value: "__active",
          label: autoRoute ? "auto (ledger)" : "active brain",
        },
        ...brains.map((b) => ({
          value: b.provider_id,
          label: b.display_name,
        })),
      ]}
    />
  );
}

function LaneRow({
  idx,
  lane,
  autoRoute,
  conflict,
  onCancel,
}: {
  idx: number;
  lane: LaneOutcome;
  autoRoute: boolean;
  conflict?: ZoneConflict;
  onCancel: () => void;
}) {
  // A lane was auto-routed iff the user didn't pin a brain on it and
  // auto-route was on at dispatch — the dispatcher then resolved the
  // provider from the skill ledger (or fell back to the active brain).
  const wasAutoRouted = autoRoute && !lane.spec.brain_override;
  const isTerminal =
    lane.status === "done" ||
    lane.status === "failed" ||
    lane.status === "cancelled" ||
    lane.status === "conflict";
  const tail = useMemo(() => {
    const text = lane.transcript ?? "";
    if (!text) return "";
    // Last ~3 lines for a compact preview.
    const lines = text.split("\n");
    return lines.slice(Math.max(0, lines.length - 3)).join("\n");
  }, [lane.transcript]);
  const state = laneState(lane.status);

  return (
    <li className="ui-wave-lane">
      <span className="ui-wave-index">{idx + 1}</span>
      <div className="ui-wave-lane-body">
        <div className="ui-wave-lane-meta">
          {/* Reads from the same entry as the conflict line below, so the
              mark that flags a collision and the line explaining it agree. */}
          <StatusChip tone={LANE_TONE[state]} dense title={WORK_STATE[state].hint}>
            {lane.status === "running" && <AsciiSpinner size={10} />}
            {WORK_STATE[state].label}
          </StatusChip>
          {lane.provider_id && <small className="ui-wave-mono">{lane.provider_id}</small>}
          {wasAutoRouted && lane.provider_id && (
            <small
              className="ui-wave-picked"
              title="Aura chose this brain because it has done best on this kind of work before."
            >
              Aura picked this one
            </small>
          )}
        </div>
        <p>{lane.spec.label ?? lane.spec.objective}</p>
        {conflict && (
          <small className="ui-wave-problem">
            zone conflict on <code>{conflict.zone}</code> with sibling lane
          </small>
        )}
        {lane.error && <small className="ui-wave-problem">{lane.error}</small>}
        {tail && lane.status === "running" && <pre className="ui-wave-tail">{tail}</pre>}
        {lane.summary && lane.status === "done" && (
          <small className="ui-wave-summary">summary: {lane.summary}</small>
        )}
      </div>
      {!isTerminal && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onCancel}
          title="Stop this lane. Ends its brain's session and releases the files it had claimed"
        >
          Cancel
        </Button>
      )}
    </li>
  );
}

function UnifiedChangeset({ changes }: { changes: UnifiedChange[] }) {
  return (
    <section className="ui-wave-changes" aria-label="Unified changes">
      <div className="ui-log-note-files-head">
        <span>Unified changes</span>
        <span className="ui-log-note-count">{changes.length}</span>
      </div>
      {changes.map((c, idx) => (
        <div key={`${c.lane_id}:${c.path}:${idx}`} className="ui-wave-change">
          <div className="ui-wave-change-head">
            <strong className="ui-wave-mono">{c.path}</strong>
            <small>lane {c.lane_id.slice(0, 8)}</small>
          </div>
          <pre>{c.body}</pre>
        </div>
      ))}
    </section>
  );
}

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
// how kilo.ai's Orchestrator Mode preserves the parent's context budget.
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
import { Select } from "../ui/select";
import { compactNumber } from "../../lib/compactNumber";
import { WORK_STATE, laneState } from "../../lib/workState";

// This panel printed the runner's enum in the runner's case — QUEUED, RUNNING,
// CONFLICT — to someone who asked for a feature, and it reserved amber for a
// collision while the plan graph beside it used amber for a healthy running
// lane. The concern behind that choice still holds and is still met: a running
// lane and a collided one must not look alike. They don't — running is amber
// and a collision is red, with the failures, because both mean "look here".
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
    <div
      className="aura-block w-full flex flex-col overflow-hidden mt-2 mb-2"
      data-testid="wave-dispatch-panel"
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 border-b"
        style={{ borderColor: "var(--color-line-soft)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="aura-block-label">ORCHESTRATOR</span>
          <span style={{ color: "var(--color-text-3)" }}>·</span>
          <span
            className="truncate"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              color: "var(--color-text-2)",
            }}
            title={waveId}
          >
            {plan.todos.length} lane{plan.todos.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleAutoRoute}
            className="aura-block-link"
            style={{
              color: autoRoute ? "var(--color-accent)" : "var(--color-text-3)",
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              letterSpacing: "0.04em",
            }}
            title={
              autoRoute
                ? "Aura is picking the brain for each lane you haven't set yourself, going by which one has done this kind of work best before. Click to turn off."
                : "Off. Every lane you haven't set yourself uses the brain you have selected. Click to let Aura pick instead."
            }
          >
            {autoRoute ? "● AUTO-ROUTE ON" : "○ AUTO-ROUTE OFF"}
          </button>
          {!hasDispatched && (
            <button
              type="button"
              onClick={dispatchWave}
              disabled={dispatching || plan.todos.length === 0}
              className="aura-block-link"
              style={{
                opacity: dispatching || plan.todos.length === 0 ? 0.5 : 1,
              }}
              title="Start every step of the plan at once, each on its own brain"
            >
              {dispatching ? "DISPATCHING…" : "DISPATCH WAVE"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          className="px-3 py-2 t-sm"
          style={{
            background: "color-mix(in srgb, var(--color-red) 8%, transparent)",
            color: "var(--color-red)",
            borderBottom: "1px solid var(--color-line-soft)",
          }}
        >
          {error}
        </div>
      )}

      {!hasDispatched && (
        <div className="flex flex-col">
          {plan.todos.map((todo, idx) => (
            <div
              key={idx}
              className="flex items-start gap-2.5 px-3 py-2 border-b"
              style={{ borderColor: "var(--color-line-soft)" }}
            >
              <span className="aura-block-index shrink-0 mt-[2px]">
                {String(idx + 1).padStart(2, " ")}
              </span>
              <div className="flex-1 min-w-0">
                <div
                  className="t-sm leading-snug"
                  style={{ color: "var(--color-text-1)" }}
                >
                  {todo.description}
                </div>
                {todo.file_refs && todo.file_refs.length > 0 && (
                  <div
                    className="t-xs mt-1 truncate"
                    style={{ color: "var(--color-text-3)" }}
                  >
                    zones: {todo.file_refs.join(", ")}
                  </div>
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
            </div>
          ))}
        </div>
      )}

      {hasDispatched && (
        <div className="flex flex-col">
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
        </div>
      )}

      {outcome && outcome.unified_changes.length > 0 && (
        <UnifiedChangeset changes={outcome.unified_changes} />
      )}

      {outcome?.tokens && outcome.tokens.done_lanes > 0 && (
        <WaveTokenMeter ledger={outcome.tokens} />
      )}
    </div>
  );
}

/** The honest Orchestrator token meter. Shows both sides a user cares
 *  about after a "is Conductor costing me more?" worry: what fan-out
 *  compression SAVED the coordinator's context, and the fan-out OVERHEAD
 *  it added vs. a linear run. Every figure is a heuristic estimate — the
 *  "~" is load-bearing honesty, not decoration. */
function WaveTokenMeter({ ledger }: { ledger: TokenLedger }) {
  const { transcript_tokens, summary_tokens, saved_tokens, overhead_tokens, done_lanes } = ledger;
  return (
    <div
      className="mx-3 mb-3 mt-1 px-3 py-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap"
      style={{
        border: "1px solid var(--color-line-soft)",
        borderRadius: 2,
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
      }}
      title={
        "Heuristic ~3.5-chars/token estimates, not provider-billed counts.\n" +
        `${done_lanes} lane${done_lanes === 1 ? "" : "s"} produced ~${compactNumber(transcript_tokens)} tokens of transcript; ` +
        `the coordinator only reads the ~${compactNumber(summary_tokens)}-token summaries, ` +
        `so summarisation kept ~${compactNumber(saved_tokens)} out of its context.\n` +
        `Fan-out overhead ~${compactNumber(overhead_tokens)} is the per-lane coordination prompt a single linear run would not pay.`
      }
    >
      <span className="aura-block-label" style={{ color: "var(--color-text-3)" }}>
        COORDINATOR CONTEXT
      </span>
      <span style={{ color: "var(--color-text-3)" }}>
        lanes produced ~{compactNumber(transcript_tokens)}
      </span>
      <span style={{ color: "var(--color-text-3)" }}>→</span>
      <span style={{ color: "var(--color-text-2)" }}>
        you read ~{compactNumber(summary_tokens)}
      </span>
      <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>
        saved ~{compactNumber(saved_tokens)}
      </span>
      <span style={{ color: "var(--color-text-3)", marginLeft: "auto" }}>
        fan-out overhead ~{compactNumber(overhead_tokens)}
      </span>
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
      className="shrink-0 max-w-[160px]"
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

  return (
    <div
      className="border-b"
      style={{ borderColor: "var(--color-line-soft)" }}
    >
      <div className="flex items-start gap-2.5 px-3 py-2">
        <span className="aura-block-index shrink-0 mt-[2px]">
          {String(idx + 1).padStart(2, " ")}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="t-xs"
              style={{
                fontFamily: "var(--font-mono)",
                color: WORK_STATE[laneState(lane.status)].color,
                fontWeight: 600,
                letterSpacing: "0.04em",
              }}
            >
              {WORK_STATE[laneState(lane.status)].label}
            </span>
            {lane.provider_id && (
              <span
                className="t-xs"
                style={{
                  color: "var(--color-text-3)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {lane.provider_id}
              </span>
            )}
            {wasAutoRouted && lane.provider_id && (
              <span
                className="t-xs"
                style={{
                  color: "var(--color-accent)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                }}
                title="Aura chose this brain because it has done best on this kind of work before."
              >
                ● Aura picked this one
              </span>
            )}
          </div>
          <div
            className="t-sm leading-snug mt-1"
            style={{ color: "var(--color-text-1)" }}
          >
            {lane.spec.label ?? lane.spec.objective}
          </div>
          {conflict && (
            <div
              className="t-xs mt-1"
              // Reads from the same entry as the chip above, so the line that
              // explains the collision and the mark that flags it stay in step.
              style={{ color: WORK_STATE.conflict.color }}
            >
              zone conflict on <code>{conflict.zone}</code> with sibling lane
            </div>
          )}
          {lane.error && (
            <div
              className="t-xs mt-1"
              style={{ color: "var(--color-red)" }}
            >
              {lane.error}
            </div>
          )}
          {tail && lane.status === "running" && (
            <pre
              className="t-xs mt-1 whitespace-pre-wrap break-words"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-3)",
                background: "var(--color-bg-2)",
                padding: "4px 6px",
                borderRadius: 2,
                maxHeight: 72,
                overflow: "hidden",
              }}
            >
              {tail}
            </pre>
          )}
          {lane.summary && lane.status === "done" && (
            <div
              className="t-xs mt-1"
              style={{ color: "var(--color-text-2)" }}
            >
              summary: {lane.summary}
            </div>
          )}
        </div>
        {!isTerminal && (
          <button
            type="button"
            onClick={onCancel}
            className="aura-block-link shrink-0 mt-[2px]"
            style={{ color: "var(--color-text-3)" }}
            title="Stop this lane. Ends its brain's session and releases the files it had claimed"
          >
            CANCEL
          </button>
        )}
      </div>
    </div>
  );
}

function UnifiedChangeset({ changes }: { changes: UnifiedChange[] }) {
  return (
    <div
      className="aura-block-soft mx-3 mb-3 mt-1 overflow-hidden"
      style={{ border: "1px solid var(--color-line-soft)", borderRadius: 2 }}
    >
      <div
        className="px-3 py-1.5 border-b"
        style={{ borderColor: "var(--color-line-soft)" }}
      >
        <span className="aura-block-label">
          UNIFIED CHANGES · {changes.length}
        </span>
      </div>
      <div className="flex flex-col">
        {changes.map((c, idx) => (
          <div
            key={`${c.lane_id}:${c.path}:${idx}`}
            className="px-3 py-1.5 border-b"
            style={{ borderColor: "var(--color-line-soft)" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className="t-xs"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text-2)",
                  fontWeight: 600,
                }}
              >
                {c.path}
              </span>
              <span
                className="t-xs"
                style={{ color: "var(--color-text-3)" }}
              >
                lane {c.lane_id.slice(0, 8)}
              </span>
            </div>
            <pre
              className="t-xs whitespace-pre-wrap break-words"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-2)",
                background: "var(--color-bg-2)",
                padding: "6px 8px",
                borderRadius: 2,
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              {c.body}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

// SprintProgress — the BEAD-I phase-5 "Trace Overview tie-in" (doc 23 §5):
// velocity + sprint completion folded into the Overview's team-progress
// area. Loads the unified sprint/cycle store + tasks for the repo and
// renders one calm card: the active sprint's completion, its day index,
// and a "last sprints" velocity sparkline so throughput sits next to the
// team's activity.
//
// HONESTY RULE (matches OverviewPane): every figure is derived from real
// sprints + tasks. Closed sprints use the velocity frozen on the cycle at
// Close; sprints that merely ended fall back to their still-attached done
// work. The whole card returns null when there are no sprints, so the
// Overview stays empty rather than inventing a chart.

import { useEffect, useRef, useState } from "react";

import { api, type Sprint, type Task } from "../../lib/api";
import { fetchTasks } from "../../lib/tasksCache";
import { percent } from "../../lib/percent";

/** Local-day YYYY-MM-DD for comparing against sprint start/end strings. */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive day count between two YYYY-MM-DD strings (a==b → 1). */
function daysInclusive(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  if (Number.isNaN(da) || Number.isNaN(db) || db < da) return 1;
  return Math.round((db - da) / 86_400_000) + 1;
}

function dayIndex(s: Sprint): number {
  const today = ymd(new Date());
  if (today < s.start) return 0;
  if (today > s.end) return daysInclusive(s.start, s.end);
  return daysInclusive(s.start, today);
}

type Trend = { id: string; name: string; delivered: number };

/** Delivered work per past sprint, preferring the frozen velocity. */
function buildTrend(sprints: Sprint[], tasks: Task[], activeId: string | null): Trend[] {
  const today = ymd(new Date());
  return sprints
    .filter((s) => s.id !== activeId && (s.velocity != null || s.end < today))
    .map((s) => {
      if (s.velocity != null) {
        return { id: s.id, name: s.name, delivered: s.velocity };
      }
      const ts = tasks.filter((t) => t.cycle_id === s.id && !t.is_epic);
      const useP =
        ts.length > 0 && ts.every((t) => typeof t.estimate === "number" && t.estimate! > 0);
      const delivered = useP
        ? ts.filter((t) => t.status === "done").reduce((n, t) => n + (t.estimate ?? 0), 0)
        : ts.filter((t) => t.status === "done").length;
      return { id: s.id, name: s.name, delivered };
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(-8);
}

export function SprintProgress({ repoRoot }: { repoRoot: string }) {
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (!repoRoot) return;
    void (async () => {
      try {
        const [s, t] = await Promise.all([
          api.sprintsList(repoRoot),
          fetchTasks(repoRoot),
        ]);
        if (!aliveRef.current) return;
        setSprints(Array.isArray(s) ? s : []);
        setTasks(Array.isArray(t) ? t : []);
      } catch {
        if (aliveRef.current) {
          setSprints([]);
          setTasks([]);
        }
      }
    })();
    return () => {
      aliveRef.current = false;
    };
  }, [repoRoot]);

  if (sprints.length === 0) return null;

  // The sprint to headline: the active one, else the most recently-ended.
  const today = ymd(new Date());
  const active =
    sprints.find((s) => s.active) ??
    [...sprints].sort((a, b) => b.end.localeCompare(a.end))[0];

  const sprintTasks = tasks.filter(
    (t) => t.cycle_id === active.id && !t.is_epic,
  );
  const usePoints =
    sprintTasks.length > 0 &&
    sprintTasks.every((t) => typeof t.estimate === "number" && t.estimate! > 0);
  const total = usePoints
    ? sprintTasks.reduce((n, t) => n + (t.estimate ?? 0), 0)
    : sprintTasks.length;
  const done = usePoints
    ? sprintTasks.filter((t) => t.status === "done").reduce((n, t) => n + (t.estimate ?? 0), 0)
    : sprintTasks.filter((t) => t.status === "done").length;
  const pct = percent(done, total);

  const trend = buildTrend(sprints, tasks, active.active ? active.id : null);
  const peak = Math.max(1, ...trend.map((d) => d.delivered));
  const unit = usePoints ? "pts" : "tasks";

  const running = active.end >= today && active.start <= today;

  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="section-label">
        Sprint
      </h3>
      <div className="rounded-lg border border-line-soft bg-bg-1 px-3 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-base font-medium text-text-1">
            {active.name}
          </span>
          <span className="shrink-0 text-xs text-text-4">
            {active.velocity != null
              ? "completed"
              : running
                ? `day ${dayIndex(active)} / ${daysInclusive(active.start, active.end)}`
                : "planned"}
          </span>
        </div>

        {active.goal ? (
          <div className="mt-1 truncate text-sm text-text-3" title={active.goal}>
            {active.goal}
          </div>
        ) : null}

        {/* Completion bar */}
        <div className="mt-2.5 flex items-center gap-2.5">
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-2">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.max(pct, 2)}%`,
                background: "var(--color-accent)",
                opacity: 0.85,
              }}
            />
          </span>
          <span className="shrink-0 font-mono text-xs text-text-3 tabular-nums">
            {done}/{total} {unit} · {pct}%
          </span>
        </div>

        {/* Velocity trend — past sprints' delivered work. */}
        {trend.length > 0 ? (
          <div className="mt-3 flex items-end gap-1 border-t border-line-soft pt-2.5">
            <span className="section-label mr-1 self-center">
              Velocity
            </span>
            <div className="flex h-7 flex-1 items-end gap-[3px]">
              {trend.map((d) => (
                <span
                  key={d.id}
                  className="min-w-0 flex-1 rounded-t"
                  title={`${d.name}: ${d.delivered}`}
                  style={{
                    height: `${Math.max((d.delivered / peak) * 100, 4)}%`,
                    background: "var(--color-accent)",
                    opacity: 0.6,
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

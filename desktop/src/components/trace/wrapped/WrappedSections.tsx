// The year in review, drawn: a heading that says the year in a sentence, then
// the trace stats rows and captioned sections the rest of Trace reads in. One
// column, hairlines between readings, no boxes. Every number comes in from
// wrappedStats; nothing here counts anything.

import { type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { agentDisplayLabel } from "../../../lib/agentIdentity";
import { percent } from "../../../lib/percent";
import { AgentIcon } from "../../agent/AgentIcon";
import { EmptyState } from "../../ui/state";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { TraceLine, TraceSection } from "../../ui/trace-report";
import { TraceStat, TraceStats } from "../../ui/trace-stats";
import {
  MONTH_LABELS,
  fmtDate,
  fmtNum,
  typeLabel,
  type WrappedStats,
} from "./wrappedStats";

export function YearSwitch({
  years,
  active,
  onPick,
}: {
  years: number[];
  active: number;
  onPick: (y: number) => void;
}) {
  if (years.length < 2) return null;
  return (
    <ToggleGroup
      type="single"
      size="sm"
      aria-label="Which year"
      value={String(active)}
      onValueChange={(v) => v && onPick(Number(v))}
    >
      {years.map((y) => (
        <ToggleGroupItem key={y} value={String(y)}>
          {y}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function Hero({
  year,
  years,
  onPick,
  stats,
}: {
  year: number;
  years: number[];
  onPick: (y: number) => void;
  stats: WrappedStats;
}) {
  const range =
    stats.firstTs && stats.lastTs
      ? `${fmtDate(stats.firstTs * 1000)} – ${fmtDate(stats.lastTs * 1000)}`
      : null;
  return (
    <header className="ui-wrapped-hero">
      <div className="ui-wrapped-hero-top">
        <span className="ui-wrapped-kicker">Year in review</span>
        <YearSwitch years={years} active={year} onPick={onPick} />
      </div>
      <h1 className="ui-wrapped-year">{year}</h1>
      <p className="ui-wrapped-lede">
        You logged <strong>{fmtNum(stats.total)}</strong> intents across{" "}
        <strong>{fmtNum(stats.activeDays)}</strong> active{" "}
        {stats.activeDays === 1 ? "day" : "days"}
        {range ? `, from ${range}` : ""}.
      </p>
    </header>
  );
}

export function BigGrid({ stats }: { stats: WrappedStats }) {
  // The three churn figures are sums over runs that recorded a line count. On
  // a log where none did, they summed to zero and this row printed "+0 lines
  // added / −0 lines removed" beside "407 intents" — a year's work reported
  // as having changed nothing. Zero is only a fact here if something was
  // measured.
  const measured = stats.churnRuns > 0;
  // No "Intents" figure: the sentence directly above already reads "You
  // logged 407 intents". This row carries what the heading doesn't.
  const cells: ReactNode[] = [];
  // Sessions only when the log actually carried session ids — never invent.
  if (stats.sessions > 0) {
    cells.push(
      <TraceStat key="sessions" label="Sessions">
        {fmtNum(stats.sessions)}
      </TraceStat>,
    );
  }
  // Three figures each reading "— / not recorded" would say one thing three
  // times. When nothing was measured they go and a single line says it.
  if (measured) {
    cells.push(
      <TraceStat key="added" label="Lines added">
        <span className="ui-wrapped-num" data-tone="added">
          +{fmtNum(stats.added)}
        </span>
      </TraceStat>,
      <TraceStat key="removed" label="Lines removed">
        <span className="ui-wrapped-num" data-tone="removed">
          −{fmtNum(stats.removed)}
        </span>
      </TraceStat>,
      <TraceStat key="files" label="Files touched">
        {fmtNum(stats.filesTouched)}
      </TraceStat>,
    );
  }
  const note = !measured
    ? "Line and file counts weren’t recorded for these runs, so there’s no churn to total up."
    : stats.churnRuns < stats.total
      ? // Partial coverage is its own fact: the numbers are real, they just
        // don't cover every run. Say which, rather than letting a partial sum
        // pass for a total.
        `Line and file counts come from ${fmtNum(stats.churnRuns)} of ${fmtNum(
          stats.total,
        )} runs. The rest didn’t record them.`
      : null;
  if (cells.length === 0 && !note) return null;
  return (
    <div className="ui-wrapped-block">
      {cells.length > 0 ? <TraceStats label="What changed">{cells}</TraceStats> : null}
      {note ? <TraceLine tone="note">{note}</TraceLine> : null}
    </div>
  );
}

/** Ranked rows: a name, a meter giving its share of the largest, its count. */
function Bars({
  items,
}: {
  items: { key: string; label: string; icon?: ReactNode; count: number }[];
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="ui-wrapped-rows">
      {items.map((i) => (
        <div key={i.key} className="ui-wrapped-row">
          {i.icon}
          <span className="ui-wrapped-row-label">{i.label}</span>
          <span className="ui-wrapped-meter" aria-hidden>
            <span style={{ width: `${Math.max(3, (i.count / max) * 100)}%` }} />
          </span>
          <span className="ui-wrapped-count">{fmtNum(i.count)}</span>
        </div>
      ))}
    </div>
  );
}

export function Collaborators({ stats }: { stats: WrappedStats }) {
  const top = stats.agents[0];
  if (!top) return null;
  // With one agent in the log there is no ranking to report: a "top
  // collaborator" over a single full-width bar says the same thing three
  // times. A share of one is not a share. The "%" counts runs, not changes.
  const solo = stats.agents.length === 1;
  if (solo) {
    return (
      <TraceSection title="Who did the work">
        <div className="ui-wrapped-rows">
          <div className="ui-wrapped-row">
            <AgentIcon agentId={top.key} label={agentDisplayLabel(top.key)} size={16} />
            <span className="ui-wrapped-row-label">{agentDisplayLabel(top.key)}</span>
            <span className="ui-wrapped-count">
              {fmtNum(top.count)} runs, every run this year
            </span>
          </div>
        </div>
      </TraceSection>
    );
  }
  return (
    <TraceSection
      title="Your collaborators"
      trailing={
        <span className="ui-wrapped-aside">
          {agentDisplayLabel(top.key)} ran {percent(top.count, stats.total)}% of your runs
        </span>
      }
    >
      <Bars
        items={stats.agents.slice(0, 6).map((a) => ({
          key: a.key,
          label: agentDisplayLabel(a.key),
          icon: <AgentIcon agentId={a.key} label={agentDisplayLabel(a.key)} size={16} />,
          count: a.count,
        }))}
      />
    </TraceSection>
  );
}

export function Rhythm({ stats }: { stats: WrappedStats }) {
  return (
    <TraceStats label="Your rhythm">
      <TraceStat
        label="Longest streak"
        sub={stats.longestStreak === 1 ? "day" : "days in a row"}
      >
        {stats.longestStreak}
      </TraceStat>
      <TraceStat label="Active days">{fmtNum(stats.activeDays)}</TraceStat>
      {stats.busiestDay ? (
        <TraceStat label="Busiest day" sub={`${fmtNum(stats.busiestDay.count)} intents`}>
          {fmtDate(stats.busiestDay.dayMs)}
        </TraceStat>
      ) : null}
      {stats.busiestMonth !== null ? (
        <TraceStat
          label="Busiest month"
          sub={`${fmtNum(stats.monthly[stats.busiestMonth])} intents`}
        >
          {MONTH_LABELS[stats.busiestMonth]}
        </TraceStat>
      ) : null}
    </TraceStats>
  );
}

export function MonthlyStrip({ stats }: { stats: WrappedStats }) {
  const max = Math.max(1, ...stats.monthly);
  return (
    <TraceSection title="Across the year">
      <div className="ui-wrapped-months" role="img" aria-label="Intents logged per month">
        {stats.monthly.map((c, m) => (
          <div key={m} className="ui-wrapped-month">
            <div className="ui-wrapped-month-track">
              <span
                data-busiest={m === stats.busiestMonth || undefined}
                style={{ height: `${Math.max(2, (c / max) * 100)}%` }}
                title={`${MONTH_LABELS[m]}: ${fmtNum(c)} intents`}
              />
            </div>
            <span className="ui-wrapped-month-label">{MONTH_LABELS[m].charAt(0)}</span>
          </div>
        ))}
      </div>
    </TraceSection>
  );
}

export function WorkMix({ stats }: { stats: WrappedStats }) {
  return (
    <TraceSection title="What you worked on">
      <Bars
        items={stats.types.slice(0, 7).map((t) => ({
          key: t.key,
          label: typeLabel(t.key),
          count: t.count,
        }))}
      />
    </TraceSection>
  );
}

export function Provenance({ stats }: { stats: WrappedStats }) {
  const pct = percent(stats.signed, stats.total);
  // "Genuine records", not "Signed & verified" — the Overview one click away
  // already calls this exact measure Genuine records.
  return (
    <TraceSection
      title="Genuine records"
      trailing={
        <span className="ui-wrapped-aside">
          {fmtNum(stats.signed)} of {fmtNum(stats.total)}
        </span>
      }
    >
      <span className="ui-wrapped-meter" data-tone="sealed" aria-hidden>
        <span style={{ width: `${pct}%` }} />
      </span>
      <TraceLine>
        {pct}% of your runs are sealed. The record of what changed, and why, can&rsquo;t be
        altered afterwards, not even by you.
      </TraceLine>
    </TraceSection>
  );
}

export function EmptyYear({
  year,
  years,
  onPick,
}: {
  year: number;
  years: number[];
  onPick: (y: number) => void;
}) {
  return (
    <div className="ui-wrapped-empty">
      <YearSwitch years={years} active={year} onPick={onPick} />
      <EmptyState
        icon={CalendarDays}
        title={`No intents logged in ${year}`}
        body="Aura builds your year from the intent log: the reasons you (and your agents) recorded for each change. Once you log a few, this fills in."
      />
    </div>
  );
}

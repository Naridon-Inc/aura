// FeatureRoles — the "who worked it, and what shape is it in" panel: the plain
// facts of a feature (when it started, when it was last touched, how many
// sessions and commits it spans) and everyone whose checks moved it along. It's
// the Properties & Roles read — the same "who and what" Entire's Trails put in a
// side panel — but pulled straight from Aura's real run history, so every name
// and number is something that actually happened, not metadata someone typed.
//
// It stays quiet for a lone check with nothing to say; it earns its space once a
// feature was genuinely worked — by more than one party, or across commits or
// sessions.

import type { GoalRun } from "../../lib/goalStore";
import { VERDICT } from "../../lib/goalVerdict";
import { relativeAge } from "../../lib/relativeTime";
import { TraceItem, TraceItems, TraceLine } from "../ui/trace-report";
import { VERDICT_TONE } from "./verdictTone";
import "./goals.css";
import { describeFeature } from "../../lib/featureSignals";

function joinDot(parts: string[]): string {
  return parts.join(" · ");
}

// `className` styles the section wrapper (border/spacing). It lives on the
// section, not a parent div, so when there's nothing worth showing the whole
// thing collapses to null and leaves no stray divider behind.
export function FeatureRoles({ runs, className }: { runs: GoalRun[]; className?: string }) {
  const p = describeFeature(runs);
  // Nothing worth a panel for a single hand check with no commit behind it — the
  // thread already carries that. Show once a feature spread across parties,
  // sessions, or commits.
  const worth = p.contributors.length >= 2 || p.commits >= 1 || p.sessions >= 2;
  if (!worth || p.contributors.length === 0) return null;

  const facts: string[] = [];
  if (p.startedAt != null) facts.push(`Started ${relativeAge(p.startedAt)}`);
  if (p.lastAt != null) facts.push(`last active ${relativeAge(p.lastAt)}`);
  facts.push(`${p.sessions} session${p.sessions === 1 ? "" : "s"}`);
  if (p.commits > 0) facts.push(`${p.commits} commit${p.commits === 1 ? "" : "s"}`);

  return (
    <section className={className ? `ui-goal-part ${className}` : "ui-goal-part"}>
      <h3 className="ui-goal-part-title">Who worked it</h3>
      <TraceItems>
        {p.contributors.map((c) => (
          <TraceItem
            key={c.who}
            tone={VERDICT_TONE[c.lastVerdict]}
            title={c.who}
            marks={
              <span className="ui-goal-meta">
                {c.checks} check{c.checks === 1 ? "" : "s"} · {relativeAge(c.lastAt)} ·{" "}
                {VERDICT[c.lastVerdict].past}
              </span>
            }
          />
        ))}
      </TraceItems>
      <TraceLine tone="note">{joinDot(facts)}</TraceLine>
    </section>
  );
}

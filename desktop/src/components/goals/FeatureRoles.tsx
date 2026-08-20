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
    <section className={className}>
      <div className="section-label mb-1.5">
        Who worked it
      </div>
      <ul className="flex flex-col gap-0.5">
        {p.contributors.map((c) => (
          <li key={c.who} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: VERDICT[c.lastVerdict].color }}
              title={`${c.who} ${VERDICT[c.lastVerdict].past}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-text-2">{c.who}</span>
            <span className="text-2xs text-text-4 tabular-nums">
              {c.checks} check{c.checks === 1 ? "" : "s"}
            </span>
            <span className="text-2xs text-text-5">{relativeAge(c.lastAt)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 text-xs text-text-5">{joinDot(facts)}</div>
    </section>
  );
}

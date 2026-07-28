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

import type { GoalRun, GoalVerdict } from "../../lib/goalStore";
import { describeFeature } from "../../lib/featureSignals";

const DOT: Record<GoalVerdict, string> = {
  verified: "var(--color-accent-green)",
  partial: "var(--color-amber)",
  not_wired: "var(--color-red)",
  unknown: "var(--color-text-4)",
};

const LAST: Record<GoalVerdict, string> = {
  verified: "left it reached",
  partial: "left it partly there",
  not_wired: "left it not reached",
  unknown: "check was inconclusive",
};

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

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
  if (p.startedAt != null) facts.push(`Started ${ago(p.startedAt)}`);
  if (p.lastAt != null) facts.push(`last active ${ago(p.lastAt)}`);
  facts.push(`${p.sessions} session${p.sessions === 1 ? "" : "s"}`);
  if (p.commits > 0) facts.push(`${p.commits} commit${p.commits === 1 ? "" : "s"}`);

  return (
    <section className={className}>
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-4">
        Who worked it
      </div>
      <ul className="flex flex-col gap-0.5">
        {p.contributors.map((c) => (
          <li key={c.who} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: DOT[c.lastVerdict] }}
              title={LAST[c.lastVerdict]}
            />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-2">{c.who}</span>
            <span className="text-[10px] text-text-4 tabular-nums">
              {c.checks} check{c.checks === 1 ? "" : "s"}
            </span>
            <span className="text-[10px] text-text-5">{ago(c.lastAt)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 text-[10.5px] text-text-5">{joinDot(facts)}</div>
    </section>
  );
}

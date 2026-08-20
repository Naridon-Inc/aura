// Safety check — a structured surface for `aura pr-review --json`.
//
// Plain-language framing for non-engineers: "a second set of eyes on your
// changes — bugs, security holes, and things that don't match what you
// asked." It NEVER runs on its own: the surface lands calm with a press-to
// -run CTA, and the last result is cached (in-session + localStorage) so
// re-opening shows what it found last time with a "checked X ago · check
// again" strip, not a blank loading spinner the user never asked for.
//
// One question, plainly answered: "is this change healthy to keep?" The
// body is exactly two groups, no filter layer in between:
//
//   • Verdict       — what the check found: "Nothing broken", "Nothing
//                      broken — but it's a big change", or "N things worth
//                      a look". It reports; it never says you're cleared to
//                      keep something. See `verdictCopy`.
//   • Worth fixing   — the things actually wrong (rules broken +
//                      clashes with another version). The only blocking list.
//   • Good to know   — context, collapsed: what else it touches, changes
//                      with no note, style nudges. Real engine output, but
//                      not defects, so it never inflates the headline.
//
// Distinct from the other two trust surfaces by design: the Safety check
// answers "healthy to keep?", Alignment answers "did it match the ask?", and
// the Gate answers "is this dangerous right now?". Backend: aura-cli/src/pr.rs.

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { relativeAge } from "../../lib/relativeTime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { api } from "../../lib/api";
import { humanizeFindingText } from "../../lib/humanizeFinding";
import { askConfirm } from "../ui/ask";
import { verdictCopy, type RiskLabel } from "../../lib/reviewVerdict";


type ReviewReport = {
  base_branch: string;
  total_changes: number;
  unverified_nodes: Record<string, number>;
  invariant_violations: string[];
  blast_radius: string[];
  cross_branch_conflicts: string[];
  risk_score: number;
  risk_label: RiskLabel;
  omni_graph_impact?: string[];
  /** Advisory coding-pattern nits from the Taste Engine. Real signal but
   *  not defects — they ride in Details, not the blocking problem list. */
  taste_findings?: string[];
};

type Severity = "high" | "med";

// Category derived from finding source. Mirrors Graphite Diamond's
// taxonomy but mapped onto Aura's invariant model: forbidden_call →
// security, layer rule → architecture, cross-branch → conflict.
type Category = "security" | "architecture" | "conflict";

type Finding = {
  severity: Severity;
  source: string;
  text: string;
  category: Category;
};

type ReviewDialogProps = {
  open: boolean;
  repoRoot: string;
  baseBranch?: string;
  onClose: () => void;
  inline?: boolean;
};

// ── result cache ───────────────────────────────────────────────────────
// The safety check is on-demand, so the last result is cached and shown
// instead of re-running every time the surface opens. In-session via a
// module Map for instant reopen; mirrored to localStorage so it also
// survives an app restart. Keyed by repo + base branch (a different base
// is a different question). Capped tiny — only the latest per key is kept.

type CachedReview = { report: ReviewReport; ranAt: number };

const reviewCache = new Map<string, CachedReview>();

function cacheKey(repoRoot: string, base: string): string {
  return `${repoRoot}::${base}`;
}

function loadCachedReview(repoRoot: string, base: string): CachedReview | null {
  const k = cacheKey(repoRoot, base);
  const mem = reviewCache.get(k);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(`aura.safetycheck.${k}`);
    if (raw) {
      const parsed = JSON.parse(raw) as CachedReview;
      if (parsed && parsed.report && typeof parsed.ranAt === "number") {
        reviewCache.set(k, parsed);
        return parsed;
      }
    }
  } catch {
    /* private mode / parse error — treat as no cache */
  }
  return null;
}

function saveCachedReview(repoRoot: string, base: string, v: CachedReview): void {
  const k = cacheKey(repoRoot, base);
  reviewCache.set(k, v);
  try {
    localStorage.setItem(`aura.safetycheck.${k}`, JSON.stringify(v));
  } catch {
    /* best-effort */
  }
}

function agoLabel(ms: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAge(ms);
}

export function ReviewDialog({ open, repoRoot, baseBranch = "main", onClose, inline }: ReviewDialogProps) {
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState(baseBranch);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.auraCli(repoRoot, ["pr-review", "--base", base, "--json"]);
      const trimmed = res.stdout.trim();
      if (!trimmed) {
        setError(res.stderr.trim() || `exit ${res.status}`);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as ReviewReport;
        const now = Date.now();
        setReport(parsed);
        setRanAt(now);
        saveCachedReview(repoRoot, base, { report: parsed, ranAt: now });
      } catch (e) {
        setError(`Could not parse review output: ${String(e)}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // On open (and whenever the repo/base changes), load the LAST cached
  // result instead of running. The check only runs when the user presses
  // the button — no uninvited spinner. A different repo or base with no
  // cache lands on the calm "run it" CTA.
  useEffect(() => {
    if (!open) return;
    const cached = loadCachedReview(repoRoot, base);
    setReport(cached?.report ?? null);
    setRanAt(cached?.ranAt ?? null);
    setError(null);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoRoot, base]);

  // Problems = things actually wrong. Invariant violations and
  // cross-branch conflicts both block a clean merge; everything else the
  // report carries is impact or bookkeeping, not a defect.
  const problems = useMemo<Finding[]>(() => {
    if (!report) return [];
    const out: Finding[] = [];
    for (const v of report.invariant_violations) {
      out.push({ ...classifyViolation(v), source: "invariant", text: v });
    }
    for (const c of report.cross_branch_conflicts) {
      out.push({ severity: "high", source: "cross-branch", text: c, category: "conflict" });
    }
    return out;
  }, [report]);

  const impact = useMemo(() => {
    if (!report) return [] as string[];
    return [...report.blast_radius, ...(report.omni_graph_impact ?? [])];
  }, [report]);

  const unverifiedTotal = useMemo(
    () => (report ? Object.values(report.unverified_nodes).reduce((a, b) => a + b, 0) : 0),
    [report],
  );

  const taste = useMemo(() => report?.taste_findings ?? [], [report]);

  const [autoFixBusy, setAutoFixBusy] = useState(false);
  const [autoFixToast, setAutoFixToast] = useState<string | null>(null);

  const runAutoFix = async () => {
    if (
      !(await askConfirm({
        title: "Let Aura try to fix these automatically?",
        body: "It edits the files to resolve them. Your changes are saved first, so you can undo it.",
        confirmLabel: "Fix them",
      }))
    ) {
      return;
    }
    setAutoFixBusy(true);
    setAutoFixToast(null);
    try {
      const res = await api.auraCli(repoRoot, ["suggest-fix", "--base", base]);
      if (res.status !== 0) {
        setAutoFixToast(`Couldn't fix it automatically: ${res.stderr.trim() || `exit ${res.status}`}`);
      } else {
        setAutoFixToast("Fixed. Checking again");
        await run();
      }
      setTimeout(() => setAutoFixToast(null), 4000);
    } catch (e) {
      setAutoFixToast(`Something went wrong: ${String(e)}`);
    } finally {
      setAutoFixBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      inline={inline}
      onClose={onClose}
      title={`Safety check · ${base}`}
      width={720}
      footer={
        <>
          <Input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="compare against"
            title="Which version to compare your changes against"
            className="w-32"
          />
          {report && report.invariant_violations.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={runAutoFix}
              disabled={autoFixBusy || loading}
              title="Let Aura try to fix these automatically"
              className="text-accent-green hover:text-accent-green"
            >
              {autoFixBusy ? "Fixing…" : "Fix for me"}
            </Button>
          )}
          {/* Only offer re-run once there's something cached to re-run.
              The first run is the big CTA in the calm landing body. */}
          {report && (
            <Button variant="ghost" size="xs" onClick={run} disabled={loading}>
              {loading ? "Checking…" : "Check again"}
            </Button>
          )}
          <Button variant="default" size="xs" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? (
        <div className="flex flex-col gap-3">
          <div role="alert" className="text-red text-sm py-2">{error}</div>
          <Button variant="default" size="xs" onClick={run} disabled={loading} className="self-start">
            {loading ? "Checking…" : "Try again"}
          </Button>
        </div>
      ) : !report ? (
        // Calm landing — nothing runs until asked. Lead with what this IS,
        // in plain language, then a single press-to-run CTA.
        <SafetyCheckLanding base={base} loading={loading} onRun={run} />
      ) : (
        <div className={`flex flex-col gap-3 ${inline ? "" : "max-h-[68vh]"}`}>
          {ranAt != null && <CheckedStrip ranAt={ranAt} loading={loading} onRecheck={run} />}

          <Verdict
            report={report}
            problemCount={problems.length}
            unverified={unverifiedTotal}
          />

          {autoFixToast && (
            <div className="text-sm text-accent-green border border-accent-green/40 rounded px-2 py-1">
              {autoFixToast}
            </div>
          )}

          {problems.length > 0 && (
            <div className="flex flex-col gap-2 min-h-0">
              <div className="section-label">
                Worth fixing
                <span className="ml-1.5 font-normal text-text-4">{problems.length}</span>
              </div>
              <ul className={`flex flex-col gap-1.5 pr-1 ${inline ? "" : "overflow-auto"}`}>
                {problems.map((f, i) => (
                  <FindingRow key={i} finding={f} />
                ))}
              </ul>
            </div>
          )}

          <Details
            report={report}
            impact={impact}
            unverifiedTotal={unverifiedTotal}
            taste={taste}
            inline={inline}
          />
        </div>
      )}
    </Dialog>
  );
}

// Calm landing — the surface NEVER auto-runs, so the first thing the
// builder sees is what a safety check is for (plain language, their
// fears answered) and one button to run it. No uninvited spinner.
function SafetyCheckLanding({
  base,
  loading,
  onRun,
}: {
  base: string;
  loading: boolean;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-10">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
        style={{ background: "color-mix(in oklab, var(--color-accent) 14%, transparent)" }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 5 5.5v5.2c0 4.4 3 7.3 7 8.8 4-1.5 7-4.4 7-8.8V5.5Z" />
          <path d="m9 11.5 2 2 4-4.2" />
        </svg>
      </div>
      <div className="text-text-1 text-lg font-semibold mb-2">Run a safety check</div>
      <p className="text-text-2 text-base leading-relaxed max-w-[420px]">
        A second set of eyes on everything you&apos;ve changed since{" "}
        <span className="font-mono text-text-1">{base}</span>. It looks for bugs,
        security holes, and things that don&apos;t match what you asked for.
      </p>
      <p className="text-text-4 text-xs leading-relaxed max-w-[420px] mt-2.5">
        Nothing runs until you press the button, and the result is kept so you
        can come back to it without re-checking.
      </p>
      <Button
        variant="default"
        size="sm"
        onClick={onRun}
        disabled={loading}
        className="mt-5"
      >
        {loading ? "Checking your changes…" : "Run safety check"}
      </Button>
    </div>
  );
}

// "Checked X ago · check again" strip above a cached result, so the
// builder knows whether they're looking at something fresh or stale.
function CheckedStrip({
  ranAt,
  loading,
  onRecheck,
}: {
  ranAt: number;
  loading: boolean;
  onRecheck: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-text-4">
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: loading ? "var(--color-amber)" : "var(--color-text-5)" }}
      />
      <span>{loading ? "Checking your changes…" : `Last checked ${agoLabel(ranAt)}`}</span>
      {!loading && (
        <button
          type="button"
          onClick={onRecheck}
          className="ml-1 text-text-3 hover:text-text-1 underline-offset-2 hover:underline transition-colors"
        >
          check again
        </button>
      )}
    </div>
  );
}

// The lead. Counts real problems, never impact. Risk label from the
// engine rides along as a quiet tag so power users still see it — in its
// OWN colour, so a CRITICAL never renders green just because nothing
// tripped the two counters `problemCount` is built from.
function Verdict({
  report,
  problemCount,
  unverified,
}: {
  report: ReviewReport;
  problemCount: number;
  unverified: number;
}) {
  const v = verdictCopy({
    problems: problemCount,
    totalChanges: report.total_changes,
    risk: report.risk_label,
    unverified,
  });
  // Color rides on the glyph/risk-tag only — never as a full card fill.
  const fg =
    v.tone === "good"
      ? "var(--color-accent-green)"
      : v.tone === "bad"
        ? "var(--color-red)"
        : "var(--color-amber)";
  return (
    <div className="rounded-lg px-3 py-3 border border-line-soft bg-bg-1">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="text-base leading-none flex-shrink-0" style={{ color: fg }}>
          {v.glyph}
        </span>
        <span className="text-md font-semibold text-text-1">{v.headline}</span>
        <span
          className="ml-auto text-2xs px-1.5 py-0.5 rounded border border-line-soft"
          style={{ color: riskTone(report.risk_label) }}
          title={`Aura's overall read on these changes: ${String(report.risk_label).toLowerCase()}`}
        >
          {report.risk_label}
        </span>
      </div>
      <div className="text-sm text-text-2 mt-1.5 leading-snug">{v.sub}</div>
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const tone = sevTone(finding.severity);
  return (
    <li className="flex items-start gap-2 px-2.5 py-2 rounded border bg-bg-1" style={{ borderColor: tone.border }}>
      <span className="shrink-0 mt-0.5" style={{ color: tone.fg }}>
        {tone.glyph}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          {/* The kind of problem is a label, not an alarm — the severity glyph and
              the row border already carry the "look at me". A third hue per
              category just made the list noisy. */}
          <span className="meta-tag">
            {categoryLabel(finding.category)}
          </span>
          <span className="section-label">{sourceLabel(finding.source)}</span>
        </div>
        <div className="text-sm text-text-1 leading-snug break-words whitespace-pre-wrap">
          {humanizeFindingText(finding.text)}
        </div>
      </div>
    </li>
  );
}

// Context, not defects — downstream impact and undocumented changes. One
// click away, collapsed by default.
function Details({
  report,
  impact,
  unverifiedTotal,
  taste,
  inline,
}: {
  report: ReviewReport;
  impact: string[];
  unverifiedTotal: number;
  taste: string[];
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = impact.length + unverifiedTotal + taste.length;
  if (count === 0) return null;
  return (
    <div className="border-t border-line-soft pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-text-3 hover:text-text-1 transition-colors"
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 12 12"
          fill="none"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span>Good to know. What else this touches, missing notes & style ({count})</span>
      </button>
      {open && (
        <div className={`mt-3 flex flex-col gap-3 ${inline ? "" : "overflow-auto pr-1 max-h-[40vh]"}`}>
          {impact.length > 0 && (
            <Section title={`What else this touches · ${impact.length}`}>
              <div className="text-xs text-text-4 mb-1">
                Other parts of the code that lean on what changed. Worth a look, but not problems.
              </div>
              <ul className="flex flex-col gap-0.5">
                {impact.slice(0, 80).map((n, i) => (
                  <li key={i} className="text-sm font-mono text-text-2 px-2 py-1 rounded hover:bg-state-hover">
                    <span className="text-amber mr-2">↳</span>
                    {n}
                  </li>
                ))}
                {impact.length > 80 && (
                  <li className="text-xs text-text-4 px-2">… and {impact.length - 80} more</li>
                )}
              </ul>
            </Section>
          )}
          {unverifiedTotal > 0 && (
            <Section title={`Changes with no note · ${unverifiedTotal}`}>
              <div className="text-xs text-text-4 mb-1">
                Some logic changed without a note saying why. Adding a quick note keeps the
                history clear for later.
              </div>
              <ul className="flex flex-col gap-1">
                {Object.entries(report.unverified_nodes)
                  .sort((a, b) => b[1] - a[1])
                  .map(([kind, n]) => (
                    <li
                      key={kind}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line-soft bg-bg-1"
                    >
                      <span className="text-sm text-text-1 capitalize">{kind}</span>
                      <span className="ml-auto text-xs text-text-3 tabular-nums">{n}</span>
                    </li>
                  ))}
              </ul>
            </Section>
          )}
          {taste.length > 0 && (
            <Section title={`Style · ${taste.length}`}>
              <div className="text-xs text-text-4 mb-1">
                Small style suggestions Aura picked up from this project, not problems,
                just gentle nudges.
              </div>
              <ul className="flex flex-col gap-0.5">
                {taste.slice(0, 40).map((t, i) => (
                  <li
                    key={i}
                    className="text-sm font-mono text-text-2 px-2 py-1 rounded hover:bg-state-hover break-words whitespace-pre-wrap"
                  >
                    <span className="text-amber mr-2">🧪</span>
                    {t}
                  </li>
                ))}
                {taste.length > 40 && (
                  <li className="text-xs text-text-4 px-2">
                    … and {taste.length - 40} more
                  </li>
                )}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="section-label mb-1">{title}</div>
      {children}
    </div>
  );
}

// The one ink the verdict line is allowed to spend. Reads through the live
// tokens so a retuned palette can't leave a stale hex behind.
function riskTone(label: RiskLabel): string {
  if (label === "CRITICAL") return "var(--color-red)";
  if (label === "MODERATE") return "var(--color-amber)";
  return "var(--color-accent-green)";
}

// Plain-word labels for the finding chips — non-engineers don't read
// "architecture" / "invariant" / "cross-branch". Same words as the filter
// chips so the row and the filter read alike.
function categoryLabel(c: Category): string {
  switch (c) {
    case "security":
      return "safety";
    case "architecture":
      return "structure";
    case "conflict":
    default:
      return "clash";
  }
}

function sourceLabel(source: string): string {
  if (source === "invariant") return "broke a rule";
  if (source === "cross-branch") return "clashes with another version";
  return source;
}

function sevTone(s: Severity): { fg: string; border: string; glyph: string } {
  if (s === "high") return { fg: "var(--color-red)", border: "var(--color-red)", glyph: "✗" };
  return { fg: "var(--color-amber)", border: "var(--color-amber)", glyph: "⚠" };
}

// Plain-language rewrite of the engine's own invariant wording. The four real
// shapes (pr.rs) lead with AST jargon ("Protected Node…") that means nothing to
// Derive a finding's severity + category from the engine's own wording
// rather than hardcoding "high" on every row. The four real invariant
// shapes (pr.rs): "Forbidden Call…", "Layer Violation…", "Protected Node
// Modified…", "Protected Node Deleted…". Deleting a protected node or making
// a forbidden/layer-crossing call blocks a merge (high); *modifying* a
// protected-but-allowed block is a warning to look twice (med).
function classifyViolation(text: string): { severity: Severity; category: Category } {
  if (text.startsWith("Forbidden")) return { severity: "high", category: "security" };
  if (text.startsWith("Layer Violation")) return { severity: "high", category: "architecture" };
  if (text.startsWith("Protected Node Deleted")) return { severity: "high", category: "security" };
  if (text.startsWith("Protected Node Modified")) return { severity: "med", category: "security" };
  // Unknown invariant text → treat as a blocking architectural finding.
  return { severity: "high", category: "architecture" };
}

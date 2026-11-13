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
//
// Drawn like repository health: the verdict line, then what it found as the
// shared check list, the context folded into the shared accordion, and the
// shared empty and error states before and around it.

import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "../Dialog";
import { relativeAge } from "../../lib/relativeTime";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { EmptyState, ErrorState } from "../ui/state";
import { api } from "../../lib/api";
import { askConfirm } from "../ui/ask";
import { verdictCopy, type RiskLabel } from "../../lib/reviewVerdict";
import { classifyViolation, GoodToKnow, WorthFixing, type Finding } from "./ReviewFindings";
import "../ui/check-report.css";
import "../ui/compare-copies.css";


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

  const autoFixFailed = autoFixToast != null && !autoFixToast.startsWith("Fixed");

  return (
    <Dialog
      open={open}
      inline={inline}
      onClose={onClose}
      title="Safety check"
      width={720}
      footer={
        <>
          {!inline && (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
          {report && report.invariant_violations.length > 0 && (
            <Button
              variant="outline"
              onClick={runAutoFix}
              disabled={autoFixBusy || loading}
              title="Let Aura try to fix these automatically"
            >
              {autoFixBusy ? "Fixing…" : "Fix for me"}
            </Button>
          )}
          {/* Only offer re-run once there's something cached to re-run.
              The first run is the action in the calm landing body. */}
          {report && (
            <Button onClick={run} disabled={loading}>
              {loading ? "Checking…" : "Check again"}
            </Button>
          )}
        </>
      }
    >
      <div className="ui-check-report" data-scroll={inline ? undefined : ""}>
        <label className="ui-compare-base">
          <span>Compare against</span>
          <Input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="main"
            title="Which version to compare your changes against"
            className="ui-compare-branch"
            style={{ width: 160 }}
          />
        </label>
        {error ? (
          <ErrorState
            title="Couldn’t run the safety check"
            message={error}
            onRetry={() => void run()}
            size="sm"
          />
        ) : !report ? (
          // Calm landing — nothing runs until asked. Lead with what this IS,
          // in plain language, then a single press-to-run action.
          <EmptyState
            icon={ShieldCheck}
            title="Run a safety check"
            body={
              <>
                A second set of eyes on everything you&apos;ve changed since{" "}
                <code className="ui-compare-branch">{base}</code>. It looks for bugs, security holes,
                and things that don&apos;t match what you asked for.
              </>
            }
            action={{
              label: loading ? "Checking your changes…" : "Run safety check",
              onClick: () => void run(),
              disabled: loading,
            }}
            footnote="Nothing runs until you press the button, and the result is kept so you can come back to it without checking again."
          />
        ) : (
          <>
            {ranAt != null && (
              <p className="ui-check-report-when">
                {loading ? (
                  <>
                    <AsciiSpinner /> Checking your changes…
                  </>
                ) : (
                  `Last checked ${agoLabel(ranAt)}`
                )}
              </p>
            )}
            <Verdict report={report} problemCount={problems.length} unverified={unverifiedTotal} />
            {autoFixToast && (
              <Alert variant={autoFixFailed ? "destructive" : "default"}>
                <AlertDescription>{autoFixToast}</AlertDescription>
              </Alert>
            )}
            <WorthFixing problems={problems} />
            <GoodToKnow
              impact={impact}
              unverified={report.unverified_nodes}
              unverifiedTotal={unverifiedTotal}
              taste={taste}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

// The lead. Counts real problems, never impact. The engine's risk label rides
// along as a quiet tag so power users still see it — in its OWN colour, so a
// CRITICAL never renders green just because nothing tripped the two counters
// `problemCount` is built from.
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
  return (
    <header className="ui-verdict" data-tone={v.tone}>
      <div className="ui-verdict-line">
        <strong>{v.headline}</strong>
        <Badge
          variant="outline"
          style={{ color: riskTone(report.risk_label) }}
          title={`Aura's overall read on these changes: ${String(report.risk_label).toLowerCase()}`}
        >
          {report.risk_label}
        </Badge>
      </div>
      <span>{v.sub}</span>
    </header>
  );
}

// The one ink the verdict line is allowed to spend on the risk tag.
function riskTone(label: RiskLabel): string {
  if (label === "CRITICAL") return "var(--ui-red)";
  if (label === "MODERATE") return "var(--ui-yellow)";
  return "var(--ui-green)";
}

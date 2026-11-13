// ChecksPane — the "Ready to ship" home (Semantic CI for non-engineers).
//
// This answers a different question from "Safety check": that surface reviews
// *this change* (bugs, security, did it match the ask); this one is the
// pre-ship gate for the *whole project* — no leaked secrets, no half-finished
// code, and it still builds. Kept deliberately distinct so the two never read
// as the same thing.
//
// Verdict-first, modeled on GoalsPane: each check is a row with a plain-
// language name ("No half-finished code") and a verdict glyph. The headline at
// the top says what happened in human terms ("Your checks ran — 4 passed, 1
// needs a look"). Mechanism is on demand: click a row to disclose the
// command tail / the failing AST nodes — never up front.
//
// Data path mirrors ReviewDialog: drive `aura ci run --json` through the CLI
// passthrough (api.getChecks). Two speeds, mapped to the engine's own triggers:
//   • QUICK (`--trigger pre-commit`) — the fast gates only (no leaked secrets,
//     no half-finished code, goal alignment). ~0ms, no compiler. This is what
//     runs AUTOMATICALLY: on open, after every commit (`aura:git-changed`), and
//     when the window regains focus — so the verdict stays live instead of a
//     stale cached snapshot you have to remember to re-run.
//   • FULL (`--trigger pr`) — the same gates PLUS the real build (`cargo check`
//     / `tsc` / …), which is slow (30–120s), so it stays a deliberate button.
// The last run is cached in localStorage so the pane paints instantly, then the
// quick auto-run refreshes it. Title-less FullscreenOverlay — the surface
// carries its own context.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Circle, Hourglass, Radio, ShieldCheck, X } from "lucide-react";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { relativeAge } from "../../lib/relativeTime";
import { loadCachedChecks, saveCachedChecks } from "../../lib/checksEvidence";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { EmptyState, ErrorState } from "../ui/state";
import {
  api,
  type CiPipelineRun,
  type CiStatus,
  type CiStepResult,
  type CiTrigger,
} from "../../lib/api";
import "../ui/check-report.css";
import "../ui/log-note.css";
import "../ui/checks-page.css";

type ChecksPaneProps = {
  repoRoot: string;
  onClose: () => void;
};

// Verdict → the shared check-run row: its status (which colours the mark), the
// mark itself, and the plain-language label a non-passing row says under it.
const STATUS: Record<
  CiStatus,
  { label: string; status: string; icon: typeof Check; hint: string }
> = {
  pass: { label: "Passed", status: "passed", icon: Check, hint: "This check is clean." },
  fail: { label: "Needs a look", status: "failed", icon: X, hint: "This check found something." },
  timeout: {
    label: "Took too long",
    status: "attention",
    icon: Hourglass,
    hint: "This check ran out of time and was stopped.",
  },
  skip: {
    label: "Not applicable",
    status: "pending",
    icon: Circle,
    hint: "Nothing here needed this check.",
  },
};

// The two run speeds. QUICK is the fast gate set that auto-runs live on every
// commit; FULL adds the slow build and only runs when the user asks (or in
// cloud CI on a PR). Mapped to the engine's own trigger→steps wiring.
type RunMode = "quick" | "full";
const TRIGGER_FOR: Record<RunMode, CiTrigger> = {
  quick: "pre-commit",
  full: "pr",
};

// The cache moved to lib/checksEvidence: the session review reads this same
// record as its only evidence of commands that actually executed, and a key
// owned privately by one pane is a key the two surfaces drift apart on.
type Cached = { runs: CiPipelineRun[]; ranAt: number; mode?: RunMode };

function loadCached(repoRoot: string): Cached | null {
  return loadCachedChecks(repoRoot) as Cached | null;
}

function saveCached(repoRoot: string, value: Cached): void {
  saveCachedChecks(repoRoot, value);
}

export function ChecksPane({ repoRoot, onClose }: ChecksPaneProps) {
  const [runs, setRuns] = useState<CiPipelineRun[]>([]);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [lastMode, setLastMode] = useState<RunMode | null>(null);
  // `fullBusy` = a manual build is running (slow — shows a real "Running…");
  // `quickBusy` = the fast auto-run is in flight (near-instant — a quiet
  // "Checking…"). Split so the live auto-refresh never masquerades as the heavy
  // build, and a build in progress is never interrupted by an auto-run.
  const [fullBusy, setFullBusy] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A run finished but produced zero checks. A real run always returns at
  // least the built-in pipeline, so this means the CLI couldn't run them
  // (an old `aura` without `ci`, not a git repo, or a parse error) — we must
  // NOT fall back to the calm "ready" empty state, which would imply success.
  const [ranEmpty, setRanEmpty] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  // Refs mirror the busy state so the stable `runChecks` callback reads them
  // without going stale: an auto quick-run skips itself when anything is already
  // in flight, and never stomps a manual build.
  const inflightRef = useRef(false);
  const fullBusyRef = useRef(false);

  // Paint instantly from the last cached result; the quick auto-run below then
  // refreshes it so what's shown is current with your latest commit.
  useEffect(() => {
    const cached = loadCached(repoRoot);
    if (cached) {
      setRuns(cached.runs);
      setRanAt(cached.ranAt);
      setLastMode(cached.mode ?? null);
    }
  }, [repoRoot]);

  const runChecks = useCallback(
    async (mode: RunMode) => {
      // A quick auto-run yields to anything already running (including a build);
      // a FULL run is an explicit user action, so it always proceeds.
      if (mode === "quick" && (inflightRef.current || fullBusyRef.current)) {
        return;
      }
      inflightRef.current = true;
      if (mode === "full") {
        fullBusyRef.current = true;
        setFullBusy(true);
      } else {
        setQuickBusy(true);
      }
      setError(null);
      setRanEmpty(false);
      try {
        const result = await api.getChecks(repoRoot, TRIGGER_FOR[mode]);
        const now = Date.now();
        if (result.length === 0) {
          // [] means the CLI couldn't run them (an old `aura` without `ci`, not
          // a git repo, or a parse error) — NOT "all clear". Surface it plainly
          // and keep any earlier good result rather than blanking to success.
          setRanEmpty(true);
        } else {
          setRuns(result);
          setRanAt(now);
          setRanEmpty(false);
          setLastMode(mode);
          saveCached(repoRoot, { runs: result, ranAt: now, mode });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inflightRef.current = false;
        if (mode === "full") {
          fullBusyRef.current = false;
          setFullBusy(false);
        } else {
          setQuickBusy(false);
        }
      }
    },
    [repoRoot],
  );

  // Live: run the fast gates on open, after every commit/push (the app fires
  // `aura:git-changed` on commit/push/pull/checkout), and whenever the window
  // regains focus (catches commits made in a terminal while the pane is open).
  useEffect(() => {
    void runChecks("quick");
    const onGitChanged = () => void runChecks("quick");
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void runChecks("quick");
    };
    window.addEventListener("aura:git-changed", onGitChanged);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("aura:git-changed", onGitChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [runChecks]);

  const exportToCloud = useCallback(async () => {
    setExporting(true);
    setExportedPath(null);
    try {
      const res = await api.exportChecks(repoRoot);
      if (res.status === 0) {
        setExportedPath(".github/workflows/aura-checks.yml");
      } else {
        setError(res.stderr || "Export failed.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [repoRoot]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const { passed, needsLook, skipped, headline } = useMemo(
    () => summarize(runs),
    [runs],
  );

  const tone =
    runs.length === 0 ? undefined : needsLook > 0 ? "bad" : skipped > 0 ? "attention" : "good";

  return (
    <FullscreenOverlay
      onClose={onClose}
      actions={
        <div className="ui-checks-actions">
          {quickBusy && !fullBusy && (
            <span className="ui-check-report-when">
              <AsciiSpinner size={10} />
              Checking…
            </span>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void runChecks("full")}
            disabled={fullBusy}
            title="Run every check, including the real build. The full pre-ship gate."
          >
            {fullBusy ? "Building…" : "Run full check"}
          </Button>
        </div>
      }
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="ui-checks-page">
        <div className="ui-check-report">
          <ChecksHeadline
            headline={headline}
            tone={tone}
            passed={passed}
            needsLook={needsLook}
            skipped={skipped}
            ranAt={ranAt}
            mode={lastMode}
            checking={quickBusy && !fullBusy}
            hasRuns={runs.length > 0}
            countsInTitle={runs.length !== 1}
            failedToRun={runs.length === 0 && ranEmpty}
          />

          {error && (
            <ErrorState
              size="sm"
              title="Couldn’t run your checks"
              message={error}
              onRetry={() => void runChecks("quick")}
            />
          )}

          {runs.length === 0 && ranEmpty ? (
            <ErrorState
              title="Couldn’t run your checks"
              message="Nothing came back from the checks just now. This usually clears up on a retry. If it keeps happening, make sure this folder is opened as a repository and your Aura is up to date."
              onRetry={quickBusy ? undefined : () => void runChecks("quick")}
            />
          ) : runs.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="Ready-to-ship checks"
              body="Aura watches your work for ship-readiness: no leaked secrets, no half-finished pieces, and the repository still builds. The first three re-check on their own after every commit; run the full check to include the build."
              action={{
                label: quickBusy || fullBusy ? "Checking…" : "Run full check",
                onClick: () => void runChecks("full"),
                disabled: quickBusy || fullBusy,
              }}
            />
          ) : (
            runs.map((pipelineRun) => (
              <PipelineSection
                key={pipelineRun.pipeline}
                run={pipelineRun}
                expanded={expanded}
                onToggle={toggle}
              />
            ))
          )}

          {/* A re-run came back empty while an earlier good result is still
              shown — say so, so the rows below aren't read as fresh. */}
          {runs.length > 0 && ranEmpty && (
            <p className="ui-check-report-when" data-tone="attention">
              <AlertTriangle size={12} />
              Couldn’t run your checks just now. Showing the last result.
            </p>
          )}

          <CloudAffordance
            exporting={exporting}
            exportedPath={exportedPath}
            onExport={() => void exportToCloud()}
          />
        </div>
      </div>
    </FullscreenOverlay>
  );
}

function ChecksHeadline({
  headline,
  tone,
  passed,
  needsLook,
  skipped,
  ranAt,
  mode,
  checking,
  hasRuns,
  countsInTitle,
  failedToRun,
}: {
  headline: string;
  tone: "good" | "attention" | "bad" | undefined;
  passed: number;
  needsLook: number;
  skipped: number;
  ranAt: number | null;
  mode: RunMode | null;
  checking: boolean;
  hasRuns: boolean;
  /** The folded headline already says the counts; the engine's own one-run
   *  headline doesn't, so only then are they repeated underneath. */
  countsInTitle: boolean;
  failedToRun: boolean;
}) {
  const title = hasRuns
    ? headline
    : failedToRun
      ? "Couldn't run your checks."
      : checking
        ? "Checking your latest commit…"
        : "Watching your latest commit.";
  return (
    <>
      <header className="ui-verdict" data-tone={tone}>
        <strong>{title}</strong>
        {hasRuns && (
          <span>
            {!countsInTitle && (
              <>
                {passed} passed
                {needsLook > 0 && <> · {needsLook} {needsLook === 1 ? "needs" : "need"} a look</>}
                {/* A skipped check isn't a passed one. Left out of this line,
                    it was invisible everywhere — and "N passed" read as the
                    whole run. */}
                {skipped > 0 && <> · {skipped} skipped</>}
                {ranAt && " · "}
              </>
            )}
            {ranAt && <>Checked {relativeTime(ranAt)}</>}
          </span>
        )}
      </header>
      {/* The fast gates re-run on their own after every commit, so say what's
          automatic and which gates the last run covered — the slow build only
          runs on the full check, and when you push. */}
      {hasRuns && (
        <p className="ui-check-report-when">
          {checking ? <AsciiSpinner size={10} /> : <Radio size={12} />}
          Live · re-checks itself after every commit.
          {mode === "full"
            ? " This run included the build."
            : " The build runs on the full check, and when you push."}
        </p>
      )}
    </>
  );
}

function PipelineSection({
  run,
  expanded,
  onToggle,
}: {
  run: CiPipelineRun;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="ui-check-runs ui-check-box">
      {run.steps.map((step, i) => {
        const id = `${run.pipeline}:${i}`;
        return (
          <CheckRow
            key={id}
            step={step}
            open={expanded.has(id)}
            onToggle={() => onToggle(id)}
          />
        );
      })}
    </div>
  );
}

function CheckRow({
  step,
  open,
  onToggle,
}: {
  step: CiStepResult;
  open: boolean;
  onToggle: () => void;
}) {
  const presentation = STATUS[step.status];
  const Icon = presentation.icon;
  const hasDetail = Boolean(step.detail);
  const advisory = !step.blocking && (step.status === "fail" || step.status === "timeout");
  const meta = [
    step.status === "pass" ? null : presentation.label,
    advisory ? "won’t block" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Fragment>
      <div data-status={presentation.status} title={presentation.hint}>
        <Icon size={14} />
        <span>
          {step.name}
          {step.status !== "pass" && step.summary && <small>{step.summary}</small>}
          {meta && <small>{meta}</small>}
        </span>
        {hasDetail && (
          <Button size="xs" variant="ghost" aria-expanded={open} onClick={onToggle}>
            {open ? "Hide" : "Details"}
          </Button>
        )}
      </div>
      {open && hasDetail && (
        <ul className="ui-check-box-rows">
          <li>{step.detail}</li>
        </ul>
      )}
    </Fragment>
  );
}

function CloudAffordance({
  exporting,
  exportedPath,
  onExport,
}: {
  exporting: boolean;
  exportedPath: string | null;
  onExport: () => void;
}) {
  return (
    <section className="ui-checks-cloud">
      <div className="ui-log-note-files-head">
        <span>Run these on every pull request</span>
      </div>
      <p>
        Aura can write a GitHub workflow so the exact same checks run
        automatically whenever you open a pull request.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onExport} disabled={exporting}>
        {exporting ? "Writing…" : "Set up cloud checks"}
      </Button>
      {exportedPath && (
        <p data-tone="good">
          Wrote {exportedPath}. Commit and push it to turn on cloud checks.
        </p>
      )}
    </section>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Fold every step of every pipeline run into the three counts the header
 *  reports. A step is one of four things (`CiStatus`) and all four have to land
 *  somewhere: counting only pass and fail/timeout left `skip` invisible, so a
 *  run where two checks passed and six were skipped read "all 2 passed. Ready
 *  to ship." — a green all-clear over checks that never ran. */
export function summarize(runs: CiPipelineRun[]): {
  passed: number;
  needsLook: number;
  skipped: number;
  headline: string;
} {
  let passed = 0;
  let needsLook = 0;
  let skipped = 0;
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.status === "pass") passed += 1;
      else if (step.status === "fail" || step.status === "timeout") needsLook += 1;
      else skipped += 1;
    }
  }
  // Prefer the engine's own headline when there's exactly one pipeline run —
  // it's already plain-language and computed there.
  const clean =
    needsLook === 0 && skipped === 0
      ? `Your checks ran. All ${passed} passed. Ready to ship.`
      : // Nothing failed, but "ready to ship" is a claim about checks that
        // didn't happen. Say what did.
        needsLook === 0
        ? `Your checks ran. ${passed} passed, ${skipped} skipped. Nothing failed, but not everything ran.`
        : `Your checks ran. ${passed} passed, ${needsLook} ${
            needsLook === 1 ? "needs" : "need"
          } a look${skipped > 0 ? `, ${skipped} skipped` : ""}.`;
  const headline = runs.length === 1 ? runs[0].headline : clean;
  return { passed, needsLook, skipped, headline };
}

function relativeTime(ts: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAge(ts);
}

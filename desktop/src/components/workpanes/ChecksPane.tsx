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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { Button } from "../ui/button";
import {
  api,
  type CiPipelineRun,
  type CiStatus,
  type CiStepResult,
  type CiTrigger,
} from "../../lib/api";

type ChecksPaneProps = {
  repoRoot: string;
  onClose: () => void;
};

// Verdict → presentation. Arctic-blue is reserved for primary affordances, so
// status uses the status palette only: teal = pass, amber = needs-a-look /
// timeout, red = failed, muted = skipped.
const STATUS: Record<
  CiStatus,
  { label: string; glyph: string; color: string; hint: string }
> = {
  pass: {
    label: "Passed",
    glyph: "✓",
    color: "var(--color-accent-green)",
    hint: "This check is clean.",
  },
  fail: {
    label: "Needs a look",
    glyph: "✗",
    color: "var(--color-red)",
    hint: "This check found something.",
  },
  timeout: {
    label: "Took too long",
    glyph: "⧖",
    color: "var(--color-amber)",
    hint: "This check ran out of time and was stopped.",
  },
  skip: {
    label: "Not applicable",
    glyph: "·",
    color: "var(--color-text-4)",
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

type Cached = { runs: CiPipelineRun[]; ranAt: number; mode?: RunMode };

function cacheKey(repoRoot: string): string {
  return `aura.checks.${repoRoot}`;
}

function loadCached(repoRoot: string): Cached | null {
  try {
    const raw = localStorage.getItem(cacheKey(repoRoot));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    if (parsed && Array.isArray(parsed.runs) && typeof parsed.ranAt === "number") {
      return parsed;
    }
  } catch {
    /* private mode / parse error — treat as no cache */
  }
  return null;
}

function saveCached(repoRoot: string, value: Cached): void {
  try {
    localStorage.setItem(cacheKey(repoRoot), JSON.stringify(value));
  } catch {
    /* best-effort */
  }
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

  const { passed, needsLook, headline } = useMemo(
    () => summarize(runs),
    [runs],
  );

  return (
    <FullscreenOverlay
      onClose={onClose}
      actions={
        <div className="flex items-center gap-2.5">
          {quickBusy && !fullBusy && (
            <span className="text-xs text-text-4">Checking…</span>
          )}
          <Button
            type="button"
            variant="accentSoft"
            size="sm"
            onClick={() => void runChecks("full")}
            disabled={fullBusy}
            title="Run every check, including the real build — the full pre-ship gate."
          >
            {fullBusy ? "Building…" : "Run full check"}
          </Button>
        </div>
      }
      footer={
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="h-full w-full flex flex-col bg-bg-0">
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-[720px] mx-auto px-4 py-5">
            <ChecksHeadline
              headline={headline}
              passed={passed}
              needsLook={needsLook}
              ranAt={ranAt}
              mode={lastMode}
              checking={quickBusy && !fullBusy}
              hasRuns={runs.length > 0}
              failedToRun={runs.length === 0 && ranEmpty}
            />

            {error && (
              <div
                className="mt-3 rounded-md px-3 py-2 text-sm"
                style={{
                  color: "var(--color-red)",
                  background: "color-mix(in srgb, var(--color-red) 12%, transparent)",
                }}
              >
                {error}
              </div>
            )}

            {runs.length === 0 && ranEmpty ? (
              <CouldNotRun
                running={quickBusy}
                onRun={() => void runChecks("quick")}
              />
            ) : runs.length === 0 ? (
              <EmptyChecks
                running={quickBusy || fullBusy}
                onRun={() => void runChecks("full")}
              />
            ) : (
              <ul className="mt-4 space-y-4">
                {runs.map((pipelineRun) => (
                  <PipelineSection
                    key={pipelineRun.pipeline}
                    run={pipelineRun}
                    expanded={expanded}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            )}

            {/* A re-run came back empty while an earlier good result is still
                shown — note it inline so the stale rows aren't read as fresh. */}
            {runs.length > 0 && ranEmpty && (
              <div
                className="mt-3 rounded-md px-3 py-2 text-sm"
                style={{
                  color: "var(--color-amber)",
                  background:
                    "color-mix(in srgb, var(--color-amber) 12%, transparent)",
                }}
              >
                Couldn't run your checks just now — showing the last result.
                Try again.
              </div>
            )}

            <CloudAffordance
              exporting={exporting}
              exportedPath={exportedPath}
              onExport={() => void exportToCloud()}
            />
          </div>
        </div>
      </div>
    </FullscreenOverlay>
  );
}

function ChecksHeadline({
  headline,
  passed,
  needsLook,
  ranAt,
  mode,
  checking,
  hasRuns,
  failedToRun,
}: {
  headline: string;
  passed: number;
  needsLook: number;
  ranAt: number | null;
  mode: RunMode | null;
  checking: boolean;
  hasRuns: boolean;
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
    <div>
      <h2 className="text-base font-semibold text-text-0">{title}</h2>
      {hasRuns && (
        <p className="mt-1 text-sm text-text-3">
          <span style={{ color: "var(--color-accent-green)" }}>{passed} passed</span>
          {needsLook > 0 && (
            <>
              {" · "}
              <span style={{ color: "var(--color-red)" }}>
                {needsLook} {needsLook === 1 ? "needs" : "need"} a look
              </span>
            </>
          )}
          {ranAt && <span className="text-text-4"> · {relativeTime(ranAt)}</span>}
        </p>
      )}
      {/* Live + scope note: the fast gates re-run on their own after every
          commit, so say what's auto and which gates the last run actually
          covered — the slow build only runs on the full check / on push. */}
      {hasRuns && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-text-4">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-accent-green)" }}
            aria-hidden
          />
          Live · re-checks itself after every commit.
          {mode === "full"
            ? " This run included the build."
            : " The build runs on the full check, and when you push."}
          {checking && " · checking…"}
        </p>
      )}
    </div>
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
    <li>
      <ul className="space-y-1.5">
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
      </ul>
    </li>
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
  const hasDetail = Boolean(step.detail) || step.status !== "pass";
  const advisory = !step.blocking && (step.status === "fail" || step.status === "timeout");

  return (
    <li className="rounded-md border border-border bg-bg-1">
      <button
        type="button"
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
        onClick={hasDetail ? onToggle : undefined}
        aria-expanded={open}
      >
        <span
          className="text-base leading-none w-4 text-center"
          style={{ color: presentation.color }}
          aria-hidden
        >
          {presentation.glyph}
        </span>
        <span className="flex-1 min-w-0">
          <span className="text-sm text-text-0">{step.name}</span>
          {advisory && (
            <span className="ml-2 text-[11px] uppercase tracking-wide text-text-4">
              won't block
            </span>
          )}
          {step.status !== "pass" && (
            <span className="block text-xs text-text-3 mt-0.5 truncate">
              {step.summary}
            </span>
          )}
        </span>
        {hasDetail && (
          <span className="text-text-4 text-xs" aria-hidden>
            {open ? "Hide" : "Details"}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0">
          <p className="text-xs text-text-3 mb-1.5">{step.summary}</p>
          {step.detail && (
            <pre className="text-[11px] leading-relaxed text-text-4 whitespace-pre-wrap font-mono bg-bg-0 rounded px-2.5 py-2 overflow-x-auto">
              {step.detail}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

function EmptyChecks({
  running,
  onRun,
}: {
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="mt-8 text-center">
      <p className="text-sm text-text-3">
        Aura watches your work for ship-readiness — no leaked secrets, no
        half-finished pieces, and the project still builds. The first three
        re-check on their own after every commit; run the full check to include
        the build.
      </p>
      <Button
        type="button"
        variant="accentSoft"
        size="sm"
        className="mt-4"
        onClick={onRun}
        disabled={running}
      >
        {running ? "Checking…" : "Run full check"}
      </Button>
    </div>
  );
}

function CouldNotRun({
  running,
  onRun,
}: {
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="mt-8 text-center">
      <p
        className="text-sm"
        style={{ color: "var(--color-red)" }}
      >
        Couldn't run your checks — try again.
      </p>
      <p className="mt-1.5 text-xs text-text-3">
        Nothing came back from the checks just now. This usually clears up on a
        retry. If it keeps happening, make sure this folder is opened as a
        project and your Aura is up to date.
      </p>
      <Button
        type="button"
        variant="accentSoft"
        size="sm"
        className="mt-4"
        onClick={onRun}
        disabled={running}
      >
        {running ? "Running…" : "Try again"}
      </Button>
    </div>
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
    <div className="mt-8 pt-5 border-t border-border">
      <p className="text-sm text-text-2 font-medium">
        Run these in the cloud on every PR
      </p>
      <p className="mt-1 text-xs text-text-3">
        Aura can write a GitHub workflow so the exact same checks run
        automatically whenever you open a pull request.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={onExport}
        disabled={exporting}
      >
        {exporting ? "Writing…" : "Set up cloud checks"}
      </Button>
      {exportedPath && (
        <p className="mt-2 text-xs" style={{ color: "var(--color-accent-green)" }}>
          Wrote {exportedPath} — commit and push it to turn on cloud checks.
        </p>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function summarize(runs: CiPipelineRun[]): {
  passed: number;
  needsLook: number;
  headline: string;
} {
  let passed = 0;
  let needsLook = 0;
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.status === "pass") passed += 1;
      else if (step.status === "fail" || step.status === "timeout") needsLook += 1;
    }
  }
  // Prefer the engine's own headline when there's exactly one pipeline run —
  // it's already plain-language and computed there.
  const headline =
    runs.length === 1
      ? runs[0].headline
      : needsLook === 0
        ? `Your checks ran — all ${passed} passed. Ready to ship.`
        : `Your checks ran — ${passed} passed, ${needsLook} ${
            needsLook === 1 ? "needs" : "need"
          } a look.`;
  return { passed, needsLook, headline };
}

function relativeTime(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

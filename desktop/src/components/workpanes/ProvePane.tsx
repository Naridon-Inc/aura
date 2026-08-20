// Goals — does the codebase actually wire a behavior?
//
// State a requirement ("users can sign in via Google") and Aura walks
// the AST graph to verify which logic nodes wire it and which are
// missing. Calm, verdict-first: one plain answer (Verified / Partly
// wired / Not wired), then the handful of things still missing (≤5,
// the rest one click away), then the full check list behind a
// disclosure. The dense wiring-lattice SVG is gone — the gaps list is
// the same information a nervous reviewer can actually read.
//
// Backend: shells `aura prove --goal <text>`. The CLI doesn't have a
// --json mode yet, so we parse its human output (one line per check,
// "✓ Class 'X' …" / "✗ Class 'Y' is missing from the AST!"). Robust
// enough for the V1 — when --json lands we swap the parser.
//
// Persistence: per-repo last goal in localStorage so reopen restores
// the iteration the user was working on. Every verify is also saved as a
// durable GoalRecord (goalStore) under an "adhoc" run key, so a goal stated
// here becomes associable with a task or a run later — the saved-goals strip
// re-opens any of them, and the verdict shows wherever that goal is linked.

import { useEffect, useRef, useState } from "react";
import { BadgeCheck } from "lucide-react";
import { Button } from "../ui/button";
import { EmptyState, ErrorNote, LoadingState } from "../ui/state";
import { GOALS_V2 } from "../../lib/featureFlags";
import { GoalsPane } from "./GoalsPane";
import { VERDICT } from "../../lib/goalVerdict";
import {
  gapKind,
  gaps,
  runProve,
  verdictOf,
  type Check,
  type ProveResult,
  type ProveTone,
} from "../../lib/prove";
import {
  recordRun,
  rollup,
  upsertGoalByText,
  useGoals,
  verdictFromProve,
  type GoalRecord,
} from "../../lib/goalStore";

const goalKeyFor = (root: string) => `aura.prove.goal.${root}`;
const MAX_GAP_BULLETS = 5;

// The legacy body below is behind GOALS_V2 and reads the same table as the
// surface that replaced it, so flipping the flag back can't bring the old
// vocabulary with it.
const VERDICT_TONE = VERDICT;

type Props = { repoRoot: string; onClose: () => void };

export function ProvePane({ repoRoot, onClose }: Props) {
  // GOALS_V2: the list-first "your asks, and whether they're really done"
  // surface replaces this input-first pane. Legacy body stays below, reachable
  // by flipping the flag off.
  if (GOALS_V2) {
    return <GoalsPane repoRoot={repoRoot} onClose={onClose} />;
  }
  return <ProvePaneLegacy repoRoot={repoRoot} onClose={onClose} />;
}

function ProvePaneLegacy({ repoRoot, onClose }: Props) {
  const [goal, setGoal] = useState<string>(
    () => localStorage.getItem(goalKeyFor(repoRoot)) ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProveResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    localStorage.setItem(goalKeyFor(repoRoot), goal);
  }, [repoRoot, goal]);

  // Reload persisted goal when the workspace switches without unmounting
  // the pane (it's a singleton; same instance survives root changes).
  useEffect(() => {
    setGoal(localStorage.getItem(goalKeyFor(repoRoot)) ?? "");
    setResult(null);
    setErr(null);
  }, [repoRoot]);

  async function run(override?: string) {
    const trimmed = (override ?? goal).trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const parsed = await runProve(repoRoot, trimmed);
      setResult(parsed);
      // Save the goal + this verdict durably, so it becomes a record the user
      // can later link to a task or that a run can prove. Keyed "adhoc" — the
      // workbench check, distinct from a specific run.
      const rec = upsertGoalByText(repoRoot, trimmed);
      const { verdict, ok, total } = verdictFromProve(parsed);
      recordRun(repoRoot, rec.id, {
        runKey: "adhoc",
        label: "Ad-hoc check",
        verdict,
        ok,
        total,
        at: Date.now(),
      });
      // "Try describing it differently" is only fair advice when Aura actually
      // read the code and couldn't decompose the sentence. When the check never
      // ran, the hero says why — telling someone to reword a request nobody
      // read sends them round a loop they can't get out of.
      if (parsed.ran && parsed.checks.length === 0 && !parsed.summary) {
        setErr("Nothing to check here yet. Try describing it differently. What should work when it's done?");
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg-0">
      <Header onClose={onClose} />
      <GoalEditor
        ref={taRef}
        value={goal}
        onChange={setGoal}
        onKeyDown={onKeyDown}
        disabled={busy}
        onRun={() => void run()}
        canRun={goal.trim().length > 0 && !busy}
        busy={busy}
      />
      <SavedGoals
        repoRoot={repoRoot}
        activeText={goal}
        onPick={(text) => {
          setGoal(text);
          void run(text);
        }}
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {result ? (
          <Results result={result} />
        ) : busy ? (
          <Loading />
        ) : err ? (
          <ErrorView message={err} />
        ) : (
          <EmptyHint />
        )}
      </div>
    </div>
  );
}

// Same as the list-first GoalsPane header: the glyph and the word "Goals" are
// already on the tab and on the sidebar row that opened it, so the question is
// all that's left — and the question is the reason anyone comes here.
function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="h-9 px-3 flex items-center gap-2 border-b border-line-soft bg-bg-1/40 shrink-0">
      <span className="text-text-4 text-xs">
        did the AI actually build what you asked for?
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        title="Close (the goal stays saved)"
        className="ml-auto text-text-3 hover:text-text-1 text-xs"
      >
        ✕
      </Button>
    </div>
  );
}

const GoalEditor = (() => {
  // forwardRef-shaped factory (avoids importing React.forwardRef noise here).
  return function GoalEditorImpl({
    value,
    onChange,
    onKeyDown,
    disabled,
    onRun,
    canRun,
    busy,
    ref,
  }: {
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    disabled: boolean;
    onRun: () => void;
    canRun: boolean;
    busy: boolean;
    ref?: React.RefObject<HTMLTextAreaElement | null>;
  }) {
    return (
      <div className="border-b border-line-soft bg-bg-1/30 px-4 py-3 shrink-0">
        <div className="max-w-[640px] mx-auto">
          <div className="section-label mb-1.5">Goal</div>
          <div className="flex items-start gap-2">
            <textarea
              ref={ref ?? undefined}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={disabled}
              rows={2}
              placeholder='e.g. "Users can authenticate via OAuth"'
              className="flex-1 bg-bg-1 border border-line rounded px-2.5 py-1.5 text-text-1 text-base resize-y outline-none focus:border-text-4 placeholder:text-text-5"
            />
            <Button variant="default" size="xs" onClick={onRun} disabled={!canRun} title="⌘↩ to run">
              {busy ? "Verifying…" : "Verify"}
            </Button>
          </div>
        </div>
      </div>
    );
  };
})();

// Saved goals — every requirement ever stated here, with its latest verdict.
// Click one to reload + re-verify it. These are the SAME records a task links
// or a run proves, so a goal set here can be picked up and associated later.
function SavedGoals({
  repoRoot,
  activeText,
  onPick,
}: {
  repoRoot: string;
  activeText: string;
  onPick: (text: string) => void;
}) {
  const goals = useGoals(repoRoot);
  if (goals.length === 0) return null;
  const active = activeText.trim().toLowerCase();
  // Most-recently-touched first; cap the strip so it stays a strip.
  const sorted = [...goals].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  return (
    <div className="border-b border-line-soft bg-bg-1/20 px-4 py-2 shrink-0">
      <div className="max-w-[640px] mx-auto flex flex-wrap items-center gap-1.5">
        <span className="section-label mr-0.5">Saved</span>
        {sorted.map((g) => (
          <SavedGoalChip
            key={g.id}
            goal={g}
            active={g.text.trim().toLowerCase() === active}
            onPick={() => onPick(g.text)}
          />
        ))}
      </div>
    </div>
  );
}

function SavedGoalChip({
  goal,
  active,
  onPick,
}: {
  goal: GoalRecord;
  active: boolean;
  onPick: () => void;
}) {
  const r = rollup(goal);
  const tone = VERDICT_TONE[r.verdict];
  const linked = goal.taskSeq != null && goal.taskSeq > 0;
  return (
    <button
      type="button"
      onClick={onPick}
      title={`${tone.label}${r.total > 0 ? ` · ${r.ok}/${r.total} in place` : ""}${
        linked ? ` · AURA-${goal.taskSeq}` : ""
      }`}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
        active
          ? "border-line text-text-1 bg-bg-2"
          : "border-line-soft text-text-3 hover:text-text-1 hover:bg-state-hover"
      }`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tone.color }} />
      <span className="max-w-[180px] truncate">{goal.text}</span>
      {linked ? (
        <span className="font-mono text-2xs text-text-4">AURA-{goal.taskSeq}</span>
      ) : null}
    </button>
  );
}

function Results({ result }: { result: ProveResult }) {
  // One fold decides the verdict, and it's the same one the Goals surface and
  // the durable record read. The tone used to be computed here from counts the
  // parser had inflated — see `proveReport.ts`.
  const { tone, ok, total } = verdictOf(result);
  const missing = gaps(result);
  return (
    <div className="max-w-[640px] mx-auto px-4 py-5 space-y-5">
      <VerdictHero
        tone={tone}
        ok={ok}
        total={total}
        summary={result.summary}
        blocked={result.blocked}
      />
      {missing.length > 0 && <Gaps missing={missing} />}
      <AllChecks checks={result.checks} raw={result.raw} />
    </div>
  );
}

// The lead. One word a reviewer can trust, toned green / amber / red — plus
// the fourth state that was missing: the check didn't run. That one is not a
// shade of failure, and saying "not reached" about code nobody read is an
// accusation Aura hasn't earned.
function VerdictHero({
  tone,
  ok,
  total,
  summary,
  blocked,
}: {
  tone: ProveTone;
  ok: number;
  total: number;
  summary: string;
  /** Why the check couldn't run, when it couldn't. */
  blocked: string | null;
}) {
  const t =
    tone === "ok"
      ? {
          glyph: "✓",
          // green is a legitimate status accent for a genuine "reached" verdict —
          // applied as text/glyph only, never as a full card fill.
          color: "var(--color-accent-green)",
          label: "Reached",
          msg: "Everything this needs is in place. The AI actually built it.",
        }
      : tone === "partial"
        ? {
            glyph: "–",
            color: "var(--color-text-1)",
            label: "Partly there",
            msg: "Some of it is built. The rest is still missing.",
          }
        : tone === "unknown"
          ? {
              glyph: "·",
              color: "var(--color-text-4)",
              label: "Couldn’t check",
              msg:
                blocked ??
                "Aura couldn’t check this one, so this says nothing about whether it’s built.",
            }
          : {
              glyph: "✗",
              color: "var(--color-red)",
              label: "Not reached",
              msg: "None of what this needs is working yet. Parts may be built, but nothing's wired up.",
            };
  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="text-base leading-none flex-shrink-0" style={{ color: t.color }}>
          {t.glyph}
        </span>
        <span className="text-base font-semibold text-text-1">{t.label}</span>
        {total > 0 && (
          <span className="ml-auto text-xs text-text-4 tabular-nums">
            {ok}/{total} in place
          </span>
        )}
      </div>
      <div className="text-base text-text-2 mt-1.5 leading-snug">{t.msg}</div>
      {summary && <div className="text-xs text-text-4 mt-1 font-mono truncate">{summary}</div>}
    </div>
  );
}

// What's still in the way — the handful that matters, not the whole graph.
// Not all of it is "missing": a stub is built and empty, and an unwired symbol
// is built and never called. Both used to render as a red ✗ labelled missing,
// which is the one description that sends someone looking in the wrong place.
function Gaps({ missing }: { missing: Check[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? missing : missing.slice(0, MAX_GAP_BULLETS);
  const rest = missing.length - shown.length;
  return (
    <section>
      <div className="section-label">
        What&apos;s in the way
        <span className="ml-1.5 text-text-4 tabular-nums normal-case tracking-normal">
          {missing.length} to go
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {shown.map((c, i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 text-sm px-2.5 py-1.5 rounded border border-line-soft bg-bg-1"
            title={c.line}
          >
            <span
              className={`shrink-0 mt-px text-xs ${c.stub ? "text-amber" : "text-red"}`}
            >
              {c.stub ? "⚠" : "✗"}
            </span>
            <span className="flex-1 min-w-0 truncate">
              {c.kind && c.identifier ? (
                <>
                  <span className="text-text-4">{c.kind}</span>{" "}
                  <span className="text-text-1 font-mono">{c.identifier}</span>
                </>
              ) : (
                <span className="text-text-1 font-mono">{c.line}</span>
              )}
            </span>
            <span className="shrink-0 text-2xs text-text-4">{gapKind(c)}</span>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 text-xs text-text-3 hover:text-text-1 transition-colors"
        >
          + {rest} more missing
        </button>
      )}
    </section>
  );
}

// Every check + the raw CLI output, one click away.
function AllChecks({ checks, raw }: { checks: Check[]; raw: string }) {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  if (checks.length === 0) return null;
  return (
    <section className="border-t border-line-soft pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-text-3 hover:text-text-1 transition-colors"
      >
        <Caret open={open} />
        <span>Show all checks ({checks.length})</span>
      </button>
      {open && (
        <div className="mt-2.5">
          <ul className="space-y-0.5">
            {checks.map((c, i) => (
              <li
                key={i}
                className={`flex items-start gap-2 px-2 py-1 rounded text-sm font-mono ${
                  c.ok ? "text-text-1" : "text-text-2"
                } ${i % 2 === 0 ? "bg-bg-1/30" : ""}`}
              >
                <span
                  className={`shrink-0 mt-0.5 text-xs ${
                    c.ok ? "text-green" : c.stub ? "text-amber" : "text-red"
                  }`}
                >
                  {c.ok ? "✓" : c.stub ? "⚠" : "✗"}
                </span>
                <span className="flex-1 truncate" title={c.line}>
                  {c.kind && c.identifier ? (
                    <>
                      <span className="text-text-4">{c.kind}</span>{" "}
                      <span className="text-text-1">{c.identifier}</span>{" "}
                      <span className="text-text-4">
                        {c.ok ? "in place" : gapKind(c)}
                      </span>
                    </>
                  ) : (
                    c.line
                  )}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="mt-3 text-text-4 hover:text-text-2 text-xs"
          >
            {showRaw ? "▾ raw output" : "▸ raw output"}
          </button>
          {showRaw && (
            <pre className="mt-1.5 bg-bg-1 border border-line rounded p-2 text-xs text-text-3 font-mono overflow-auto max-h-64 whitespace-pre-wrap">
              {raw}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Loading() {
  return <LoadingState label="Checking what’s actually built…" />;
}

function ErrorView({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-[640px] px-4 py-4">
      <ErrorNote className="whitespace-pre-wrap break-words font-mono">
        {message}
      </ErrorNote>
    </div>
  );
}

function EmptyHint() {
  return (
    <EmptyState
      icon={BadgeCheck}
      title="Ask whether something really works"
      body={
        <>
          Describe it the way you’d say it out loud. “users can sign in with
          Google”, “orders send a confirmation email”, “every change is written
          down”, and Aura goes and checks whether the AI actually built it,
          then shows you exactly what’s still missing. It’s how you catch work
          that was left half-finished.
        </>
      }
    />
  );
}


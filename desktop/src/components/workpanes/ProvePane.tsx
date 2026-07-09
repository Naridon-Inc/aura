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
import { Button } from "../ui/button";
import { GOALS_V2 } from "../../lib/featureFlags";
import { GoalsPane } from "./GoalsPane";
import { runProve, type Check, type ProveResult } from "../../lib/prove";
import {
  recordRun,
  rollup,
  upsertGoalByText,
  useGoals,
  verdictFromProve,
  type GoalRecord,
  type GoalVerdict,
} from "../../lib/goalStore";

const goalKeyFor = (root: string) => `aura.prove.goal.${root}`;
const MAX_GAP_BULLETS = 5;

const VERDICT_TONE: Record<GoalVerdict, { label: string; color: string }> = {
  verified: { label: "Reached", color: "var(--color-accent-green)" },
  partial: { label: "Partly there", color: "var(--color-amber)" },
  not_wired: { label: "Not reached", color: "var(--color-red)" },
  unknown: { label: "Not checked", color: "var(--color-text-4)" },
};

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
      if (parsed.checks.length === 0 && !parsed.summary) {
        setErr("Nothing to check here yet. Try describing it differently — what should work when it's done?");
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

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="h-9 px-3 flex items-center gap-2 border-b border-line-soft bg-bg-1/40 shrink-0">
      <ProveGlyph />
      <span className="text-text-1 text-[12px] font-medium">Goals</span>
      <span className="text-text-4 text-[10.5px]">
        did the AI actually build what you asked for?
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        title="Close (the goal stays saved)"
        className="ml-auto text-text-3 hover:text-text-1 text-[11px]"
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
          <div className="text-text-3 text-[10px] uppercase tracking-wider mb-1.5">Goal</div>
          <div className="flex items-start gap-2">
            <textarea
              ref={ref ?? undefined}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={disabled}
              rows={2}
              placeholder='e.g. "Users can authenticate via OAuth"'
              className="flex-1 bg-bg-1 border border-line rounded px-2.5 py-1.5 text-text-1 text-[12.5px] resize-y outline-none focus:border-text-4 placeholder:text-text-5"
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
        <span className="text-[10px] uppercase tracking-wider text-text-4 mr-0.5">Saved</span>
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
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-line text-text-1 bg-bg-2"
          : "border-line-soft text-text-3 hover:text-text-1 hover:bg-bg-2/60"
      }`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tone.color }} />
      <span className="max-w-[180px] truncate">{goal.text}</span>
      {linked ? (
        <span className="font-mono text-[9px] text-text-4">AURA-{goal.taskSeq}</span>
      ) : null}
    </button>
  );
}

function Results({ result }: { result: ProveResult }) {
  const ok = result.checks.filter((c) => c.ok).length;
  const total = result.checks.length;
  const missing = result.checks.filter((c) => !c.ok);
  const tone =
    result.proven || (total > 0 && ok === total) ? "ok" : ok === 0 ? "fail" : "partial";
  return (
    <div className="max-w-[640px] mx-auto px-4 py-5 space-y-5">
      <VerdictHero tone={tone} ok={ok} total={total} summary={result.summary} />
      {missing.length > 0 && <Gaps missing={missing} />}
      <AllChecks checks={result.checks} raw={result.raw} />
    </div>
  );
}

// The lead. One word a reviewer can trust, toned green / amber / red.
function VerdictHero({
  tone,
  ok,
  total,
  summary,
}: {
  tone: "ok" | "partial" | "fail";
  ok: number;
  total: number;
  summary: string;
}) {
  const t =
    tone === "ok"
      ? {
          glyph: "✓",
          // green is a legitimate status accent for a genuine "reached" verdict —
          // applied as text/glyph only, never as a full card fill.
          color: "var(--color-accent-green)",
          label: "Reached",
          msg: "Everything this needs is in place — the AI actually built it.",
        }
      : tone === "partial"
        ? {
            glyph: "–",
            color: "var(--color-text-1)",
            label: "Partly there",
            msg: "Some of it is built — the rest is still missing.",
          }
        : {
            glyph: "✗",
            color: "var(--color-red)",
            label: "Not reached",
            msg:
              total === 0
                ? "Nothing to check yet. Describe it in plain words — what should work when this is done?"
                : "None of what this needs is built yet.",
          };
  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="text-[13px] leading-none flex-shrink-0" style={{ color: t.color }}>
          {t.glyph}
        </span>
        <span className="text-[13px] font-semibold text-text-1">{t.label}</span>
        {total > 0 && (
          <span className="ml-auto text-[10.5px] text-text-4 tabular-nums">
            {ok}/{total} in place
          </span>
        )}
      </div>
      <div className="text-[12.5px] text-text-2 mt-1.5 leading-snug">{t.msg}</div>
      {summary && <div className="text-[10.5px] text-text-4 mt-1 font-mono truncate">{summary}</div>}
    </div>
  );
}

// What's still missing — the handful that matters, not the whole graph.
function Gaps({ missing }: { missing: Check[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? missing : missing.slice(0, MAX_GAP_BULLETS);
  const rest = missing.length - shown.length;
  return (
    <section>
      <div className="text-[10.5px] uppercase tracking-wider text-text-4 font-medium">
        What&apos;s missing
        <span className="ml-1.5 text-text-4 tabular-nums normal-case tracking-normal">
          {missing.length} still missing
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {shown.map((c, i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 text-[12px] px-2.5 py-1.5 rounded border border-line-soft bg-bg-1"
            title={c.line}
          >
            <span className="shrink-0 mt-px text-red text-[11px]">✗</span>
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
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 text-[11px] text-text-3 hover:text-text-1 transition-colors"
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
        className="flex items-center gap-2 text-[11px] text-text-3 hover:text-text-1 transition-colors"
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
                className={`flex items-start gap-2 px-2 py-1 rounded text-[12px] font-mono ${
                  c.ok ? "text-text-1" : "text-text-2"
                } ${i % 2 === 0 ? "bg-bg-1/30" : ""}`}
              >
                <span className={`shrink-0 mt-0.5 text-[11px] ${c.ok ? "text-green" : "text-red"}`}>
                  {c.ok ? "✓" : "✗"}
                </span>
                <span className="flex-1 truncate" title={c.line}>
                  {c.kind && c.identifier ? (
                    <>
                      <span className="text-text-4">{c.kind}</span>{" "}
                      <span className="text-text-1">{c.identifier}</span>{" "}
                      <span className="text-text-4">{c.ok ? "in place" : "missing"}</span>
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
            className="mt-3 text-text-4 hover:text-text-2 text-[10.5px]"
          >
            {showRaw ? "▾ raw output" : "▸ raw output"}
          </button>
          {showRaw && (
            <pre className="mt-1.5 bg-bg-1 border border-line rounded p-2 text-[10.5px] text-text-3 font-mono overflow-auto max-h-64 whitespace-pre-wrap">
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
  return (
    <div className="text-text-4 text-[12px] py-4 text-center">checking what&apos;s built…</div>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <div className="max-w-[640px] mx-auto px-4 py-4">
      <div className="text-red text-[11.5px] font-mono whitespace-pre-wrap break-words border border-red/40 bg-red/10 rounded p-2.5">
        {message}
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="text-text-4 text-[11.5px] py-10 px-6 text-center max-w-md mx-auto leading-relaxed">
      Describe something that should work — &quot;users can sign in with Google&quot;, &quot;orders
      send a confirmation email&quot;, &quot;every change is written to an audit log&quot; — and Aura
      checks whether the AI actually built it, then shows you exactly what&apos;s still missing.
      Great for catching work the AI left half-finished.
    </div>
  );
}

function ProveGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 8.5l2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


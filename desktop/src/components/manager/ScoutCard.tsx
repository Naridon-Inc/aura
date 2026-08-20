// Aura Scout — pre-build architectural review card.
//
// Renders above the chat thread whenever `session.pending_scout` is
// set. Three rows (Architecture / Security / UX) stream live state
// from `manager-scout-stream:{sid}:{kind}` events; each row expands to
// show structured findings (severity-tagged) and any open questions
// the specialist surfaced. Once Scout finalizes, `pending_scout`
// clears and a `PendingPlan` lands in its place — at which point the
// existing PlanCard renders.
//
// This is a passive surface: we don't drive Scout from the UI. The
// brain's `aura propose-plan` invocation parks on the bridge waiter,
// the backend kicks specialists in parallel, and ScoutCard subscribes
// to the snapshot push (no separate Tauri commands).

import { useEffect, useMemo, useState } from "react";
import {
  type PendingScout,
  type ScoutFinding,
  type ScoutSeverity,
  type SpecialistKind,
  type SpecialistRun,
  type SpecialistStatus,
} from "../../lib/api";
import { listen } from "@tauri-apps/api/event";

const KIND_LABEL: Record<SpecialistKind, string> = {
  architecture: "Architecture",
  security: "Security",
  ux: "UX",
};

const KIND_CHANNEL: Record<SpecialistKind, string> = {
  architecture: "arch",
  security: "security",
  ux: "ux",
};

const SEVERITY_TONE: Record<ScoutSeverity, string> = {
  info: "var(--color-text-3)",
  // A warning IS the amber slot — routing it through the accent made every
  // advisory finding look like a link you could follow.
  warn: "var(--color-amber)",
  block: "var(--color-red)",
};

// A reviewer that didn't finish (timed out / skipped / claude missing) is a
// calm amber state — the build proceeds without it, so it must never read as
// an alarming red failure. Matches the settled SpecialistStatusChip. `running`
// keeps the accent because it is the live rung the eye should land on while
// the review is in flight; `failed` is the thing that wants your attention
// afterwards, so it takes amber and the two stay tellable apart.
const STATUS_DOT: Record<SpecialistStatus, string> = {
  pending: "var(--color-text-3)",
  running: "var(--color-accent)",
  done: "var(--color-accent-green)",
  failed: "var(--color-amber)",
};

export function ScoutCard({
  sessionId,
  scout,
}: {
  sessionId: string;
  scout: PendingScout;
}) {
  // The whole pass collapses to one tool-call row by default; click to
  // expand the per-specialist breakdown + consolidated notes.
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<SpecialistKind, boolean>>({
    architecture: false,
    security: false,
    ux: false,
  });

  // Per-kind live tail of stdout lines — the snapshot push gives us
  // the parsed result, but until the run finishes we want to show the
  // user *something* moving. We tail the last ~6 lines per row.
  const [tails, setTails] = useState<Record<SpecialistKind, string[]>>({
    architecture: [],
    security: [],
    ux: [],
  });

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    (async () => {
      for (const kind of Object.keys(KIND_CHANNEL) as SpecialistKind[]) {
        const channel = `manager-scout-stream:${sessionId}:${KIND_CHANNEL[kind]}`;
        const unsub = await listen<string>(channel, (evt) => {
          const line = evt.payload;
          if (!line) return;
          setTails((prev) => {
            const next = [...prev[kind], line];
            if (next.length > 6) next.splice(0, next.length - 6);
            return { ...prev, [kind]: next };
          });
        });
        unsubs.push(unsub);
      }
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, [sessionId]);

  const overallLabel = useMemo(() => {
    switch (scout.status) {
      case "spawning":
        return "Starting plan review…";
      case "running":
        return "Reviewing the plan…";
      case "awaiting_qa":
        return "Awaiting your answers";
      case "finalizing":
        return "Wrapping up the review…";
      case "done":
        return "Reviewed the plan";
      case "failed":
        return "Plan review skipped";
    }
  }, [scout.status]);

  // Trailing status — a quiet "N reviewers" / "N of M" so the collapsed
  // row says how the pass went without being expanded. Plain language,
  // no "specialists" jargon for the non-engineer audience.
  const reviewerStatus = useMemo(() => {
    const total = scout.specialists.length;
    if (scout.status === "done" || scout.status === "failed") {
      const reviewed = scout.specialists.filter(
        (s) => s.status === "done",
      ).length;
      if (reviewed === 0) return "skipped";
      if (reviewed === total) {
        return `${total} reviewer${total === 1 ? "" : "s"}`;
      }
      return `${reviewed} of ${total} reviewers`;
    }
    const running = scout.specialists.filter(
      (s) => s.status === "running" || s.status === "pending",
    ).length;
    return running > 0 ? `${running} working…` : `${total} reviewers`;
  }, [scout.specialists, scout.status]);

  const running =
    scout.status !== "done" && scout.status !== "failed";

  const toggle = (kind: SpecialistKind) =>
    setExpanded((prev) => ({ ...prev, [kind]: !prev[kind] }));

  return (
    <div className="mt-1 mb-1">
      {/* One compact tool-call row — same flat skeleton as every other tool
          row in the thread (glyph column · verb · count · status · chevron).
          Not a bordered card; the plan review reads as a quiet step. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="aura-tool-row"
        title={open ? "Collapse" : "Expand plan review"}
      >
        <span className="aura-tool-glyph">
          <span
            aria-hidden
            className={`inline-block rounded-full ${running ? "animate-pulse" : ""}`}
            style={{
              width: 6,
              height: 6,
              background: running
                ? "var(--color-accent)"
                : "var(--color-text-4)",
            }}
          />
        </span>
        <span className="aura-tool-chip-verb">{overallLabel}</span>
        <span
          className="aura-tool-chip-subject"
          style={{ color: "var(--color-text-3)" }}
        >
          {reviewerStatus}
        </span>
        <span className="ml-auto shrink-0" style={{ color: "var(--color-text-4)" }}>
          <Chevron dir={open ? "up" : "down"} />
        </span>
      </button>
      {open && (
        <div className="aura-tool-substream">
          {scout.specialists.map((run) => (
            <SpecialistRow
              key={run.kind}
              run={run}
              tail={tails[run.kind]}
              expanded={expanded[run.kind]}
              onToggle={() => toggle(run.kind)}
            />
          ))}
          {scout.consolidated_notes && (
            <div
              className="t-xs mt-1 px-2 py-1.5 rounded"
              style={{
                color: "var(--color-text-2)",
                background: "var(--color-bg-2)",
                whiteSpace: "pre-wrap",
              }}
            >
              {scout.consolidated_notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Tiny inline chevron — own SVG, currentColor, rotates on open. */
function Chevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: dir === "up" ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function SpecialistRow({
  run,
  tail,
  expanded,
  onToggle,
}: {
  run: SpecialistRun;
  tail: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const summary = run.summary?.trim() ?? "";
  const findings = run.findings ?? [];
  const questions = run.questions ?? [];
  const showTail = run.status === "running" && tail.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full py-1.5 flex items-start gap-2.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)] transition-colors"
      >
        <span
          className="mt-1.5 inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: STATUS_DOT[run.status],
            boxShadow:
              run.status === "running"
                ? "0 0 6px color-mix(in srgb, var(--color-accent) 60%, transparent)"
                : "none",
          }}
          aria-hidden
        />
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="t-sm font-medium" style={{ color: "var(--color-text-1)" }}>
              {KIND_LABEL[run.kind]}
            </span>
            {run.status === "failed" ? (
              <span
                className="t-2xs t-ui px-1.5 py-0.5 shrink-0"
                style={{
                  // Matches STATUS_DOT.failed above — the chip and the dot
                  // that labels it must never disagree.
                  color: "var(--color-amber)",
                  border:
                    "1px solid color-mix(in srgb, var(--color-amber) 40%, transparent)",
                  borderRadius: "var(--radius-xs)",
                }}
              >
                Skipped
              </span>
            ) : (
              findings.length > 0 && (
                <span
                  className="section-label shrink-0"
                  style={{
                    color: "var(--color-text-3)",
                    letterSpacing: "var(--letter-spacing-wide)",
                  }}
                >
                  {findings.length} finding{findings.length === 1 ? "" : "s"}
                </span>
              )
            )}
          </div>
          {summary && (
            <span className="t-xs" style={{ color: "var(--color-text-2)" }}>
              {summary}
            </span>
          )}
          {showTail && (
            <div
              className="t-2xs font-mono mt-1 px-2 py-1 rounded"
              style={{
                color: "var(--color-text-3)",
                background: "var(--color-bg-2)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {tail.join("\n")}
            </div>
          )}
        </div>
        <span
          className="t-2xs shrink-0 mt-1"
          style={{ color: "var(--color-text-3)" }}
          aria-hidden
        >
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (findings.length > 0 || questions.length > 0) && (
        <div className="pl-4 pb-2 pt-1 flex flex-col gap-2">
          {findings.map((f, i) => (
            <FindingItem key={i} finding={f} />
          ))}
          {questions.length > 0 && (
            <div className="flex flex-col gap-1 mt-1">
              <div
                className="section-label"
                style={{
                  color: "var(--color-text-3)",
                  letterSpacing: "var(--letter-spacing-wide)",
                }}
              >
                Open questions
              </div>
              {questions.map((q) => (
                <div key={q.id} className="t-xs" style={{ color: "var(--color-text-2)" }}>
                  • {q.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FindingItem({ finding }: { finding: ScoutFinding }) {
  const tone = SEVERITY_TONE[finding.severity];
  return (
    <div
      className="px-2 py-1.5 flex flex-col gap-0.5"
      style={{
        borderLeft: `2px solid ${tone}`,
        background: "var(--color-bg-2)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="section-label"
          style={{ color: tone, letterSpacing: "var(--letter-spacing-wide)" }}
        >
          {finding.severity}
        </span>
        <span className="t-xs font-medium" style={{ color: "var(--color-text-1)" }}>
          {finding.title}
        </span>
      </div>
      {finding.body && (
        <div className="t-xs" style={{ color: "var(--color-text-2)" }}>
          {finding.body}
        </div>
      )}
      {finding.file_refs && finding.file_refs.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {finding.file_refs.map((ref) => (
            <span
              key={ref}
              className="t-2xs font-mono px-1.5 py-0.5 rounded"
              style={{
                color: "var(--color-text-3)",
                background: "var(--color-bg-1)",
                border: "1px solid var(--color-border)",
              }}
            >
              {ref}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

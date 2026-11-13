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

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, CircleX, Info, TriangleAlert } from "lucide-react";
import {
  type PendingScout,
  type ScoutFinding,
  type ScoutSeverity,
  type SpecialistKind,
  type SpecialistRun,
  type SpecialistStatus,
} from "../../lib/api";
import { listen } from "@tauri-apps/api/event";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import "../ui/log-note.css";
import "../ui/scout-card.css";

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

const SEVERITY_TONE: Record<ScoutSeverity, ChipTone> = {
  info: "neutral",
  // A warning IS the amber slot — routing it through the accent made every
  // advisory finding look like a link you could follow.
  warn: "amber",
  block: "red",
};

const SEVERITY_ICON: Record<ScoutSeverity, typeof Info> = {
  info: Info,
  warn: TriangleAlert,
  block: CircleX,
};

// A reviewer that didn't finish (timed out / skipped / claude missing) is a
// calm amber state — the build proceeds without it, so it must never read as
// an alarming red failure. Matches the settled SpecialistStatusChip. `running`
// shows the spinner because it is the live rung the eye should land on while
// the review is in flight; `failed` is the thing that wants your attention
// afterwards, so it takes amber and the two stay tellable apart. Values are
// the shared status dot's states.
const STATUS_DOT: Record<SpecialistStatus, "working" | "review" | undefined> = {
  pending: undefined,
  running: undefined,
  done: "review",
  failed: "working",
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
  const bodyId = useId();
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
    // One compact tool-call row — the shared tool-group disclosure every
    // other tool row in the thread uses. Not a bordered card; the plan
    // review reads as a quiet step.
    <section className="ui-tool-group ui-scout">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ui-tool-group-trigger"
        aria-expanded={open}
        aria-controls={bodyId}
        title={open ? "Collapse" : "Expand plan review"}
      >
        <ChevronRight size={14} className={open ? "ui-chevron-open" : ""} />
        {running && <AsciiSpinner />}
        <span>{overallLabel}</span>
        <span className="ui-tool-group-note">{reviewerStatus}</span>
      </button>
      {open && (
        <div id={bodyId} className="ui-tool-group-content ui-scout-body">
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
            <p className="ui-scout-notes">{scout.consolidated_notes}</p>
          )}
        </div>
      )}
    </section>
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
  const hasDetail = findings.length > 0 || questions.length > 0;

  return (
    <section className="ui-subagent-run ui-scout-run" data-status={run.status}>
      <button type="button" aria-expanded={expanded} onClick={onToggle} title={summary || undefined}>
        <ChevronRight size={14} className={expanded ? "ui-chevron-open" : ""} />
        {run.status === "running" ? (
          <AsciiSpinner />
        ) : (
          <span className="ui-status-dot" data-status={STATUS_DOT[run.status]} aria-hidden />
        )}
        <strong>{KIND_LABEL[run.kind]}</strong>
        <span>{summary}</span>
        {run.status === "failed" ? (
          // Matches STATUS_DOT.failed above — the chip and the dot that
          // label it must never disagree.
          <small>
            <StatusChip tone="amber" dense>
              Skipped
            </StatusChip>
          </small>
        ) : (
          findings.length > 0 && (
            <small>
              {findings.length} finding{findings.length === 1 ? "" : "s"}
            </small>
          )
        )}
      </button>
      {showTail && <pre className="ui-scout-tail">{tail.join("\n")}</pre>}
      {expanded && (summary || hasDetail) && (
        <div className="ui-scout-detail">
          {summary && <p className="ui-scout-summary">{summary}</p>}
          {findings.length > 0 && (
            <div className="ui-check-runs">
              {findings.map((f, i) => (
                <FindingItem key={i} finding={f} />
              ))}
            </div>
          )}
          {questions.length > 0 && (
            <div className="ui-scout-questions">
              <div className="ui-log-note-files-head">
                <span>Open questions</span>
                <span className="ui-log-note-count">{questions.length}</span>
              </div>
              <ul>
                {questions.map((q) => (
                  <li key={q.id}>{q.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FindingItem({ finding }: { finding: ScoutFinding }) {
  const Icon = SEVERITY_ICON[finding.severity];
  return (
    <div data-severity={finding.severity}>
      <Icon size={14} />
      <span>
        {finding.title}
        {finding.body && <small>{finding.body}</small>}
        {finding.file_refs && finding.file_refs.length > 0 && (
          <small data-loc>{finding.file_refs.join(" · ")}</small>
        )}
      </span>
      <StatusChip tone={SEVERITY_TONE[finding.severity]} dense>
        {finding.severity}
      </StatusChip>
    </div>
  );
}

// Workspace setup feed — the Conductor-style "we're getting your new copy
// ready" surface. Shown full-pane the moment you land in a freshly created
// workspace, in place of the empty chat, so a new copy never opens onto a
// blank splash: you watch it come up, then it hands you into the workspace.
//
// Every line is TRUE — each step names real work the launch actually did
// (branching, copying the checkout, starting your agent). The engine does
// all of it in one fast synchronous call, so the store only exposes coarse
// states (creating → spawning → ready); the feed paces the reveal itself
// (a short, readable cadence) and syncs its final "ready" step to the real
// launch outcome. On failure it shows the actual error, never a fake tick.
//
// Plain-language on purpose — a new workspace is the first thing a
// non-engineer meets, so no git/AST vocabulary leaks in here.

import { useEffect, useMemo, useRef, useState } from "react";
import type { InFlightEntry } from "../../lib/workspaceInFlightStore";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Props = {
  entry: InFlightEntry;
  projectName: string;
  /** Called once the workspace is ready and the reveal has played — the
   *  parent dismisses the in-flight entry, which unmounts this feed and
   *  shows the live workspace underneath. */
  onEnter: () => void;
};

// Reveal cadence — fast enough to feel snappy, slow enough to read.
const STEP_MS = 620;
// Beat to hold on "ready" before handing into the workspace.
const HANDOFF_MS = 700;

type StepState = "pending" | "active" | "done";

function labelForAgent(id: string): string {
  switch (id) {
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "kimi":
      return "Kimi";
    case "qwen":
      return "Qwen";
    default:
      return id.charAt(0).toUpperCase() + id.slice(1);
  }
}

/** "origin/main" / "HEAD" / a branch name — trimmed of the noisy `refs/heads/`
 *  prefix and clamped so a long ref doesn't blow the line width. */
function prettyRef(ref: string | undefined): string {
  if (!ref || ref === "HEAD") return "the latest commit";
  const trimmed = ref.replace(/^refs\/(heads|remotes)\//, "");
  return trimmed.length > 32 ? trimmed.slice(0, 31) + "…" : trimmed;
}

export function WorkspaceSetupFeed({ entry, projectName, onEnter }: Props) {
  const agentSummary = useMemo(() => {
    const labels = entry.agents.map(labelForAgent);
    if (labels.length === 0) return "your workspace";
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  }, [entry.agents]);

  const steps = useMemo(
    () => [
      {
        key: "copy",
        label: `New copy of ${projectName}`,
        sub: `Working on “${prettyRef(entry.branch)}”`,
      },
      {
        key: "branch",
        label: `Branched from ${prettyRef(entry.startPoint)}`,
        sub: "so your changes stay separate from everyone else's",
      },
      {
        key: "files",
        label: "Copied your files into the new workspace",
        sub: "a private, full checkout — edit freely",
      },
      {
        key: "agents",
        label: `Starting ${agentSummary}`,
        activeLabel: `Starting ${agentSummary}…`,
        doneLabel: `${agentSummary} ready`,
        // This step doesn't finish on a timer — it waits for the real launch.
        gate: true as const,
      },
    ],
    [projectName, entry.branch, entry.startPoint, agentSummary],
  );

  // How many steps have played their timed reveal. The gated last step is
  // held here until the real status resolves.
  const [revealed, setRevealed] = useState(0);
  const enteredRef = useRef(false);

  const isError = entry.status === "error";
  const isReady = entry.status === "ready";

  // Timed reveal up to (but not through) the gated final step.
  useEffect(() => {
    if (isError) return;
    const gateIndex = steps.findIndex((s) => "gate" in s && s.gate);
    if (revealed >= gateIndex) return;
    const id = setTimeout(() => setRevealed((n) => n + 1), STEP_MS);
    return () => clearTimeout(id);
  }, [revealed, steps, isError]);

  // Once the real launch is ready AND the reveal has reached the gated step,
  // mark it done and hand off into the workspace after a short beat.
  useEffect(() => {
    if (isError || enteredRef.current) return;
    const gateIndex = steps.findIndex((s) => "gate" in s && s.gate);
    if (!(isReady && revealed >= gateIndex)) return;
    enteredRef.current = true;
    setRevealed(steps.length); // gated step flips to done
    const id = setTimeout(onEnter, HANDOFF_MS);
    return () => clearTimeout(id);
  }, [isReady, revealed, steps, isError, onEnter]);

  function stateOf(i: number): StepState {
    if (i < revealed) return "done";
    if (i === revealed) return "active";
    return "pending";
  }

  const gateIndex = steps.findIndex((s) => "gate" in s && s.gate);
  const allDone = revealed >= steps.length;

  return (
    <div className="h-full w-full flex items-center justify-center bg-bg-content px-8">
      <div className="w-full max-w-[440px] flex flex-col">
        {/* Header — Conductor's "you're in a new copy" framing. */}
        <div className="mb-7">
          <div className="text-[11px] uppercase tracking-[0.14em] text-text-4 mb-1.5">
            {isError
              ? "Setup failed"
              : allDone
                ? "Workspace ready"
                : "Setting up your workspace"}
          </div>
          <h1 className="text-[17px] font-medium text-text-1 leading-snug">
            {isError
              ? `Couldn't finish setting up ${projectName}`
              : `You're in a new copy of ${projectName}`}
          </h1>
        </div>

        {isError ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-red/30 bg-red/5 px-3.5 py-3 text-[12px] text-text-2 leading-relaxed">
              {entry.error || "The workspace couldn't be created."}
            </div>
            <button
              type="button"
              onClick={onEnter}
              className="self-start h-8 px-3 rounded-md text-[12px] text-text-2 hover:text-text-1 border border-line-soft hover:bg-bg-2 transition-colors"
            >
              Dismiss
            </button>
          </div>
        ) : (
          <div className="flex flex-col">
            {steps.map((step, i) => {
              const st =
                i === gateIndex && !allDone && stateOf(i) === "active"
                  ? "active"
                  : stateOf(i);
              const isLast = i === steps.length - 1;
              const label =
                st === "active" && "activeLabel" in step && step.activeLabel
                  ? step.activeLabel
                  : st === "done" && "doneLabel" in step && step.doneLabel
                    ? step.doneLabel
                    : step.label;
              return (
                <div key={step.key} className="flex gap-3">
                  {/* Rail: status glyph + connector line. */}
                  <div className="flex flex-col items-center">
                    <StepGlyph state={st} />
                    {!isLast && (
                      <div
                        className={`w-px flex-1 my-1 transition-colors ${
                          st === "done" ? "bg-accent/40" : "bg-line-soft"
                        }`}
                        style={{ minHeight: 18 }}
                      />
                    )}
                  </div>
                  {/* Copy. */}
                  <div className={`pb-3 ${isLast ? "" : ""}`}>
                    <div
                      className={`text-[13px] leading-tight transition-colors ${
                        st === "pending"
                          ? "text-text-4"
                          : st === "active"
                            ? "text-text-1"
                            : "text-text-2"
                      }`}
                    >
                      {label}
                    </div>
                    {"sub" in step && step.sub && st !== "pending" && (
                      <div className="text-[11px] text-text-4 mt-0.5 leading-snug">
                        {step.sub}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StepGlyph({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span
        className="flex items-center justify-center rounded-full bg-accent/15 text-accent"
        style={{ width: 18, height: 18 }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M3.5 8.5l3 3 6-6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        className="flex items-center justify-center"
        style={{ width: 18, height: 18 }}
      >
        <AsciiSpinner className="text-[12px]" />
      </span>
    );
  }
  return (
    <span
      className="flex items-center justify-center"
      style={{ width: 18, height: 18 }}
    >
      <span
        className="rounded-full border border-line"
        style={{ width: 8, height: 8 }}
      />
    </span>
  );
}

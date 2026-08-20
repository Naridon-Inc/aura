// What a paused agent tab shows instead of a terminal.
//
// A tab restored with the workspace has no PTY behind it — Aura deliberately
// doesn't relaunch agent processes you didn't ask for. What filled the pane
// was a 320px card floating dead-centre in ~900×850 of empty ground: a glyph,
// the words "Agent paused", two sentences of policy, and a Start button. It
// told you the tab was asleep and nothing at all about what it was doing when
// it fell asleep — so "Start agent" was a button you pressed to find out which
// conversation you were about to walk back into.
//
// The app already knows. Each tab carries `resumeSessionId`, the agent's own
// transcript id — the exact conversation Start will resume — and
// `agent_history_preroll` reads that transcript off disk without a running
// process. So the pane shows the last exchange: what you asked, what it
// answered, how long ago. Press Start and you continue THAT.
//
// It shows the exchange only when it can read one. No binding, an agent that
// keeps no transcript (anything but Claude and Gemini), or an empty file, and
// the pane says so plainly rather than filling the space with something
// invented.

import { useEffect, useState } from "react";

import { api, type PrerollTurn } from "../../lib/api";
import { relativeAge } from "../../lib/relativeTime";
import { plainPreview } from "../../lib/plainPreview";
import { AgentIcon } from "./AgentIcon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

type Props = {
  agentId?: string;
  /** Display name for the agent ("Claude", "Gemini"). */
  agentLabel?: string;
  repoRoot?: string;
  /** The agent's OWN session id this tab is bound to — the transcript Start
   *  resumes. Absent on a tab that never held a conversation, in which case
   *  there is nothing truthful to preview. */
  resumeSessionId?: string | null;
  /** Total paused agents in the workspace; >1 offers "Start all". */
  dormantCount?: number;
  starting: boolean;
  startingAll: boolean;
  canStart: boolean;
  onStart: () => void;
  onStartAll?: () => void;
};

type Preview =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; shown: PrerollTurn[]; earlier: number; at: number };

export function AgentPausedPane({
  agentId,
  agentLabel,
  repoRoot,
  resumeSessionId,
  dormantCount,
  starting,
  startingAll,
  canStart,
  onStart,
  onStartAll,
}: Props) {
  const preview = useLastExchange(agentId, repoRoot, resumeSessionId);
  const busy = starting || startingAll;

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col"
      style={{ background: "var(--color-bg-content)" }}
    >
      {/* The controls sit in a band at the top, where every other surface in
          the app keeps its actions — not centred in the pane, which is where
          content goes. */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line-soft px-4 py-2.5">
        {agentId && <AgentIcon agentId={agentId} size={16} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-1">
            {agentLabel ? `${agentLabel} is paused` : "Agent paused"}
          </div>
          <div className="truncate text-xs text-text-4">
            It came back with your workspace. Aura never restarts an agent on
            its own.
          </div>
        </div>
        <Button
          variant="accentSoft"
          size="sm"
          onClick={onStart}
          disabled={busy || !canStart}
        >
          {starting ? "Starting…" : "Start agent"}
        </Button>
        {onStartAll && (dormantCount ?? 0) > 1 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onStartAll}
            disabled={busy}
          >
            {startingAll ? "Starting…" : `Start all (${dormantCount})`}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-6 py-6">
          {preview.state === "loading" && (
            <div className="flex items-center gap-2 text-xs text-text-4">
              <AsciiSpinner />
              Reading where you left off…
            </div>
          )}

          {(preview.state === "empty" || preview.state === "idle") && (
            // No transcript to read — say that, rather than leaving the reader
            // to guess whether it's still loading.
            <div className="text-sm leading-relaxed text-text-3">
              This tab hasn't held a conversation yet, so there's nothing to
              pick up. Starting it opens a fresh one.
            </div>
          )}

          {preview.state === "ready" && (
            <>
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <div className="section-label">
                  Where you left off
                </div>
                {preview.at > 0 && (
                  <div className="shrink-0 text-xs tabular-nums text-text-4">
                    {relativeAge(preview.at)}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-4">
                {preview.shown.map((turn, i) => (
                  <Turn
                    key={`${turn.role}-${turn.ts}-${i}`}
                    turn={turn}
                    agentLabel={agentLabel}
                  />
                ))}
              </div>

              <div className="mt-5 border-t border-line-soft pt-3 text-xs text-text-4">
                {preview.earlier > 0
                  ? `${preview.earlier} earlier message${
                      preview.earlier === 1 ? "" : "s"
                    } in this conversation. Starting picks it up from here.`
                  : "Starting picks this conversation up from here."}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Turn({
  turn,
  agentLabel,
}: {
  turn: PrerollTurn;
  agentLabel?: string;
}) {
  const who = turn.role === "user" ? "You" : (agentLabel ?? "The agent");
  // Agents answer in markdown. Six clamped lines is not a document, so the
  // excerpt shows the sentence with the markup taken off rather than a
  // literal `##` and a row of asterisks. See plainPreview.ts.
  const text = plainPreview(turn.text);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-text-3">{who}</div>
      {/* Clamped on purpose. This is the thread's last beat, not the thread —
          the full transcript is one click away in the tab's own reader, and a
          6,000-word tool-heavy turn dumped here would bury the thing the
          reader came for. */}
      <div className="line-clamp-6 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-2">
        {text || <span className="text-text-4">(no text in this turn)</span>}
      </div>
    </div>
  );
}

/** Read the tail of the conversation this tab resumes.
 *
 *  Shows the last turn plus the most recent turn of the OTHER role before it,
 *  which is the exchange in both directions that matter: an agent that
 *  answered and stopped, and an agent that was asked something and never got
 *  to answer. Taking "the last two turns" would collapse the second case into
 *  two assistant messages with the question missing. */
function useLastExchange(
  agentId?: string,
  repoRoot?: string,
  resumeSessionId?: string | null,
): Preview {
  const [preview, setPreview] = useState<Preview>({ state: "idle" });

  useEffect(() => {
    if (!agentId || !repoRoot || !resumeSessionId) {
      setPreview({ state: "idle" });
      return;
    }
    let live = true;
    setPreview({ state: "loading" });
    api
      .agentHistoryPreroll(agentId, repoRoot, resumeSessionId)
      .then((turns) => {
        if (!live) return;
        const usable = turns.filter(
          (t) => t.role === "user" || t.role === "assistant",
        );
        const last = usable[usable.length - 1];
        if (!last) {
          setPreview({ state: "empty" });
          return;
        }
        const priorOther = [...usable.slice(0, -1)]
          .reverse()
          .find((t) => t.role !== last.role);
        const shown = priorOther ? [priorOther, last] : [last];
        setPreview({
          state: "ready",
          shown,
          earlier: usable.length - shown.length,
          at: last.ts,
        });
      })
      .catch(() => {
        // The transcript is a convenience, never the reason you can't start
        // the agent. A failed read falls back to the plain copy.
        if (live) setPreview({ state: "empty" });
      });
    return () => {
      live = false;
    };
  }, [agentId, repoRoot, resumeSessionId]);

  return preview;
}

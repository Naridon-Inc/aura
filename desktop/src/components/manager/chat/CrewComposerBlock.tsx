// CrewComposerBlock — the live Crew telemetry strip docked above the chat
// composer.
//
// When you hand the autonomous work-loop (Crew) a stack of tasks from inside
// this chat — `/loop`, "Run", or a board sync — agents start working them in
// dependency order on their own. Claude Code surfaces its own sub-agents as a
// compact line at the bottom of the conversation; this is the same idea for
// Aura's crew: one quiet, collapsible line attached to the composer that says
// how many agents are on it right now, expandable into a nested per-agent view
// (who's working on what, what just landed with its proof, what hit a problem).
//
// All real data, no new backend: it reads the SAME shared loop graph
// (`loop_ready_view`) the CLI `aura loop run` and the Crew surface read, folds
// the goals ledger for proof, and links a working row to its live lane through
// `CrewLiveTranscript` so a click watches the agent work. When no agent is
// working and nothing is queued, the strip renders nothing — it never nags.

import * as React from "react";
import { ChevronDown, ChevronRight, CircleAlert, Users } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import "../../ui/crew-strip.css";

import { type ReadyViewDto } from "../../../lib/api";
import { fetchReadyView } from "../../../lib/loopCache";
import { buildActivityFeed } from "../../commons/crew/crewActivity";
import {
  bestProof,
  loadCrewProof,
  proofForCommit,
  type CrewProof,
} from "../../commons/crew/crewProof";
import {
  AgentBit,
  CommitChip,
  ProofPill,
  WorkingLine,
} from "../../commons/crew/crewShared";
import { CrewLiveTranscript } from "../../commons/crew/CrewLiveTranscript";

// Poll the shared loop graph on a calm cadence — it's a cheap on-disk read
// (`.aura/a2a/`), and only runs while the chat is mounted.
const POLL_MS = 5000;
// The strip is telemetry, not a board: cap finished/failed rows so it stays a
// glance, never a wall. The full history lives in Build → Crew.
const MAX_DONE = 3;
const MAX_FAILED = 2;

export function CrewComposerBlock({
  repoRoot,
  onActiveChange,
}: {
  repoRoot: string | null;
  /** Fires whenever the strip's active state flips — true once a real agent is
   *  working or a task is queued, false once the run settles. The chat uses
   *  this to clear its optimistic "Spinning up the crew…" line the moment this
   *  live strip takes over. */
  onActiveChange?: (active: boolean) => void;
}) {
  const [view, setView] = React.useState<ReadyViewDto | null>(null);
  const [open, setOpen] = React.useState(false);
  const [proof, setProof] = React.useState<Map<string, CrewProof[]>>(
    () => new Map(),
  );
  const [watchTitle, setWatchTitle] = React.useState<string | null>(null);
  const proofKeyRef = React.useRef("");

  // Live poll of the unified ready_view — the same truth `/loop` reads, so the
  // strip never drifts from the runner.
  React.useEffect(() => {
    if (!repoRoot) {
      setView(null);
      return;
    }
    let alive = true;
    const tick = () => {
      // Shared with the Crew surface, which polls the same graph on its own
      // timer while this strip is docked under the composer beside it.
      void fetchReadyView(repoRoot)
        .then((v) => {
          if (alive) setView(v);
        })
        // A repo with no crew graph yet simply yields nothing — not an error
        // worth surfacing in the composer.
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [repoRoot]);

  const feed = React.useMemo(
    () => (view ? buildActivityFeed(view) : []),
    [view],
  );
  const working = React.useMemo(
    () => feed.filter((i) => i.kind === "working"),
    [feed],
  );
  const done = React.useMemo(
    () => feed.filter((i) => i.kind === "done").slice(0, MAX_DONE),
    [feed],
  );
  const failed = React.useMemo(
    () => feed.filter((i) => i.kind === "failed").slice(0, MAX_FAILED),
    [feed],
  );
  const doneKey = React.useMemo(
    () => done.map((i) => i.task.commit_sha ?? "").join(","),
    [done],
  );

  // Proof only matters for finished rows — fold the goals ledger when the done
  // set changes (keyed by their commits), never on every poll. The ledger read
  // shells `aura goals list`, so we keep it off the hot path.
  React.useEffect(() => {
    if (!repoRoot || !doneKey || doneKey === proofKeyRef.current) return;
    proofKeyRef.current = doneKey;
    void loadCrewProof(repoRoot)
      .then(setProof)
      .catch(() => {});
  }, [repoRoot, doneKey]);

  const readyCount = view?.counts.ready ?? 0;
  const liveCount = working.length;
  // Show only while there's something live or queued — once the run settles
  // with nothing waiting, the strip collapses away (matching Claude Code's
  // sub-agent line, which clears when the work ends).
  const active = liveCount > 0 || readyCount > 0;
  // Report active-state transitions up so the chat can retire its optimistic
  // spawn line. Runs every render before the conditional return, so the hook
  // order stays stable.
  React.useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);
  if (!repoRoot || !active) return null;

  const summary =
    liveCount > 0
      ? `${liveCount} ${liveCount === 1 ? "agent" : "agents"} working`
      : `${readyCount} ${readyCount === 1 ? "task" : "tasks"} queued`;
  const lead = working[0]?.task.title ?? done[0]?.task.title ?? "";

  return (
    <div className="ui-message-queue ui-crew-strip" aria-label="Crew">
      <div className="ui-queue-caption">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Hide the crew" : "Show the crew"}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {/* Agents are working right now — the one thing the house spinner
              is for. */}
          {liveCount > 0 ? <AsciiSpinner size={12} /> : <Users size={12} />}
          <span className="ui-crew-strip-summary">
            {summary}
            {lead ? <span className="ui-crew-strip-lead"> · {lead}</span> : null}
          </span>
        </button>
      </div>

      {open && (
        <>
          {/* Working — clickable, opens the agent's live transcript so you can
              watch it build, not just read a label. */}
          {working.map((i) => (
            <button
              key={i.task.id}
              type="button"
              className="ui-queue-row ui-crew-strip-row"
              onClick={() => setWatchTitle(i.task.title)}
              title="Watch this agent work"
            >
              <AgentBit agentKind={i.task.agent_kind} size={18} />
              <span className="ui-queue-text">{i.task.title}</span>
              <WorkingLine agentKind={i.task.agent_kind} />
            </button>
          ))}

          {/* Just landed — with the proof that ties the commit to the goal it
              delivered. */}
          {done.map((i) => {
            const best = bestProof(proofForCommit(proof, i.task.commit_sha));
            return (
              <div key={i.task.id} className="ui-queue-row ui-crew-strip-row" data-done="">
                <AgentBit agentKind={i.task.agent_kind} size={18} dim />
                <span className="ui-queue-text">{i.task.title}</span>
                {i.task.commit_sha ? <CommitChip sha={i.task.commit_sha} /> : null}
                {best ? <ProofPill proof={best} /> : null}
              </div>
            );
          })}

          {/* Hit a problem — surfaced so a stuck run is never silent. */}
          {failed.map((i) => (
            <div key={i.task.id} className="ui-queue-row ui-crew-strip-row" data-failed="">
              <CircleAlert size={14} aria-label="Hit a problem" />
              <span className="ui-queue-text">
                {i.task.title}
                <small>{(i.task.error_message ?? "Hit a problem").trim().split("\n")[0]}</small>
              </span>
            </div>
          ))}

          <p className="ui-crew-strip-foot">
            Crew is running these for you. Open Build → Crew to manage, or type{" "}
            <code>/loop</code> in chat.
          </p>
        </>
      )}

      {/* The transcript is a sheet, which portals itself and brings its own
          overlay. It used to be wrapped in a full-screen layer of our own on
          top of that, which sat over the whole window while it was open. */}
      {watchTitle ? (
        <CrewLiveTranscript nodeTitle={watchTitle} onClose={() => setWatchTitle(null)} />
      ) : null}
    </div>
  );
}

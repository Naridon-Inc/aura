// LaneSwitcher (AURA-81) — the user-facing surface for Lanes: Aura's
// built-in way to run more than one coding agent at once without the user
// ever touching `git worktree` or switching branches.
//
// Each "lane" is its own isolated copy of the project for one agent, so two
// agents can work in parallel and never overwrite each other's files. This
// component lets the user:
//   - see their lanes and switch which one they're looking at
//   - start a new lane (pick an agent + an optional short label)
//   - close a lane, with a guard that warns when it has unsaved work
//
// Plain-language copy throughout — the audience is non-engineers. The
// `lane/claude-ab12ef34` branch name only ever shows as quiet secondary
// detail, never as the headline.
//
// NOTE (intended mount point): this is a complete, self-contained,
// importable component. The integration step (mounting it in the agent
// surface header / a global rail) is deliberately left to merge-back so
// it doesn't conflict with concurrent layout work. Render it with the
// active workspace root, e.g. `<LaneSwitcher repoRoot={project.root} />`.

import { useEffect, useState } from "react";
import { type AgentInfo, type Lane } from "../../lib/api";
import { api } from "../../lib/api";
import {
  discardLane,
  setActiveLane,
  spawnLane,
  useLanes,
} from "../../lib/laneStore";
import { AgentIcon } from "./AgentIcon";
import { Input } from "../ui/input";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Props = {
  /** Active workspace root. Lanes are scoped to it. */
  repoRoot: string;
  /** Fired after a lane is started or switched to, with the lane's live
   *  agent session id (when present) so the host can focus/open that
   *  agent's pane. Optional — the switcher is useful on its own. */
  onFocusLane?: (lane: Lane) => void;
};

export function LaneSwitcher({ repoRoot, onFocusLane }: Props) {
  const { lanes, activeLaneId, spawning } = useLanes(repoRoot);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The lane the user is being asked to confirm closing because it has
  // unsaved work. Cleared on confirm/cancel.
  const [dirtyConfirm, setDirtyConfirm] = useState<{
    lane: Lane;
    changedFiles: number;
  } | null>(null);

  function focus(lane: Lane) {
    setActiveLane(repoRoot, lane.id);
    onFocusLane?.(lane);
  }

  async function onDiscard(lane: Lane, force: boolean) {
    setError(null);
    try {
      const result = await discardLane(repoRoot, lane.id, force);
      if (result.kind === "dirty") {
        setDirtyConfirm({ lane, changedFiles: result.changedFiles });
      } else {
        setDirtyConfirm(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex flex-col gap-2 p-2 w-[300px] bg-bg-2 border border-line rounded-lg">
      <div className="flex items-center justify-between px-1">
        <span className="text-text-1 text-[12.5px] font-medium">Lanes</span>
        <span className="text-text-5 text-[10.5px] tabular-nums">
          {lanes.length === 0
            ? "no lanes yet"
            : `${lanes.length} running`}
        </span>
      </div>

      <p className="px-1 text-text-4 text-[10.5px] leading-snug">
        A lane is an isolated copy of your project for one agent. Start a new
        lane to run another agent in parallel — your files never collide.
      </p>

      {/* Lane list */}
      <ul className="flex flex-col gap-1">
        {lanes.map((lane) => {
          const isActive = lane.id === activeLaneId;
          return (
            <li key={lane.id}>
              <div
                onClick={() => focus(lane)}
                className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors"
                style={{
                  background: isActive ? "var(--color-accent)" : "transparent",
                }}
              >
                <AgentIcon agentId={lane.agent} size={16} active={isActive} />
                <div className="flex-1 min-w-0">
                  <div
                    className="text-[12px] truncate"
                    style={{ color: isActive ? "var(--color-bg-0)" : "var(--color-text-1)" }}
                  >
                    {lane.label || laneTitle(lane)}
                  </div>
                  <div
                    className="text-[10px] font-mono truncate"
                    style={{
                      color: isActive
                        ? "color-mix(in srgb, var(--color-bg-0) 70%, transparent)"
                        : "var(--color-text-5)",
                    }}
                    title={`branch ${lane.branch}`}
                  >
                    {lane.termId ? "active" : "paused"} · branch {lane.branch}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDiscard(lane, false);
                  }}
                  title="Close this lane"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-[10.5px] px-1.5 py-0.5 rounded flex-shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                  style={{
                    color: isActive
                      ? "color-mix(in srgb, var(--color-bg-0) 85%, transparent)"
                      : "var(--color-text-4)",
                  }}
                >
                  Close
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Dirty-guard confirmation */}
      {dirtyConfirm && (
        <div className="flex flex-col gap-2 p-2 rounded-md bg-bg-1 border border-line-soft">
          <span className="text-text-1 text-[11.5px] leading-snug">
            This lane has unsaved work
            {dirtyConfirm.changedFiles > 0 && (
              <>
                {" "}
                ({dirtyConfirm.changedFiles} changed file
                {dirtyConfirm.changedFiles === 1 ? "" : "s"})
              </>
            )}
            . Discard anyway?
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onDiscard(dirtyConfirm.lane, true)}
              className="text-[11px] px-2 h-6 rounded text-white"
              style={{ background: "var(--color-red)" }}
            >
              Discard anyway
            </button>
            <button
              type="button"
              onClick={() => setDirtyConfirm(null)}
              className="text-[11px] px-2 h-6 rounded text-text-3 hover:bg-bg-hover"
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="px-1 text-red text-[10.5px] font-mono break-words">
          {error}
        </div>
      )}

      {/* Start a new lane */}
      {starting ? (
        <NewLanePicker
          repoRoot={repoRoot}
          busy={spawning}
          onCancel={() => setStarting(false)}
          onStart={async (agentId, label) => {
            setError(null);
            try {
              const lane = await spawnLane(repoRoot, agentId, label || undefined);
              setStarting(false);
              focus(lane);
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setStarting(true)}
          className="flex items-center justify-center gap-1.5 h-8 rounded-md text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--color-accent)" }}
        >
          <span className="text-[13px] leading-none">+</span>
          Start a new lane
        </button>
      )}
    </div>
  );
}

/** Inline agent-picker + optional label for starting a fresh lane. Pulls
 *  the installed agent list from `agentDiscover`. */
function NewLanePicker({
  repoRoot: _repoRoot,
  busy,
  onCancel,
  onStart,
}: {
  repoRoot: string;
  busy: boolean;
  onCancel: () => void;
  onStart: (agentId: string, label: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .agentDiscover()
      .then((list) => {
        if (!alive) return;
        const usable = list.filter((a) => a.available);
        setAgents(usable);
        // Default to the first available agent so the user can start with
        // one click.
        setAgentId((cur) => cur ?? usable[0]?.id ?? null);
      })
      .catch(() => {
        if (alive) setAgents([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-2 p-2 rounded-md bg-bg-1 border border-line-soft">
      <span className="text-text-1 text-[11.5px] font-medium">
        Start a new lane
      </span>

      <div className="flex flex-col gap-1">
        {agents === null && (
          <span className="flex items-center gap-1.5 text-text-4 text-[10.5px]">
            <AsciiSpinner />
            Finding agents…
          </span>
        )}
        {agents && agents.length === 0 && (
          <span className="text-text-4 text-[10.5px]">
            No agents found. Install Claude Code, Gemini, or Codex first.
          </span>
        )}
        {agents?.map((a) => {
          const active = a.id === agentId;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setAgentId(a.id)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors"
              style={{
                background: active ? "var(--color-accent)" : "transparent",
              }}
            >
              <AgentIcon agentId={a.id} label={a.label} size={16} active={active} />
              <span
                className="text-[12px] flex-1"
                style={{ color: active ? "var(--color-bg-0)" : "var(--color-text-1)" }}
              >
                {a.label}
              </span>
            </button>
          );
        })}
      </div>

      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Name this lane (optional)"
        className="text-[11.5px] placeholder:text-text-5"
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!agentId || busy}
          onClick={() => agentId && onStart(agentId, label.trim())}
          className="flex-1 h-7 rounded-md text-[11.5px] font-medium text-white disabled:opacity-50 transition-opacity hover:opacity-90"
          style={{ background: "var(--color-accent)" }}
        >
          {busy ? "Starting…" : "Start lane"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-2.5 rounded-md text-[11.5px] text-text-3 hover:bg-bg-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Human-ish title for a lane that has no user label — "Claude lane"
 *  reads far better than the raw branch in the headline slot. */
function laneTitle(lane: Lane): string {
  const name = lane.agent.charAt(0).toUpperCase() + lane.agent.slice(1);
  return `${name} lane`;
}

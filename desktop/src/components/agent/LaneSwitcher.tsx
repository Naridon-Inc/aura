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
// branch name — `lane/claude/auth-refactor` for a labelled lane, or
// `lane/claude-ab12ef34` for one the user never named — only ever shows as
// quiet secondary detail, never as the headline.
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
import { Check, Plus, X } from "lucide-react";

import { AgentIcon } from "./AgentIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import "../ui/launcher.css";
import { titleCaseName } from "@shared/textCase";

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
    <div className="ui-lanes">
      <header className="ui-lanes-head">
        <strong>Lanes</strong>
        <span>{lanes.length === 0 ? "None yet" : `${lanes.length} running`}</span>
      </header>

      <p className="ui-launcher-menu-note">
        A lane is an isolated copy of your repository for one agent. Start a new
        lane to run another agent in parallel. Your files never collide.
      </p>

      {lanes.length > 0 && (
        <ul className="ui-lanes-list">
          {lanes.map((lane) => {
            const isActive = lane.id === activeLaneId;
            return (
              <li key={lane.id} className="ui-lanes-item">
                <button
                  type="button"
                  className="ui-menu-row ui-where-row"
                  data-current={isActive ? "" : undefined}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => focus(lane)}
                >
                  <AgentIcon agentId={lane.agent} size={14} />
                  <span className="ui-where-row-text">
                    <span>{lane.label || laneTitle(lane)}</span>
                    <small className="ui-launcher-mono" title={`branch ${lane.branch}`}>
                      {lane.termId ? "active" : "paused"} · branch {lane.branch}
                    </small>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="iconXs"
                  className="ui-lanes-close"
                  aria-label={`Close ${lane.label || laneTitle(lane)}`}
                  title="Close this lane"
                  onClick={() => void onDiscard(lane, false)}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Dirty-guard confirmation */}
      {dirtyConfirm && (
        <Alert variant="destructive" className="ui-lanes-confirm">
          <AlertDescription>
            This lane has unsaved work
            {dirtyConfirm.changedFiles > 0 && (
              <>
                {" "}
                ({dirtyConfirm.changedFiles} changed file
                {dirtyConfirm.changedFiles === 1 ? "" : "s"})
              </>
            )}
            . Discard anyway?
          </AlertDescription>
          <div className="ui-lanes-actions">
            <Button
              variant="destructive"
              size="xs"
              onClick={() => void onDiscard(dirtyConfirm.lane, true)}
            >
              Discard anyway
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setDirtyConfirm(null)}>
              Keep it
            </Button>
          </div>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="ui-launcher-mono">{error}</AlertDescription>
        </Alert>
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
        <Button className="ui-lanes-start" onClick={() => setStarting(true)}>
          <Plus />
          Start a new lane
        </Button>
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
    <section className="ui-lanes-new">
      <div className="ui-launcher-pop-label">Start a new lane</div>

      <div className="ui-lanes-agents">
        {agents === null && (
          <span className="ui-launcher-menu-note" data-loading="">
            <AsciiSpinner />
            Finding agents…
          </span>
        )}
        {agents && agents.length === 0 && (
          <span className="ui-launcher-menu-note">
            No agents found. Install Claude Code, Gemini, or Codex first.
          </span>
        )}
        {agents?.map((a) => {
          const active = a.id === agentId;
          return (
            <button
              key={a.id}
              type="button"
              className="ui-menu-row ui-where-row"
              data-current={active ? "" : undefined}
              aria-pressed={active}
              onClick={() => setAgentId(a.id)}
            >
              <AgentIcon agentId={a.id} label={a.label} size={14} />
              <span className="ui-where-row-text">
                <span>{a.label}</span>
              </span>
              {active && <Check className="ui-where-check" />}
            </button>
          );
        })}
      </div>

      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Name this lane (optional)"
        size="small"
      />

      <div className="ui-lanes-actions">
        <Button
          size="sm"
          className="ui-lanes-start"
          disabled={!agentId || busy}
          onClick={() => agentId && onStart(agentId, label.trim())}
        >
          {busy ? <AsciiSpinner size={12} /> : null}
          {busy ? "Starting…" : "Start lane"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/** Human-ish title for a lane that has no user label — "Claude lane"
 *  reads far better than the raw branch in the headline slot. */
function laneTitle(lane: Lane): string {
  const name = titleCaseName(lane.agent);
  return `${name} lane`;
}

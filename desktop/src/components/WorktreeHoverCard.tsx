// The worktree copy card — Aura's take on Conductor's per-copy detail. A calm,
// compact card: the copy's identity (branch small on top, humanized title
// bold under it) with a status ring drawn in the board's own progress-glyph
// language; who's driving it and what they're doing right now; and — the point
// of this redesign — ONE contextual action derived from the copy's real git
// state, not a generic "Open". Uncommitted work offers Commit & push; a copy
// behind its remote offers Pull; local commits with no PR offer Create PR (an
// outline button with a split menu); an existing PR offers a jump to it; a
// clean, in-sync copy offers nothing at all. Opening the copy is the card body
// itself (and the row) — the button is reserved for what git is asking for.
//
// The judgement actions (a commit message, a PR title+body) don't run raw git
// here — they hand the work to Aura's chat, which opens in THIS copy's own
// workspace and does it, auto-sent, so the user watches it happen.
//
// Real data only. Ahead/behind + origin are fetched on hover (the card mounts
// only while open). A copy with no agent, no action and no PR simply shows less.

import { useEffect, useRef, useState } from "react";
import * as Icons from "./Icons";
import { api } from "../lib/api";
import { streamChannel, useAgentStream } from "../lib/agentStreamStore";
import { relAge, summarizeEvents } from "../lib/streamSummary";
import { AgentIcon } from "./agent/AgentIcon";
import {
  askAuraToRun,
  commitPushPrompt,
  createPrPrompt,
  deriveWtAction,
  openPr,
  pullPrompt,
  type WtAction,
} from "../lib/worktreeActions";
import type { WorktreeBadge } from "../lib/useWorktreeBadges";
import type { WorktreeRef } from "./WorkspaceRail";

/** One agent attached to the worktree — the roster's `LaneAgent` shape,
 *  restated locally so the card doesn't couple to the roster module. */
export type HoverAgent = {
  sessionId: string;
  agentId: string;
  agentLabel: string;
  attention: boolean;
};

type Props = {
  worktree: WorktreeRef;
  /** Humanized branch name shown as the copy's title (matches the row). */
  title: string;
  /** Fallback label when the copy has no branch (the project's own name). */
  projName: string;
  isActive: boolean;
  agents: HoverAgent[];
  badge?: WorktreeBadge;
  onOpen: () => void;
};

/** The status the header ring paints, in the board's own status-glyph
 *  vocabulary (the kanban `StateRing`): a copy reads on the same progress
 *  scale as a task. Order of precedence lives in `ringKind`. */
type RingKind = "done" | "attention" | "in-use" | "unsaved" | "idle";

export function WorktreeHoverCard({
  worktree,
  title,
  projName,
  agents,
  badge,
  onOpen,
}: Props) {
  const rawBranch = (worktree.branch || "").replace(/^refs\/heads\//, "");
  const hasDiff = !!badge && (badge.added > 0 || badge.removed > 0);
  const hasAgents = agents.length > 0;
  const needsYou = agents.some((a) => a.attention);
  const merged = (badge?.pr?.state || "").toUpperCase() === "MERGED";
  const ageSecs =
    worktree.head_committed_at && worktree.head_committed_at > 0
      ? Math.max(0, Math.floor(Date.now() / 1000 - worktree.head_committed_at))
      : -1;
  const ring = ringKind(merged, needsYou, hasAgents, hasDiff);

  // Ahead/behind vs upstream + origin — fetched on hover. `dirty` is known
  // instantly from the badge, so the action can show before this resolves and
  // upgrade (e.g. idle → Pull) once it lands.
  const [ab, setAb] = useState<{ ahead: number; behind: number; up: boolean }>({
    ahead: 0,
    behind: 0,
    up: false,
  });
  const originRef = useRef<string>("");
  useEffect(() => {
    let cancelled = false;
    void api
      .gitAheadBehind(worktree.path)
      .then((r) => {
        if (!cancelled)
          setAb({ ahead: r.ahead, behind: r.behind, up: r.has_upstream });
      })
      .catch(() => {});
    void api
      .gitRemoteOrigin(worktree.path)
      .then((o) => {
        originRef.current = o || "";
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [worktree.path]);

  const action: WtAction = deriveWtAction({
    dirty: hasDiff,
    ahead: ab.ahead,
    behind: ab.behind,
    hasUpstream: ab.up,
    pr: badge?.pr ?? null,
  });

  return (
    <div className="wt-hovercard">
      {/* Header — branch small on top, humanized title bold, status ring. */}
      <button type="button" className="wt-hc-head" onClick={onOpen}>
        <div className="wt-hc-id">
          {rawBranch && <div className="wt-hc-branch">{rawBranch}</div>}
          <div className="wt-hc-name">{title || projName}</div>
        </div>
        <StatusRing kind={ring} />
      </button>

      {/* Who's driving it — or, when no agent, a one-line calm status. */}
      {hasAgents ? (
        <div className="wt-hc-agents">
          {agents.map((a) => (
            <AgentRow key={a.sessionId} agent={a} repoRoot={worktree.path} />
          ))}
        </div>
      ) : (
        <div className="wt-hc-status">{ringLabel(ring)}</div>
      )}

      {/* Action row — the ONE thing this copy's git state is asking for, plus
          its PR + age. An in-sync, clean, PR-less copy renders no button. */}
      {(action.kind !== "none" || ageSecs >= 0) && (
        <div className="wt-hc-foot">
          <ActionButton
            action={action}
            branch={rawBranch}
            title={title || projName}
            cwd={worktree.path}
            pr={badge?.pr ?? null}
            originRef={originRef}
          />
          {ageSecs >= 0 && <span className="wt-hc-age">{relAge(ageSecs)}</span>}
        </div>
      )}
    </div>
  );
}

/** The copy's one contextual action, styled Conductor-compact + outline. For
 *  Create PR it's a split button: the face opens a normal PR, the caret opens
 *  a small menu (draft PR / push only). Every judgement action hands off to
 *  Aura's chat via `askAuraToRun`; opening an existing PR goes to the browser. */
function ActionButton({
  action,
  branch,
  title,
  cwd,
  pr,
  originRef,
}: {
  action: WtAction;
  branch: string;
  title: string;
  cwd: string;
  pr: { number: number; state: string } | null;
  originRef: { current: string };
}) {
  const [menu, setMenu] = useState(false);

  if (action.kind === "none") {
    // No git action — but surface an existing PR link if the badge knows one.
    if (!pr) return <span className="wt-hc-spacer" />;
    return (
      <button
        type="button"
        className="wt-hc-act wt-hc-act-ghost"
        onClick={(e) => {
          e.stopPropagation();
          void openPr(originRef.current, pr.number);
        }}
      >
        <Icons.GitBranch size={11} />#{pr.number}
        <ExternalGlyph />
      </button>
    );
  }

  const run = (label: string, prompt: string) => {
    askAuraToRun(cwd, label, prompt);
  };

  if (action.kind === "open_pr") {
    return (
      <button
        type="button"
        className="wt-hc-act wt-hc-act-ghost"
        onClick={(e) => {
          e.stopPropagation();
          if (pr) void openPr(originRef.current, pr.number);
        }}
      >
        <Icons.GitBranch size={11} />
        {action.label}
        <ExternalGlyph />
      </button>
    );
  }

  if (action.kind === "commit_push") {
    return (
      <button
        type="button"
        className="wt-hc-act wt-hc-act-outline"
        onClick={(e) => {
          e.stopPropagation();
          run("Commit & push", commitPushPrompt(branch));
        }}
      >
        <Icons.GitBranch size={12} />
        {action.label}
      </button>
    );
  }

  if (action.kind === "pull") {
    return (
      <button
        type="button"
        className="wt-hc-act wt-hc-act-outline"
        onClick={(e) => {
          e.stopPropagation();
          run("Pull", pullPrompt(branch));
        }}
      >
        <Icons.GitBranch size={12} />
        {action.label}
      </button>
    );
  }

  // create_pr — outline split button + a small menu.
  return (
    <div className="wt-hc-split" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="wt-hc-act wt-hc-act-outline wt-hc-split-face"
        onClick={() => run("Create PR", createPrPrompt(branch, title))}
      >
        <Icons.GitBranch size={12} />
        {action.label}
      </button>
      <button
        type="button"
        className="wt-hc-act wt-hc-act-outline wt-hc-split-caret"
        aria-label="More PR options"
        onClick={() => setMenu((v) => !v)}
      >
        <CaretGlyph />
      </button>
      {menu && (
        <div className="wt-hc-menu" onMouseLeave={() => setMenu(false)}>
          <button
            type="button"
            className="wt-hc-menu-item"
            onClick={() => {
              setMenu(false);
              run("Create draft PR", createPrPrompt(branch, title, true));
            }}
          >
            Create draft PR
          </button>
          <button
            type="button"
            className="wt-hc-menu-item"
            onClick={() => {
              setMenu(false);
              run(
                "Push branch",
                `Push branch \`${branch}\` to its remote (set the upstream if it has none). Don't open a PR yet — just push. Report the result.`,
              );
            }}
          >
            Push branch only
          </button>
        </div>
      )}
    </div>
  );
}

/** One agent row: brand mark + name + live working/idle + activity line. */
function AgentRow({ agent, repoRoot }: { agent: HoverAgent; repoRoot: string }) {
  const { running, events } = useAgentStream(streamChannel(agent.agentId, repoRoot));
  const summary = summarizeEvents(events);
  return (
    <div className="wt-hc-agent">
      <span className="wt-hc-agent-icon">
        <AgentIcon agentId={agent.agentId} size={15} />
      </span>
      <div className="wt-hc-agent-body">
        <div className="wt-hc-agent-head">
          <span className="wt-hc-agent-name">{agent.agentLabel}</span>
          {running ? (
            <span className="wt-hc-run">
              <span className="wt-hc-dot" />
              working
            </span>
          ) : agent.attention ? (
            <span className="wt-hc-attn">needs you</span>
          ) : (
            <span className="wt-hc-idle">idle</span>
          )}
        </div>
        {summary && (
          <div className="wt-hc-activity" title={summary}>
            {summary}
          </div>
        )}
      </div>
    </div>
  );
}

/** The copy's state drawn in the board's own status-glyph vocabulary — the
 *  same dashed-ring / conic-arc / solid-disc language the kanban `StateRing`
 *  uses, so a copy sits on the same progress scale as a task: dormant →
 *  in progress → waiting on you → shipped. Static (never animated): the live
 *  "working" pulse lives on the agent row, so the header never spins for a
 *  copy merely attached to an idle agent. */
function StatusRing({ kind }: { kind: RingKind }) {
  const glyph = (() => {
    switch (kind) {
      case "done": // merged — the board's solid "done" disc
        return "border-[1.5px] border-emerald-500 bg-emerald-500";
      case "attention": // waiting on you — the board's "in review" arc
        return "border-[1.5px] border-sky-400 bg-[conic-gradient(theme(colors.sky.400)_75%,transparent_75%)]";
      case "in-use": // an agent is on it — the board's "in progress" arc
      case "unsaved": // changes in flight — same rung, both "in progress"
        return "border-[1.5px] border-amber-400 bg-[conic-gradient(theme(colors.amber.400)_50%,transparent_50%)]";
      default: // idle / dormant — the board's dashed "backlog" ring
        return "border-dashed border-[1.5px] border-text-4";
    }
  })();
  return (
    <span className="wt-hc-ring" aria-label={ringLabel(kind)} title={ringLabel(kind)}>
      <span className={`w-3 h-3 rounded-full box-border block ${glyph}`} aria-hidden />
    </span>
  );
}

/** The copy's state, most-significant first: a shipped (merged) copy beats an
 *  agent waiting on you beats "in use" beats unsaved edits beats idle. "Which
 *  copy you're in" is shown by the roster row, not this progress glyph. */
function ringKind(
  merged: boolean,
  needsYou: boolean,
  hasAgents: boolean,
  hasDiff: boolean,
): RingKind {
  if (merged) return "done";
  if (needsYou) return "attention";
  if (hasAgents) return "in-use";
  if (hasDiff) return "unsaved";
  return "idle";
}

function ringLabel(kind: RingKind): string {
  switch (kind) {
    case "done":
      return "Merged";
    case "attention":
      return "Needs you";
    case "in-use":
      return "In use";
    case "unsaved":
      return "Unsaved changes";
    default:
      return "Idle";
  }
}

function CaretGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d="M2.5 4L5 6.5L7.5 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d="M3.5 2H8V6.5M8 2L2 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

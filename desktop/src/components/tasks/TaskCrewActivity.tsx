// TaskCrewActivity — "Agents on this" section for the task detail page.
//
// Now that Aura has Crews (the autonomous work-loop where sub-agents pick up
// tasks in dependency order, work them, commit, and prove the result), opening
// a board task should answer the obvious questions in plain language: is an
// agent on this right now? which one? what is it waiting on, and what does it
// unblock? when it finished, did the code actually pass the checks?
//
// Zero new backend. The crew's task graph already comes back from
// `api.loopReadyView` partitioned by lifecycle. We flatten every partition into
// one node list, find the node whose `board_task_id` points back to THIS board
// task, and read its state straight off the graph (a node is "working" when its
// status says so — there is no separate lease record). Dependency ids resolve
// to real node titles via an id→node map; "Unblocks" is every node that names
// this one in its own `depends_on`. The proof verdict is joined from the goals
// ledger by the node's `commit_sha`.
//
// If no crew node points at this task, it was simply never handed to a crew —
// we say exactly that and invent nothing.

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { RotateCcw } from "lucide-react";

import { api, type LoopTask, type ReadyViewDto } from "../../lib/api";
import { fetchReadyView } from "../../lib/loopCache";
import { agentDisplayLabel, canonicalAgentId } from "../../lib/agentIdentity";
import { Button } from "../ui/button";
import {
  TaskDependencyLinks,
  TaskDetailNote,
  TaskDetailSection,
  type TaskDependencyItem,
} from "../ui/tasks-detail";
import { TaskProperty, TaskPropertyList } from "../ui/tasks-properties";
import { TaskStatusBadge } from "../ui/tasks-status";
import { WorkspaceStageIcon, type WorkspaceStage } from "../ui/workspace-preview-card";
import {
  AgentBit,
  CommitChip,
  ProofPill,
  relativeTime,
} from "../commons/crew/crewShared";
import {
  bestProof,
  loadCrewProof,
  proofForCommit,
  type CrewProof,
} from "../commons/crew/crewProof";

import "../ui/tasks-detail-sections.css";

type Lifecycle = "ready" | "working" | "blocked" | "paused" | "done" | "failed";

// Plain-language lifecycle, drawn with the same stage glyphs as a board
// task's status so a crew state reads like any other status on the page.
// Mirrors CrewTaskDetail's wording so a task reads the same everywhere.
const LIFECYCLE: Record<Lifecycle, { stage: WorkspaceStage; label: string }> = {
  ready: { stage: "backlog", label: "Ready for an agent" },
  working: { stage: "in-progress", label: "An agent is on it" },
  blocked: { stage: "backlog", label: "Waiting on earlier work" },
  paused: { stage: "backlog", label: "Paused. Held back" },
  done: { stage: "done", label: "Done" },
  failed: { stage: "canceled", label: "Needs another try" },
};

// Lifecycle from the node's status + whether its dependencies actually finished
// — never the raw enum on screen. Same derivation CrewTaskDetail uses.
function lifecycleOf(task: LoopTask, byId: Map<string, LoopTask>): Lifecycle {
  const s = task.status;
  if (s === "completed" || s === "done") return "done";
  if (s === "working" || s === "in_progress" || s === "leased") return "working";
  if (s === "failed") return "failed";
  if (s === "paused") return "paused";
  const unmet = (task.depends_on ?? []).filter((id) => {
    const dep = byId.get(id);
    return !dep || (dep.status !== "completed" && dep.status !== "done");
  });
  return unmet.length > 0 ? "blocked" : "ready";
}

// Every crew node, regardless of which lifecycle bucket it sits in. `blocked`
// wraps its node in `{ task, unmet }`; the rest are bare nodes.
function flattenNodes(view: ReadyViewDto): LoopTask[] {
  return [
    ...view.working,
    ...view.ready,
    ...view.blocked.map((b) => b.task),
    ...view.paused,
    ...view.done,
    ...view.other,
  ];
}

// One plain-language sentence under the state. We never show "leased" /
// "node" / a raw enum — only what a non-engineer cares about.
function statusLineOf(life: Lifecycle, agentName: string | null, stamp: string | null): string | null {
  switch (life) {
    case "working": {
      const who = agentName ? `${agentName} is working on this` : "An agent is working on this";
      return stamp ? `${who} · started ${stamp}` : who;
    }
    case "done":
      return stamp ? `Finished ${stamp}` : "Finished";
    case "blocked":
      return "Waiting for earlier work to finish before an agent can start";
    case "paused":
      return "Held back for now. Resume it from the crew to continue";
    case "ready":
      return agentName ? `Lined up for ${agentName}` : "Lined up. The next free agent will pick it up";
    case "failed":
      return stamp ? `The last attempt stopped ${stamp}` : null;
  }
}

export function TaskCrewActivity({
  taskId,
  repoRoot,
  onOpenTask,
}: {
  /** The BOARD task's id — joined to a crew node via `board_task_id`. */
  taskId: string;
  repoRoot: string;
  /** Opens a board task; a related crew node that came from the board opens
   *  its card. */
  onOpenTask?: (boardTaskId: string) => void;
}): JSX.Element {
  const [nodes, setNodes] = useState<LoopTask[]>([]);
  const [proof, setProof] = useState<Map<string, CrewProof[]>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [arming, setArming] = useState(false);

  const load = useCallback(async () => {
    // Both reads are best-effort: a repo with no crew graph / no goals ledger
    // simply yields empty state, which renders as "Not handed to a crew yet".
    const [view, proofMap] = await Promise.all([
      fetchReadyView(repoRoot).catch(() => null),
      loadCrewProof(repoRoot).catch(() => new Map<string, CrewProof[]>()),
    ]);
    return { nodes: view ? flattenNodes(view) : [], proofMap };
  }, [repoRoot]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { nodes: n, proofMap } = await load();
      if (!alive) return;
      setNodes(n);
      setProof(proofMap);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // The crew node projected from THIS board card. A task is handed to a crew at
  // most once, so the first match wins.
  const node = useMemo(
    () => nodes.find((n) => n.board_task_id === taskId) ?? null,
    [nodes, taskId],
  );

  // Waiting on = its dependencies as real nodes. Unblocks = nodes that name
  // this one in their own depends_on.
  const waitingOn = useMemo(
    () =>
      node
        ? (node.depends_on ?? [])
            .map((id) => byId.get(id))
            .filter((t): t is LoopTask => !!t)
        : [],
    [node, byId],
  );
  const unblocks = useMemo(
    () => (node ? nodes.filter((t) => (t.depends_on ?? []).includes(node.id)) : []),
    [node, nodes],
  );

  const reArm = useCallback(async () => {
    if (!node || arming) return;
    setArming(true);
    try {
      // Re-arm a failed node back into the ready set, then re-read the graph so
      // its state flips here without a manual refresh.
      await api.loopSetStatus(repoRoot, node.id, "submitted");
      const { nodes: n, proofMap } = await load();
      setNodes(n);
      setProof(proofMap);
    } catch {
      // Leave the failed state in place; the action just no-ops on error.
    } finally {
      setArming(false);
    }
  }, [node, arming, repoRoot, load]);

  // Related nodes as rows: the stage glyph says whether the blocker is
  // cleared, the hint says it in words. A node that came from the board
  // opens its card.
  const depItems = useCallback(
    (tasks: LoopTask[]): TaskDependencyItem[] =>
      tasks.map((t) => {
        const life = lifecycleOf(t, byId);
        return {
          id: t.id,
          label: t.title || "(untitled)",
          icon: <WorkspaceStageIcon stage={LIFECYCLE[life].stage} />,
          hint: life === "done" ? "Done" : life === "working" ? "In progress" : "Not yet",
        };
      }),
    [byId],
  );
  const openNode = useCallback(
    (nodeId: string) => {
      const target = byId.get(nodeId)?.board_task_id;
      if (target && onOpenTask) onOpenTask(target);
    },
    [byId, onOpenTask],
  );

  if (!loaded) {
    return (
      <TaskDetailSection title="Agents on this">
        <TaskDetailNote>Checking the crew…</TaskDetailNote>
      </TaskDetailSection>
    );
  }

  if (!node) {
    return (
      <TaskDetailSection title="Agents on this">
        <TaskDetailNote>Not handed to a crew yet. No agent has picked this up.</TaskDetailNote>
      </TaskDetailSection>
    );
  }

  const life = lifecycleOf(node, byId);
  const state = LIFECYCLE[life];
  const agentName = node.agent_kind ? agentDisplayLabel(canonicalAgentId(node.agent_kind)) : null;
  const best = bestProof(proofForCommit(proof, node.commit_sha));
  const statusLine = statusLineOf(life, agentName, relativeTime(node.updated_at));
  const showsAgent = (life === "working" || life === "ready" || life === "done") && !!node.agent_kind;
  const error = (node.error_message ?? "").trim();

  return (
    <TaskDetailSection title="Agents on this">
      <TaskPropertyList>
        <TaskProperty label="State">
          <TaskStatusBadge stage={state.stage} label={state.label} />
        </TaskProperty>
        {showsAgent && (
          <TaskProperty label="Agent">
            <span className="ui-tasks-crew-agent">
              <AgentBit agentKind={node.agent_kind!} size={16} />
              {agentName}
            </span>
          </TaskProperty>
        )}
        {best && (
          <TaskProperty label="Checks">
            <ProofPill proof={best} />
          </TaskProperty>
        )}
        {node.commit_sha && (
          <TaskProperty label="Commit">
            <CommitChip sha={node.commit_sha} />
          </TaskProperty>
        )}
      </TaskPropertyList>

      {statusLine && <TaskDetailNote>{statusLine}</TaskDetailNote>}

      {/* When it finished but the checks didn't all pass — say so plainly. */}
      {life === "done" && best && best.verdict !== "verified" && (
        <TaskDetailNote>
          The code landed but {best.total - best.ok} of {best.total} checks didn't pass. Open the
          commit to see what's left.
        </TaskDetailNote>
      )}
      {life === "done" && !best && (
        <TaskDetailNote>Delivered, but it wasn't checked against a goal.</TaskDetailNote>
      )}

      {/* Failed — the error + a one-click re-arm so the crew tries again. */}
      {life === "failed" && (
        <div className="ui-tasks-crew-failed">
          {error && <p role="alert">{error}</p>}
          <Button variant="outline" size="xs" onClick={() => void reArm()} disabled={arming}>
            <RotateCcw aria-hidden />
            {arming ? "Putting it back…" : "Try it again"}
          </Button>
        </div>
      )}

      {/* Dependency context — what this is waiting on, and what it frees up. */}
      {waitingOn.length > 0 && (
        <div className="ui-tasks-crew-deps">
          <h5>Waiting on</h5>
          <TaskDependencyLinks items={depItems(waitingOn)} onOpen={openNode} />
        </div>
      )}
      {unblocks.length > 0 && (
        <div className="ui-tasks-crew-deps">
          <h5>Unblocks</h5>
          <TaskDependencyLinks items={depItems(unblocks)} onOpen={openNode} />
        </div>
      )}
    </TaskDetailSection>
  );
}

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

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, RotateCcw } from "lucide-react";

import { api, type LoopTask, type ReadyViewDto } from "../../lib/api";
import { Button } from "../ui/button";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import {
  AgentBit,
  ProofPill,
  CommitChip,
  relativeTime,
} from "../commons/crew/crewShared";
import {
  bestProof,
  loadCrewProof,
  proofForCommit,
  type CrewProof,
} from "../commons/crew/crewProof";
import { agentDisplayLabel, canonicalAgentId } from "../../lib/agentIdentity";

type Lifecycle = "ready" | "working" | "blocked" | "paused" | "done" | "failed";

// Plain-language lifecycle → chip. Arctic-blue (blue) for ready, amber while an
// agent works, green for done, red for failed, muted for blocked / paused.
// Mirrors CrewTaskDetail's wording so a task reads the same everywhere.
const LIFECYCLE_CHIP: Record<Lifecycle, { tone: ChipTone; label: string }> = {
  ready: { tone: "blue", label: "Ready for an agent" },
  working: { tone: "amber", label: "An agent is on it" },
  blocked: { tone: "neutral", label: "Waiting on earlier work" },
  paused: { tone: "neutral", label: "Paused — held back" },
  done: { tone: "green", label: "Done" },
  failed: { tone: "red", label: "Needs another try" },
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

export function TaskCrewActivity({
  taskId,
  repoRoot,
}: {
  /** The BOARD task's id — joined to a crew node via `board_task_id`. */
  taskId: string;
  repoRoot: string;
}) {
  const [nodes, setNodes] = useState<LoopTask[]>([]);
  const [proof, setProof] = useState<Map<string, CrewProof[]>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [arming, setArming] = useState(false);

  const load = useCallback(async () => {
    // Both reads are best-effort: a repo with no crew graph / no goals ledger
    // simply yields empty state, which renders as "Not handed to a crew yet".
    const [view, proofMap] = await Promise.all([
      api.loopReadyView(repoRoot).catch(() => null),
      // Best-effort: a missing goals ledger yields an empty proof map.
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
    () =>
      node
        ? nodes.filter((t) => (t.depends_on ?? []).includes(node.id))
        : [],
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

  // Header is constant so the section never flickers between states.
  const Header = (
    <h3 className="text-[13px] font-semibold text-text-1 mb-3">Agents on this</h3>
  );

  if (!loaded) {
    return (
      <section aria-label="Agents on this task">
        {Header}
        <div className="text-[12px] text-text-5">Checking the crew…</div>
      </section>
    );
  }

  if (!node) {
    return (
      <section aria-label="Agents on this task">
        {Header}
        <div className="text-[12px] text-text-4">
          Not handed to a crew yet — no agent has picked this up.
        </div>
      </section>
    );
  }

  const life = lifecycleOf(node, byId);
  const chip = LIFECYCLE_CHIP[life];
  const agentName = node.agent_kind
    ? agentDisplayLabel(canonicalAgentId(node.agent_kind))
    : null;
  const proofs = proofForCommit(proof, node.commit_sha);
  const best = bestProof(proofs);
  const stamp = relativeTime(node.updated_at);

  // One plain-language status line under the chip. We never show "leased" /
  // "node" / a raw enum — only what a non-engineer cares about.
  let statusLine: string | null = null;
  if (life === "working") {
    statusLine = agentName
      ? `${agentName} is working on this`
      : "An agent is working on this";
    if (stamp) statusLine += ` · started ${stamp}`;
  } else if (life === "done") {
    statusLine = stamp ? `Finished ${stamp}` : "Finished";
  } else if (life === "blocked") {
    statusLine = "Waiting for earlier work to finish before an agent can start";
  } else if (life === "paused") {
    statusLine = "Held back for now — resume it from the crew to continue";
  } else if (life === "ready") {
    statusLine = agentName
      ? `Lined up for ${agentName}`
      : "Lined up — the next free agent will pick it up";
  } else if (life === "failed") {
    statusLine = stamp ? `The last attempt stopped ${stamp}` : null;
  }

  return (
    <section aria-label="Agents on this task">
      {Header}
      <div
        className="rounded-lg border-[0.5px] border-line-soft bg-bg-content px-3.5 py-3"
        style={{ borderLeft: `2px solid ${ACCENT[life]}` }}
      >
        {/* State row — the lifecycle chip + the agent logo + any proof pill. */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={chip.tone} dot dense>
            {chip.label}
          </StatusChip>
          {(life === "working" || life === "ready" || life === "done") &&
          node.agent_kind ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-text-3">
              <AgentBit agentKind={node.agent_kind} size={16} />
              {agentName}
            </span>
          ) : null}
          {best ? <ProofPill proof={best} /> : null}
          {node.commit_sha ? (
            <span className="ml-auto">
              <CommitChip sha={node.commit_sha} />
            </span>
          ) : null}
        </div>

        {statusLine ? (
          <p className="mt-2 text-[12px] text-text-3 leading-snug">{statusLine}</p>
        ) : null}

        {/* When it finished but the checks didn't all pass — say so plainly. */}
        {life === "done" && best && best.verdict !== "verified" ? (
          <p className="mt-1.5 text-[11.5px] text-text-4 leading-snug">
            The code landed but {best.total - best.ok} of {best.total} checks
            didn't pass — open the commit to see what's left.
          </p>
        ) : null}
        {life === "done" && !best ? (
          <p className="mt-1.5 text-[11.5px] text-text-4 leading-snug">
            Delivered, but it wasn't checked against a goal.
          </p>
        ) : null}

        {/* Failed — the error + a one-click re-arm so the crew tries again. */}
        {life === "failed" ? (
          <div className="mt-2">
            {(node.error_message ?? "").trim() ? (
              <p className="text-[11.5px] text-red leading-snug whitespace-pre-wrap">
                {node.error_message?.trim()}
              </p>
            ) : null}
            <Button
              variant="outline"
              size="xs"
              onClick={() => void reArm()}
              disabled={arming}
              className="mt-2 text-[11.5px] text-text-2 hover:text-text-1"
            >
              <RotateCcw className="w-3 h-3" strokeWidth={1.75} aria-hidden />
              {arming ? "Putting it back…" : "Try it again"}
            </Button>
          </div>
        ) : null}

        {/* Dependency context — what this is waiting on, and what it frees up. */}
        {(waitingOn.length > 0 || unblocks.length > 0) && (
          <div className="mt-3 pt-3 border-t-[0.5px] border-line-soft/60 flex flex-col gap-2">
            {waitingOn.length > 0 ? (
              <DepRow label="Waiting on" tasks={waitingOn} byId={byId} />
            ) : null}
            {unblocks.length > 0 ? (
              <DepRow label="Unblocks" tasks={unblocks} byId={byId} />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

// Left-border accent per lifecycle — arctic-blue for ready, amber while
// working, green done, red failed, muted otherwise. Status colours are
// status-only, never affordances.
const ACCENT: Record<Lifecycle, string> = {
  ready: "var(--color-accent)",
  working: "var(--color-amber)",
  done: "var(--color-accent-green)",
  failed: "var(--color-red)",
  blocked: "var(--color-text-5)",
  paused: "var(--color-text-5)",
};

// One "Waiting on" / "Unblocks" row — the label and the related node titles as
// quiet inline chips, each carrying its own finished/in-progress dot so the
// reader sees at a glance whether the blocker is cleared.
function DepRow({
  label,
  tasks,
  byId,
}: {
  label: string;
  tasks: LoopTask[];
  byId: Map<string, LoopTask>;
}) {
  return (
    <div className="flex items-start gap-2 text-[11.5px]">
      <span className="shrink-0 text-text-5 pt-0.5 inline-flex items-center gap-1">
        {label === "Unblocks" ? (
          <ArrowRight className="w-3 h-3" strokeWidth={1.75} aria-hidden />
        ) : null}
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {tasks.map((t) => {
          const done = lifecycleOf(t, byId) === "done";
          return (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 rounded-md bg-bg-2 px-1.5 py-0.5 text-text-3 max-w-[220px]"
              title={t.title}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: done ? "var(--color-accent-green)" : "var(--color-text-5)" }}
                aria-hidden
              />
              <span className="truncate">{t.title || "(untitled)"}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

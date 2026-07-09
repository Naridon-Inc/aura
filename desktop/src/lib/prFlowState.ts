// Parity W8 — agent-driven PR flow state machine.
//
// A PR shepherded by an agent moves through a fixed protocol: gather context,
// draft, get approval, commit, push, open, review, address, merge. This module
// is the *pure* heart of that protocol — a reducer with an explicit transition
// table so every legal hop is auditable and every illegal event is a no-op
// (never a crash, never a silent jump). UI surfaces (PrRailPanel today, a full
// flow timeline later) drive whatever observable subset they can see; the full
// state set documents the protocol itself.
//
// Also here: the PR context builder — a markdown snapshot of branch + changed
// files + recent commits that gets prepended to skill prompts so the agent
// starts grounded instead of re-discovering repo state turn by turn.

import { api } from "./api";

/** Every stage an agent-driven PR can be in, in rough protocol order. */
export type PrFlowStage =
  | "idle"
  | "collecting_context"
  | "drafting"
  | "awaiting_approval"
  | "committing"
  | "pushing"
  | "opening_pr"
  | "pr_open"
  | "requesting_review"
  | "in_review"
  | "addressing_feedback"
  | "merging"
  | "merged"
  | "failed"
  | "cancelled";

/** Events that move the flow forward (or sideways into failed/cancelled). */
export type PrFlowEvent =
  | { type: "START" }
  | { type: "CONTEXT_READY" }
  | { type: "DRAFT_READY" }
  | { type: "APPROVED" }
  | { type: "COMMITTED" }
  | { type: "PUSHED" }
  | { type: "PR_OPENED"; prNumber?: number }
  | { type: "REVIEW_REQUESTED" }
  | { type: "FEEDBACK_RECEIVED" }
  | { type: "FEEDBACK_ADDRESSED" }
  | { type: "MERGE_STARTED" }
  | { type: "MERGED" }
  | { type: "FAIL"; error: string }
  | { type: "CANCEL" }
  | { type: "RESET" };

export type PrFlowState = {
  stage: PrFlowStage;
  /** PR number once known (PR_OPENED), kept through the rest of the flow. */
  prNumber: number | null;
  /** Last FAIL error; cleared on RESET/START. */
  error: string | null;
  /** Stages visited this run, oldest first — cheap audit trail for the UI. */
  history: PrFlowStage[];
};

export const PR_FLOW_INITIAL: PrFlowState = {
  stage: "idle",
  prNumber: null,
  error: null,
  history: [],
};

// The transition table: stage → which events it accepts and where they lead.
// FAIL, CANCEL and RESET are handled globally in the reducer (any non-terminal
// stage can fail or cancel; anything can reset), so rows only list the
// forward-motion events. An event missing from a row is illegal there → no-op.
const TRANSITIONS: Partial<Record<PrFlowStage, Partial<Record<PrFlowEvent["type"], PrFlowStage>>>> = {
  idle: { START: "collecting_context" },
  collecting_context: { CONTEXT_READY: "drafting" },
  drafting: { DRAFT_READY: "awaiting_approval" },
  awaiting_approval: { APPROVED: "committing" },
  committing: { COMMITTED: "pushing" },
  pushing: { PUSHED: "opening_pr" },
  opening_pr: { PR_OPENED: "pr_open" },
  pr_open: { REVIEW_REQUESTED: "requesting_review", MERGE_STARTED: "merging" },
  requesting_review: { FEEDBACK_RECEIVED: "in_review" },
  in_review: { FEEDBACK_RECEIVED: "addressing_feedback", MERGE_STARTED: "merging" },
  addressing_feedback: { FEEDBACK_ADDRESSED: "in_review", MERGE_STARTED: "merging" },
  merging: { MERGED: "merged" },
};

const TERMINAL: ReadonlySet<PrFlowStage> = new Set(["merged", "failed", "cancelled"]);

/** Pure reducer. Illegal events return the state unchanged (same reference). */
export function prFlowReduce(state: PrFlowState, event: PrFlowEvent): PrFlowState {
  if (event.type === "RESET") {
    return PR_FLOW_INITIAL;
  }
  if (event.type === "FAIL") {
    if (TERMINAL.has(state.stage)) return state;
    return {
      ...state,
      stage: "failed",
      error: event.error,
      history: [...state.history, state.stage],
    };
  }
  if (event.type === "CANCEL") {
    if (TERMINAL.has(state.stage) || state.stage === "idle") return state;
    return {
      ...state,
      stage: "cancelled",
      history: [...state.history, state.stage],
    };
  }

  const next = TRANSITIONS[state.stage]?.[event.type];
  if (!next) return state;

  return {
    stage: next,
    prNumber: event.type === "PR_OPENED" && event.prNumber != null ? event.prNumber : state.prNumber,
    error: event.type === "START" ? null : state.error,
    history: [...state.history, state.stage],
  };
}

/** Short human label for a stage — status pills, tile subtitles. */
export function describePrFlowStage(stage: PrFlowStage): string {
  switch (stage) {
    case "idle": return "Idle";
    case "collecting_context": return "Collecting context…";
    case "drafting": return "Drafting…";
    case "awaiting_approval": return "Awaiting approval";
    case "committing": return "Committing…";
    case "pushing": return "Pushing…";
    case "opening_pr": return "Opening PR…";
    case "pr_open": return "PR open";
    case "requesting_review": return "Requesting review…";
    case "in_review": return "In review";
    case "addressing_feedback": return "Addressing feedback…";
    case "merging": return "Merging…";
    case "merged": return "Merged";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

// ---------------------------------------------------------------------------
// PR context — the grounding snapshot prepended to skill prompts.
// ---------------------------------------------------------------------------

export type PrContext = {
  /** Current branch name, or null when detection failed. */
  branch: string | null;
  /** Base branch the PR targets (best-effort; null when unknown). */
  baseBranch: string | null;
  /** Paths with uncommitted changes (staged or not). */
  changedFiles: string[];
  /** Recent commit subjects, newest first, `<short-sha> <subject>` form. */
  recentCommits: string[];
};

const MAX_CHANGED_FILES = 40;
const MAX_COMMITS = 10;

/**
 * Render a PrContext as the markdown block skill prompts embed. Pure — takes
 * pre-fetched data so it's trivially testable and reusable from anywhere that
 * already holds repo state.
 */
export function buildPrContextMarkdown(ctx: PrContext): string {
  const lines: string[] = ["## Repo context"];
  if (ctx.branch) {
    lines.push(`- Branch: \`${ctx.branch}\`${ctx.baseBranch ? ` (target: \`${ctx.baseBranch}\`)` : ""}`);
  }
  if (ctx.changedFiles.length > 0) {
    const shown = ctx.changedFiles.slice(0, MAX_CHANGED_FILES);
    lines.push(`- Uncommitted changes (${ctx.changedFiles.length} file${ctx.changedFiles.length === 1 ? "" : "s"}):`);
    for (const f of shown) lines.push(`  - \`${f}\``);
    if (ctx.changedFiles.length > shown.length) {
      lines.push(`  - …and ${ctx.changedFiles.length - shown.length} more`);
    }
  } else {
    lines.push("- Working tree clean (no uncommitted changes)");
  }
  if (ctx.recentCommits.length > 0) {
    lines.push("- Recent commits:");
    for (const c of ctx.recentCommits.slice(0, MAX_COMMITS)) lines.push(`  - ${c}`);
  }
  return lines.join("\n");
}

/**
 * Fetch live repo state for the context block. Each probe is independent and
 * best-effort — a failed git call degrades that section to empty rather than
 * sinking the whole prompt build.
 */
export async function collectPrContext(repoRoot: string): Promise<PrContext> {
  const [branches, status, commits] = await Promise.all([
    api.gitBranches(repoRoot).catch(() => []),
    api.gitStatusV2(repoRoot).catch(() => []),
    api.gitRecentCommits(repoRoot, MAX_COMMITS).catch(() => []),
  ]);

  const current = branches.find((b) => b.is_current)?.name ?? null;
  // Best-effort base: prefer a local main/master that isn't the current branch.
  const base =
    branches.find((b) => !b.is_remote && b.name !== current && (b.name === "main" || b.name === "master"))?.name ??
    null;

  return {
    branch: current,
    baseBranch: base,
    changedFiles: status.map((e) => e.path),
    recentCommits: commits.map((c) => `${c.sha.slice(0, 8)} ${c.subject}`),
  };
}

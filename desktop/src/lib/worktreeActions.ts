// Contextual actions for a worktree copy — Aura's answer to Conductor's
// per-copy footer. A copy doesn't get a generic "Open" button; it gets the ONE
// thing its real git state is asking for right now: uncommitted work wants a
// commit+push, a copy behind its remote wants a pull, local commits with no PR
// want a PR opened, an existing PR wants a jump to it — and a clean, in-sync
// copy shows nothing at all (that's a valid, calm state, not a gap).
//
// The judgement calls — a commit message, a PR title + body — are handed to
// Aura's chat, which opens IN THIS COPY'S OWN WORKSPACE and runs the work
// (auto-sent), so the user watches it happen instead of typing gh commands.
// This file is pure: a state→action derivation, a thin event bridge onto the
// existing "hand to agent" seam, and the plain-language prompts it seeds.

import { openExternal } from "./openExternal";

/** The real git facts a copy's primary action is derived from. `dirty` =
 *  uncommitted working-tree changes; `ahead`/`behind` are vs the upstream
 *  (both 0 when there is none); `pr` is the copy's open/merged PR if the
 *  badge knows one. */
export type WtGitState = {
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  pr?: { number: number; state: string } | null;
};

export type WtActionKind =
  | "commit_push"
  | "pull"
  | "create_pr"
  | "open_pr"
  | "none";

export type WtAction = { kind: WtActionKind; label: string };

/** The single primary action, most-urgent first:
 *  1. uncommitted work           → Commit & push
 *  2. behind the remote          → Pull
 *  3. local commits, no PR yet   → Create PR
 *  4. a PR already exists         → open it (#number)
 *  5. clean + in sync            → nothing (a copy at rest shows no button). */
export function deriveWtAction(s: WtGitState): WtAction {
  if (s.dirty) return { kind: "commit_push", label: "Commit & push" };
  if (s.hasUpstream && s.behind > 0) return { kind: "pull", label: "Pull" };
  if (s.pr) return { kind: "open_pr", label: `#${s.pr.number}` };
  if (s.ahead > 0) return { kind: "create_pr", label: "Create PR" };
  return { kind: "none", label: "" };
}

/** Hand a plain-language instruction to Aura's chat. Reuses the SAME
 *  `aura:hand-task-to-agent` bridge the "Hand to agent" button dispatches; the
 *  App-level handler spawns a coding agent seeded with `prompt` and auto-sends
 *  it. `cwd` pins the agent to THIS worktree so it acts on the right branch,
 *  never whatever copy happens to be focused. */
export function askAuraToRun(cwd: string, label: string, prompt: string): void {
  window.dispatchEvent(
    new CustomEvent("aura:hand-task-to-agent", {
      detail: { agent: "claude", label, prompt, cwd },
    }),
  );
}

/** Open a copy's existing PR in the real browser, from the repo's origin +
 *  the PR number. Silently no-ops if the origin can't be resolved. */
export async function openPr(origin: string, prNumber: number): Promise<void> {
  const base = originToHttpBase(origin);
  if (!base) return;
  await openExternal(`${base}/pull/${prNumber}`);
}

/** `git@github.com:owner/repo.git` or `https://github.com/owner/repo.git` →
 *  `https://github.com/owner/repo`. Returns "" for anything unrecognised. */
export function originToHttpBase(origin: string): string {
  const o = (origin || "").trim().replace(/\.git$/, "");
  if (!o) return "";
  const ssh = o.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(o)) return o;
  const scp = o.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return "";
}

export function commitPushPrompt(branch: string): string {
  return (
    `Commit and push the current changes on branch \`${branch}\`. ` +
    `Write a clear, conventional commit message that describes what actually ` +
    `changed and why, then push (set the upstream if the branch has none). ` +
    `Report the result briefly when done.`
  );
}

export function pullPrompt(branch: string): string {
  return (
    `Pull the latest changes into branch \`${branch}\` and reconcile any ` +
    `conflicts sensibly. Report what came in when done.`
  );
}

// The whole "open a pull request" job, start to finish, with no stops to ask.
// Clicking Create PR is the decision — so the prompt carries every step the
// user would otherwise have had to do by hand first: look at what's actually
// changed (including work that isn't committed yet), run the checks, then open
// the PR. It ends at a real PR URL, not a half-done branch.
export function createPrPrompt(
  branch: string,
  title: string,
  draft = false,
): string {
  return [
    `Open a${draft ? " draft" : ""} pull request for the current branch \`${branch}\`${title ? ` ("${title}")` : ""}. Do the whole job yourself. Don't stop to ask me to confirm the steps.`,
    ``,
    `Look at what actually changed first. Don't just list files:`,
    `1. Find the base branch with \`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name\`.`,
    `2. Check the working tree with \`git status --porcelain\` and \`git diff\`. If there are uncommitted changes that belong in this PR, commit them with a clear, accurate message describing what changed and why. Leave anything that's clearly unrelated (scratch files, local config) alone and say so.`,
    `3. Read the branch's own diff against the base: \`git diff <base>...HEAD --stat\` then the parts that matter, and \`git log <base>..HEAD\` so the description captures the real intent.`,
    ``,
    `Then run the checks, and don't skip them:`,
    `4. \`aura pr-review --base <that base> --json\`. The semantic diff: changed logic, blast radius (what depends on what changed), risk score, and any issues it flags.`,
    `5. \`aura prove\`, which user-facing behaviours are actually wired end-to-end and which still have gaps.`,
    ``,
    `Then open it:`,
    `- Write a clear title and a plain-language description of WHAT changed and WHY, with a short "Blast radius / risk" note and a reviewer checklist.`,
    `- If the checks surfaced real problems, list them first under "⚠ Issues to resolve" and say whether they should block the PR. Real problems don't stop you opening it. They go in the description where a reviewer will see them.`,
    `- Push the branch (set the upstream if it has none), then create the PR with \`gh pr create\`${draft ? " --draft" : ""}. If a PR already exists for this branch, update it instead of opening a second one.`,
    `- Finish with the PR URL and two or three lines on what you did.`,
  ].join("\n");
}

/**
 * The background-job id for "update this pull request with Aura".
 *
 * Scoped to the PR number, because three surfaces offer this and they don't
 * always mean the same pull request: the header button and the review rail
 * both act on the CURRENT BRANCH's PR, while an open PR tab acts on whichever
 * PR you're reading. On a bare `"update-pr"` id, updating #400 from a tab made
 * the rail spin "Updating…" over #422. Scoped, the three share one run when
 * they mean one PR and stay silent when they don't.
 */
export function updatePrJobId(prNumber: number): string {
  return `update-pr:${prNumber}`;
}

/**
 * The hover for every "update this PR" control.
 *
 * Three surfaces offer the action and each had written its own: "Aura
 * re-reviews the new commits and rewrites PR #400 — in the background, without
 * touching your chat", "Aura re-reviews the branch and rewrites the title +
 * description to match what it does now — in the background", and "Aura
 * reconciles the PR title + description with what actually shipped — in the
 * background". Three descriptions of one `updatePrPrompt` run, and the third
 * said "reconciles", which is a word for the machinery rather than for what a
 * person gets.
 *
 * It leads with the fact that this happens ON PRESS, because the thing this
 * panel got wrong for a while was implying the opposite.
 */
export const UPDATE_PR_HINT =
  "Rewrites the title and description to match what the branch does now. " +
  "Aura re-reads the new commits first. Runs in the background; nothing " +
  "happens until you press it.";

// Refresh an EXISTING pull request after more work landed on its branch. The
// PR's diff already tracks the branch head on every push — this is about the
// prose and the review keeping up: re-review the new commits, rewrite the
// title/description to match what the branch now does, and leave a review note.
export function updatePrPrompt(branch: string, prNumber: number): string {
  return [
    `Update the existing pull request #${prNumber} for branch \`${branch}\`. More work has landed since it was opened.`,
    ``,
    `Review what actually changed:`,
    `1. Find the base branch with \`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name\`.`,
    `2. Push the branch if it has unpushed commits so the PR diff reflects the latest (the diff auto-tracks the branch head. You only need to push).`,
    `3. Run \`aura pr-review --base <that base> --json\` for the current semantic diff, blast radius, risk score, and any new issues.`,
    `4. Read the PR's current title/body with \`gh pr view ${prNumber} --json title,body\` so you refresh rather than clobber it.`,
    ``,
    `Then:`,
    `- Rewrite the title + description to match what the branch does NOW, in plain language (WHAT changed and WHY), refreshing the "Blast radius / risk" note and reviewer checklist.`,
    `- If the review surfaced real problems, list them first under "⚠ Issues to resolve" and say whether they should block merging.`,
    `- Apply the update with \`gh pr edit ${prNumber} --title <…> --body <…>\`, then print the PR URL.`,
  ].join("\n");
}

// ── Inline-in-chat prompts ────────────────────────────────────────────────
//
// These turn what used to open a separate workpane/tab (Safety check, Goals,
// Attestations, Resolve conflicts) into a prompt Aura runs in the chat the
// user is already watching. Aura owns the real tools (`aura pr-review`,
// `aura prove`, `aura attest`, the conflict tools) via MCP, so it does the
// work and reports the verdict in plain language inline — no page to open.

/** Ask Aura to run a semantic safety check on the current changes, in chat. */
export function safetyCheckPrompt(): string {
  return [
    `Run a safety check on my current changes. Use \`aura pr-review\` against the branch's base.`,
    `Tell me here, in plain language: any bugs, security issues, architecture/layer drift, or anything that doesn't match what I asked for.`,
    `Do the analysis yourself and report inline. Don't open a separate tab.`,
  ].join("\n");
}

/** Ask Aura to prove the branch's goals, in chat. */
export function proveGoalsPrompt(): string {
  return [
    `Prove the goals for this branch. Run \`aura prove\` (or \`aura goal-trace\`).`,
    `Tell me here which user-facing behaviors are actually wired up end-to-end and which still have gaps, in plain language.`,
    `Report inline. Don't open a separate tab.`,
  ].join("\n");
}

/** Ask Aura to summarize attestations/provenance for recent work, in chat. */
export function attestPrompt(): string {
  return [
    `Show the attestations for my recent work. Run \`aura attest\` (list + verify).`,
    `Summarize here what's signed and verified, and flag anything unsigned or failing verification.`,
    `Report inline. Don't open a separate tab.`,
  ].join("\n");
}

/** Ask Aura to resolve the current merge conflicts, in chat. */
export function resolveConflictsPrompt(): string {
  return [
    `Resolve the current merge conflicts on this branch using Aura's conflict tools.`,
    `Go file by file, choosing ours / theirs / a merged result as appropriate. Ask me first if a choice looks risky or loses work.`,
    `Then continue the merge and walk me through what you did, here in chat.`,
  ].join("\n");
}

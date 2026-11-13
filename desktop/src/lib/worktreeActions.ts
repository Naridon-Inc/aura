// Contextual actions for a worktree copy — the
// per-copy footer. A copy doesn't get a generic "Open" button; it gets the ONE
// thing its real git state is asking for right now: uncommitted work wants a
// commit+push, a copy behind its remote wants a pull, local commits with no PR
// want a PR opened, an existing PR wants a jump to it — and a clean, in-sync
// copy shows nothing at all (that's a valid, calm state, not a gap).
//
// The judgement calls — a commit message, a PR title + body — go to a new
// chat (lib/gitChat) that runs the work where the user can watch it. This
// file is pure: a state→action derivation and the links and ids those
// actions share.

import { openExternal } from "./openExternal";
import { originText } from "./originUrl";

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

/** Open a copy's existing PR in the real browser, from the repo's origin +
 *  the PR number. Silently no-ops if the origin can't be resolved. */
export async function openPr(origin: string, prNumber: number): Promise<void> {
  const base = originToHttpBase(origin);
  if (!base) return;
  await openExternal(`${base}/pull/${prNumber}`);
}

/** `git@github.com:owner/repo.git` or `https://github.com/owner/repo.git` →
 *  `https://github.com/owner/repo`. Returns "" for anything unrecognised. */
export function originToHttpBase(origin: unknown): string {
  const o = originText(origin).replace(/\.git$/, "");
  if (!o) return "";
  const ssh = o.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(o)) return o;
  const scp = o.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return "";
}

/**
 * The id the "update this pull request with Aura" chat is tracked under.
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
 * background". Three descriptions of one update, and the third
 * said "reconciles", which is a word for the machinery rather than for what a
 * person gets.
 *
 * It leads with the fact that this happens ON PRESS, because the thing this
 * panel got wrong for a while was implying the opposite.
 */
export const UPDATE_PR_HINT =
  "Rewrites the title and description to match what the branch does now. " +
  "Opens a chat that reads the new commits first; nothing happens until you " +
  "press it.";

// ── Inline-in-chat prompt ─────────────────────────────────────────────────
//
// The Trace view's Safety check, asked in the chat the user is already
// watching: Aura owns the review tool via MCP, so it does the work and reports
// the verdict in plain language inline — no page to open.

/** Ask Aura to run a semantic safety check on the current changes, in chat. */
export function safetyCheckPrompt(): string {
  return [
    `Run a safety check on my current changes. Use \`aura pr-review\` against the branch's base.`,
    `Tell me here, in plain language: any bugs, security issues, architecture/layer drift, or anything that doesn't match what I asked for.`,
    `Do the analysis yourself and report inline. Don't open a separate tab.`,
  ].join("\n");
}

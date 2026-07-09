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

export function createPrPrompt(
  branch: string,
  title: string,
  draft = false,
): string {
  return (
    `Open a${draft ? " draft" : ""} pull request for branch \`${branch}\`` +
    (title ? ` ("${title}")` : "") +
    `. Push the branch first if it isn't pushed yet, then create the PR with ` +
    `\`gh\` — a clear title and a description that summarises what changed and ` +
    `why. Share the PR link when it's open.`
  );
}

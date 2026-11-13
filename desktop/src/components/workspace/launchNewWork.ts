// The four ways new work starts, once the dialog has its answers.
//
// On a machine: the copy is made over there and the agent runs there, under
// tmux, so the work outlives this window, this wifi and this laptop's lid.
// Queued: the objective goes to the always-on runner as a submitted task; no
// copy is made here and a runner drains it.
// In a separate copy: a git worktree, the only way to have two branches of one
// repository checked out at once (a folder has exactly one HEAD).
// In this folder: a plain `git checkout -b`, which needs a clean tree — git
// refuses to carry uncommitted work onto a branch that forks elsewhere, and
// we would rather say that in words than let the command fail underneath.
// Started from a pull request in this repo, either local start goes on the
// pull request's own branch instead of a new one, so pushes land on it.
//
// Local starts provision the checkout only. App opens Aura chat in it on
// `aura:workspace-launched`, which is also where the objective, model and
// effort are applied: the chat they belong to does not exist until App has
// switched into the new folder.

import {
  api,
  type CloudSendResult,
  type GitBranchInfo,
  type ReasoningEffort,
} from "../../lib/api";
import { newCloudThreadKey } from "../../lib/cloudJobs";
import type { SelectedModel } from "../../lib/modelCatalog";
import { trackFeature } from "../../lib/track";
import { launchWorkspace } from "../../lib/workspaceCreateStore";
import { workBranchName } from "../../lib/workNames";

/** The agent named when something has to name one: the queue (which runs a
 *  CLI, not Aura chat) and a machine start with no model pinned. */
export const DEFAULT_AGENT_ID = "claude";

export type NewWorkOutcome =
  | { kind: "local"; path: string }
  | { kind: "machine"; machineId: string; worktreePath: string | null }
  | { kind: "queued"; threadKey: string; result: CloudSendResult }
  | { kind: "refused"; message: string };

/** What App needs to open the new work and hand it the objective. */
export type LaunchedDetail = {
  createMore: boolean;
  mission: string;
  model: SelectedModel | null;
  effort: ReasoningEffort | null;
};

/** Branch names already in use — every local branch plus each remote's last
 *  segment — so the auto-namer never re-picks one. `git worktree add -b` on a
 *  taken name fails, and on a hidden, generated name that reads as nothing
 *  happening. */
export function takenBranchNames(branches: GitBranchInfo[]): Set<string> {
  const taken = new Set<string>();
  for (const b of branches) {
    const name = b.name.trim();
    if (!name) continue;
    taken.add(name);
    const leaf = name.split("/").pop();
    if (leaf) taken.add(leaf);
  }
  return taken;
}

/** A new branch named after the objective, read against the live branch list
 *  at the click so a name minted since the dialog opened is still excluded.
 *  A failed read is a blind pick; git still guards the name. */
export async function freshBranchName(repoRoot: string, mission: string): Promise<string> {
  let taken = new Set<string>();
  try {
    taken = takenBranchNames(await api.gitBranches(repoRoot));
  } catch {
    /* branch read failed — git refuses a taken name anyway */
  }
  return workBranchName(mission, taken);
}

export async function startOnMachine(input: {
  repoRoot: string;
  mission: string;
  machineId: string;
  projectPath: string | null;
  agentId: string;
}): Promise<NewWorkOutcome> {
  trackFeature("workspace_place_launch");
  const branch = await freshBranchName(input.repoRoot, input.mission);
  const { errors, worktreePath } = await launchWorkspace({
    repoRoot: input.repoRoot,
    branch,
    agents: [{ agentId: input.agentId }],
    prompt: input.mission,
    machineId: input.machineId,
    remoteProjectPath: input.projectPath,
  });
  // The worktree exists (a total failure throws), so this is the work with a
  // gap in it: say which, and leave the dialog up.
  if (errors.length > 0) return { kind: "refused", message: errors.join("; ") };
  return { kind: "machine", machineId: input.machineId, worktreePath: worktreePath || null };
}

export async function queueForRunner(input: {
  repoRoot: string;
  mission: string;
}): Promise<NewWorkOutcome> {
  trackFeature("workspace_cloud_launch");
  // Every send opens a conversation, even one nobody replies to, so the job
  // has a place to be read the moment it exists.
  const threadKey = newCloudThreadKey();
  const result = await api.loopCloudSend(
    input.repoRoot,
    input.mission,
    DEFAULT_AGENT_ID,
    undefined,
    threadKey,
  );
  window.dispatchEvent(
    new CustomEvent("aura:cloud-task-created", {
      detail: { repoRoot: input.repoRoot, id: result.id, status: result.status },
    }),
  );
  return { kind: "queued", threadKey, result };
}

export async function startLocally(input: {
  repoRoot: string;
  separate: boolean;
  /** The Create-from choice, else HEAD. */
  startPoint: string;
  /** A pull request's own branch to work on, rather than a new branch. */
  continues?: { branch: string; base: string | null } | null;
  launched: LaunchedDetail;
}): Promise<NewWorkOutcome> {
  const { repoRoot, startPoint, launched } = input;
  const continues = input.continues?.branch.trim() ? input.continues : null;
  trackFeature("workspace_launch");
  const branch = continues ? continues.branch.trim() : await freshBranchName(repoRoot, launched.mission);
  if (!input.separate) {
    // `catch(() => ({}))` answered "the tree is clean" whenever the status
    // read failed, walking straight past the guard into the `checkout -b` it
    // exists to keep you out of. A read we couldn't do is not a clean tree.
    const dirty = await api.gitStatus(repoRoot).catch(() => null);
    if (dirty === null) {
      return {
        kind: "refused",
        message:
          "Couldn’t check whether this folder has changes you haven’t " +
          "committed yet, so it isn’t safe to start the new work here. " +
          "Try again, or turn on Separate copy to start it beside what’s " +
          "here instead.",
      };
    }
    if (Object.keys(dirty).length > 0) {
      return {
        kind: "refused",
        message:
          "This folder has changes you haven’t committed yet. Commit them " +
          "first, or turn on Separate copy to start the new work beside " +
          "them without disturbing what’s here.",
      };
    }
    if (continues) {
      await api.gitContinueBranchHere(repoRoot, branch);
    } else {
      // Fork from what Create-from says, not from wherever HEAD is: standing
      // on `feat/x` and asking to start from `main` has to mean main.
      if (startPoint && startPoint !== "HEAD") {
        await api.gitCheckout(repoRoot, startPoint);
      }
      await api.gitCreateBranch(repoRoot, branch);
    }
    // The branch chip, the sidebar badges and the Changes rail read git on
    // this event; without it they keep naming the branch we left.
    window.dispatchEvent(new Event("aura:git-changed"));
    announceLaunch(repoRoot, repoRoot, launched);
    return { kind: "local", path: repoRoot };
  }
  // No agents in the manifest: the copy's working surface is Aura chat, which
  // runs in-process rather than as a terminal.
  const { worktreePath } = await launchWorkspace({
    repoRoot,
    branch,
    startPoint,
    agents: [],
    continueBranch: continues ? { base: continues.base } : null,
  });
  announceLaunch(repoRoot, worktreePath, launched);
  return { kind: "local", path: worktreePath };
}

/** The sidebar lists repositories App has opened, and a launch doesn't touch
 *  that list. Announcing it lets App promote the repository, refresh its
 *  copies so the new one has a row, and (unless creating more) switch into
 *  it with the objective as the chat's first message. */
function announceLaunch(repoRoot: string, worktreePath: string, launched: LaunchedDetail) {
  window.dispatchEvent(
    new CustomEvent("aura:workspace-launched", {
      detail: { repoRoot, worktreePath, ...launched },
    }),
  );
}

// The card a workspace row shows on hover: the same preview the Workspaces
// page draws for that workspace, fed from the same model, with its workflow
// buttons live. Its body mounts only while the card is open, so the git and
// pull-request reads behind it happen for the row under the pointer, not for
// every row in the list.

import { HoverCardContent } from "../../ui/hover-card";
import { WorkspacePreviewCard } from "../../ui/workspace-preview-card";
import type { GitWorkflowAction } from "../../ui/git-workflow";
import { buildCopies, type CopyAgent } from "../../workspaces/workspacesModel";
import { useFleetGit } from "../../workspaces/useFleetGit";
import { copyOverview, copyPr } from "../../workspaces/workspacesOverview";
import { runWorkspaceAction } from "../../workspaces/fleetActions";
import { pickBranchPr } from "../../../lib/prsCache";
import { letterMark } from "../../../lib/monogram";
import type { WorktreeRef } from "../../../lib/workspaceRef";
import type { RosterEnv } from "./rosterTypes";

export type CopyHoverTarget = {
  worktree: WorktreeRef;
  root: string;
  repositoryName: string;
  emoji?: string;
  title: string;
};

function CopyPreviewBody({ target, env }: { target: CopyHoverTarget; env: RosterEnv }) {
  const { worktree: w, root } = target;
  const agents: CopyAgent[] = env.agentsForPath(w.path).map((a) => ({
    agentId: a.agentId,
    label: a.agentLabel,
    attention: a.attention,
  }));
  const [built] = buildCopies({
    projects: [
      {
        id: root,
        name: target.repositoryName,
        emoji: target.emoji,
        letter: letterMark(target.repositoryName),
      },
    ],
    worktreesByRoot: { [root]: [w] },
    badgeByPath: env.badgeByPath ?? {},
    agentsByPath: new Map([[w.path, agents]]),
    activePath: env.activePath,
  });
  // The list's own name for the row wins: a renamed workspace is called by
  // its new name on the card too.
  const copy = { ...built!, title: target.title };
  const { git, prsByRoot } = useFleetGit([copy]);
  const rich = pickBranchPr(prsByRoot.get(root) ?? [], w.branch || null);
  const pr = copyPr(copy, rich);
  const overview = copyOverview({
    copy,
    nowMs: env.now,
    pr: rich,
    git: git.get(w.path),
    archived: typeof env.custom[w.path]?.archived === "number",
  });
  const open = (path: string) => env.actions.onOpenWorktree?.(path);
  const run = (action: GitWorkflowAction) =>
    void runWorkspaceAction({ copy, pr, action, onOpen: open });
  return (
    <WorkspacePreviewCard
      workspace={overview}
      onAction={run}
      onOpenPr={() => run("open-pr")}
    />
  );
}

/** Placed inside the row's `HoverCard`, beside its trigger. */
export function CopyHoverPreview({
  target,
  env,
}: {
  target: CopyHoverTarget;
  env: RosterEnv;
}) {
  return (
    <HoverCardContent
      side="right"
      align="start"
      sideOffset={10}
      collisionPadding={12}
      className="ui-workspace-hover"
    >
      <CopyPreviewBody target={target} env={env} />
    </HoverCardContent>
  );
}

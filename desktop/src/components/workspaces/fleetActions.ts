// What each button on a Workspaces row does. Every arm is a capability the app
// already has somewhere else — the hover card, the review header, the PR
// dialog — reached from here with the copy's own path, so an action always
// lands on the copy whose row was clicked and never on whichever one is open.

import type { GitWorkflowAction } from "../ui/git-workflow";
import { api } from "../../lib/api";
import { gitTargetSync } from "../../lib/branchSync";
import { runGitChat } from "../../lib/gitChat";
import { invalidatePrList } from "../../lib/prsCache";
import { prMerge } from "../../lib/prApi";
import { openExternal } from "../../lib/openExternal";
import { setWorkspaceArchived } from "../../lib/workspaceCustomization";
import { toast } from "../../lib/toast";
import { askConfirm } from "../ui/ask";
import { originToHttpBase } from "../../lib/worktreeActions";
import type { CopyPr } from "./workspacesOverview";
import type { WorkspaceCopy } from "./workspacesModel";

async function repoWebBase(path: string): Promise<string> {
  try {
    return originToHttpBase(await api.gitRemoteOrigin(path));
  } catch {
    return "";
  }
}

async function openPrPage(copy: WorkspaceCopy, pr: CopyPr | null, suffix = "") {
  if (!pr) return;
  if (pr.url) return openExternal(`${pr.url}${suffix}`);
  const base = await repoWebBase(copy.path);
  if (base) await openExternal(`${base}/pull/${pr.number}${suffix}`);
}

function failed(what: string, err: unknown) {
  toast.danger(what, err instanceof Error ? err.message : String(err));
}

export async function runWorkspaceAction(input: {
  copy: WorkspaceCopy;
  pr: CopyPr | null;
  action: GitWorkflowAction;
  onOpen: (path: string) => void;
}): Promise<void> {
  const { copy, pr, action } = input;
  const branch = copy.branch;
  switch (action) {
    case "create-pr":
    case "create-draft-pr": {
      // A new chat for that copy opens the pull request, as the header does.
      const sync = await gitTargetSync(copy.path, null).catch(() => null);
      void runGitChat(copy.path, "create-pr", {
        action: "create-pr",
        branch,
        remote: sync?.remote || "origin",
        target: sync?.target || "main",
        draft: action === "create-draft-pr",
      });
      return;
    }
    case "create-pr-manually": {
      // "Manually" is the repository's own compare page, where the author
      // writes the PR by hand.
      const base = await repoWebBase(copy.path);
      if (base) await openExternal(`${base}/compare/${encodeURIComponent(branch)}?expand=1`);
      else toast.warning("This copy has no GitHub remote to open a pull request on.");
      return;
    }
    case "commit-push":
      void runGitChat(copy.path, "commit-push", { action: "commit-push" });
      return;
    case "push":
      try {
        await api.gitPush(copy.path, true);
        window.dispatchEvent(new CustomEvent("aura:git-changed"));
      } catch (err) {
        failed("Push failed", err);
      }
      return;
    case "pull":
      try {
        await api.gitPull(copy.path);
        window.dispatchEvent(new CustomEvent("aura:git-changed"));
      } catch (err) {
        failed("Pull failed", err);
      }
      return;
    case "sync":
      void runGitChat(copy.path, "incompatible", { action: "resolve-incompatible" });
      return;
    case "resolve-conflicts":
      void runGitChat(copy.path, "resolve", { action: "resolve-local-conflicts" });
      return;
    case "merge": {
      if (!pr) return;
      const ok = await askConfirm({
        title: `Merge #${pr.number} into its base branch?`,
        body: "It is squashed into one commit. The branch stays.",
        confirmLabel: "Merge",
      });
      if (!ok) return;
      try {
        await prMerge(copy.path, pr.number, "squash", false);
        await invalidatePrList(copy.root).catch(() => {});
        window.dispatchEvent(new CustomEvent("aura:git-changed"));
        toast.success(`Merged #${pr.number}`);
      } catch (err) {
        failed(`Could not merge #${pr.number}`, err);
      }
      return;
    }
    case "archive":
      setWorkspaceArchived(copy.path, true);
      return;
    case "open-pr":
    case "ready-for-review":
    case "review":
    case "approve-pr":
      await openPrPage(copy, pr);
      return;
    case "view-checks":
    case "view-logs":
    case "fix-checks":
      await openPrPage(copy, pr, "/checks");
      return;
    case "address-comments":
      await openPrPage(copy, pr, "/files");
      return;
    case "continue":
      input.onOpen(copy.path);
      return;
    case "cancel-merge":
    case "enable-auto-merge":
    case "disable-auto-merge":
      // Rows never offer these: the workflow says `canAutoMerge: false` and
      // never enters `queued`, because the app cannot drive a merge queue.
      return;
  }
}

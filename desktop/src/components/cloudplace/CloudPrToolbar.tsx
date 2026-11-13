// The pull request row at the top of a cloud workspace's right panel: the
// branch's pull request on GitHub, or "No PR open" and Create PR.
//
// Read by the server with the org's GitHub App and opened as the member who
// clicks, with their own GitHub (cloudPullRequest), so it works the same for
// a workspace on one of the org's machines and one the cloud runs. A member
// who hasn't connected their GitHub is sent to Settings → Git → Your GitHub.
// Merging, fixing checks and answering review open the pull request on
// GitHub: those happen there, as the person, under the repository's own
// rules about who may.

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, ListChecks } from "lucide-react";

import { openYourGithub } from "../../lib/cloudMyGithub";
import { setCloudNotice } from "../../lib/cloudPlace";
import {
  cloudPrApi,
  createRefusal,
  prWorkflow,
  type BranchStanding,
  type CloudPullRequestRead,
} from "../../lib/cloudPullRequest";
import { cloudProblem } from "../../lib/cloudWorkspacesApi";
import { openExternal } from "../../lib/openExternal";
import { Button } from "../ui/button";
import {
  GitWorkflowToolbar,
  type GitWorkflowAction,
  type GitWorkflowState,
} from "../ui/git-workflow";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { viewKey } from "./cloudPlaceKeep";
import { useKeptView } from "./useKeptView";

/** GitHub works out mergeability and checks on its own time; an open panel
 *  asks again this often. */
const READ_EVERY_MS = 30_000;

export function useWorkspacePullRequest(id: string, branch: string | null, tick = 0) {
  const [read, keepRead] = useKeptView<CloudPullRequestRead | null>(viewKey("ws-pr", id, branch), null);
  const [failed, setFailed] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const reload = useCallback(() => setAgain((n) => n + 1), []);
  const set = useCallback((r: CloudPullRequestRead) => keepRead(() => r), [keepRead]);
  useEffect(() => {
    let live = true;
    const ask = () =>
      cloudPrApi
        .read(id, branch)
        .then((r) => {
          if (!live) return;
          keepRead(() => r);
          setFailed(null);
        })
        .catch((e) => {
          if (live) setFailed(cloudProblem(e).message);
        });
    void ask();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void ask();
    }, READ_EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id, branch, tick, again, keepRead]);
  return { read, failed, reload, set };
}

export function CloudPrToolbar({
  workspaceId,
  branch,
  standing = null,
  onPush,
  onArchive,
  tick = 0,
}: {
  workspaceId: string;
  /** The branch the workspace works on, when this laptop knows it better
   *  than the workspace row does (a machine's worktree). */
  branch: string | null;
  /** Where the branch stands on the machine, when it can be read. */
  standing?: BranchStanding;
  /** Push the branch from where it lives; absent where nothing here can. */
  onPush?: () => Promise<unknown>;
  /** Archive the workspace, once its pull request is done. */
  onArchive?: () => void;
  /** Bumped by the panel's own refresh. */
  tick?: number;
}) {
  const pr = useWorkspacePullRequest(workspaceId, branch, tick);
  const [busy, setBusy] = useState<GitWorkflowState | null>(null);
  const workflow = prWorkflow(pr.read, { failed: pr.failed, busy, standing });
  const url = pr.read?.pr?.url ?? null;
  const openPr = (suffix = "") => {
    if (url) void openExternal(`${url}${suffix}`);
  };
  const run = (state: GitWorkflowState, work: () => Promise<unknown>) => {
    setBusy(state);
    work()
      .catch((e) => setCloudNotice(cloudProblem(e).message))
      .finally(() => setBusy(null));
  };
  const create = (draft: boolean) =>
    run("creating-pr", () =>
      cloudPrApi.create(workspaceId, { draft, branch }).then((r) => {
        pr.set(r);
        if (r.reason) setCloudNotice(createRefusal(r.reason, r.detail));
        else if (r.pr) setCloudNotice(`${r.pr.draft ? "Draft pull request" : "Pull request"} #${r.pr.number} opened.`);
      }),
    );
  const onAction = (a: GitWorkflowAction) => {
    switch (a) {
      case "create-pr":
        return create(false);
      case "create-draft-pr":
        return create(true);
      case "create-pr-manually":
        if (pr.read?.compare_url) void openExternal(pr.read.compare_url);
        else setCloudNotice("GitHub’s page for this branch isn’t known yet.");
        return;
      case "push":
        if (!onPush) return openPr();
        return run("pushing", () =>
          onPush().then(() => {
            setCloudNotice("Branch pushed.");
            pr.reload();
          }),
        );
      case "ready-for-review":
        return run("working", () =>
          cloudPrApi.ready(workspaceId, branch).then((r) => {
            pr.set(r);
            setCloudNotice(r.reason ? createRefusal(r.reason, r.detail) : "Marked ready for review.");
          }),
        );
      case "fix-checks":
      case "view-checks":
      case "view-logs":
        return openPr("/checks");
      case "resolve-conflicts":
        return openPr("/conflicts");
      case "archive":
        return onArchive?.();
      default:
        // Merge, review, comments: on GitHub, as the person.
        return openPr();
    }
  };
  return (
    <GitWorkflowToolbar
      workflow={workflow}
      onAction={onAction}
      onOpenPr={() => openPr()}
      onOpenExternal={() => openPr()}
      onIssueAction={(a) => {
        if (a === "retry") pr.reload();
        else if (a === "open-settings") openYourGithub();
      }}
    />
  );
}

/** The Checks tab: the pull request's checks as GitHub counts them. */
export function CloudPrChecks({ workspaceId, branch }: { workspaceId: string; branch: string | null }) {
  const pr = useWorkspacePullRequest(workspaceId, branch);
  const read = pr.read;
  if (!read && pr.failed) return <ErrorState message={pr.failed} onRetry={pr.reload} />;
  if (!read) return <LoadingState label="Reading the pull request’s checks…" />;
  const open = read.pr;
  if (!open)
    return (
      <EmptyState
        size="sm"
        icon={ListChecks}
        title="No checks to show"
        body={
          read.reason
            ? createRefusal(read.reason, read.detail)
            : "Checks run on a pull request. Create one from the row above and its checks show here."
        }
      />
    );
  const c = open.checks;
  const rows = c
    ? [
        { label: "Failing", n: c.failing, tone: "danger" },
        { label: "Running", n: c.pending, tone: "warning" },
        { label: "Passed", n: Math.max(0, c.total - c.failing - c.pending), tone: "success" },
      ].filter((r) => r.n > 0)
    : [];
  return (
    <div className="ui-cloud-pr-checks">
      <p className="ui-cloud-pr-checks-title">
        #{open.number} {open.title}
      </p>
      {!c ? (
        <p className="ui-cloud-note">GitHub didn’t share this pull request’s checks with Aura.</p>
      ) : !c.total ? (
        <p className="ui-cloud-note">No checks have run on this pull request.</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.label} data-tone={r.tone}>
              <span>{r.label}</span>
              <span className="ui-cloud-right-count">{r.n}</span>
            </li>
          ))}
        </ul>
      )}
      <Button size="xs" variant="outline" onClick={() => void openExternal(`${open.url}/checks`)}>
        <ArrowUpRight />
        Open checks on GitHub
      </Button>
    </div>
  );
}

// The right panel beside one cloud workspace: the usual frame and tabs,
// filled only with what the cloud actually knows about this workspace.
//
// Changes are real — the files the workspace's own commits touched, read the
// way the console's Changes pane reads them, counted on their tab. The pull
// request row and the Checks tab are GitHub's, read by the server for the
// workspace's branch (CloudPrToolbar). Nothing sends the workspace's files or
// artifacts to the app yet, so those say so in the library's own empty state
// instead of drawing rows.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FolderTree, GitBranch, GitCompare, Package } from "lucide-react";

import {
  cloudApi,
  cloudProblem,
  type CloudChangedFile,
  type CloudWorkspaceChanges,
} from "../../lib/cloudWorkspacesApi";
import { useCachedResource } from "../../lib/useCachedResource";
import { DetailsChangeScope } from "../ui/details-panel";
import { FileTree, type FileTreeNode } from "../ui/file-tree";
import { GitChangeScope } from "../ui/git-workflow";
import { DiffCount } from "../ui/sidebar";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { viewKey } from "./cloudPlaceKeep";
import { CloudPrChecks, CloudPrToolbar } from "./CloudPrToolbar";

export const PANEL_TABS = ["Artifacts", "All files", "Changes", "Checks"] as const;
/** The panel's tabs; "Comments" is there in a workspace that takes them. */
export type PanelTab = (typeof PANEL_TABS)[number] | "Comments";

/** The Comments tab's body, and the number of open threads on it. */
export type PanelComments = { body: ReactNode; count: number | null };

const NO_CHANGES: Record<string, string> = {
  not_committed: "Nothing this workspace changed has been committed yet.",
  no_github: "Changes are read through GitHub, and this repository isn’t connected to it.",
  not_on_github: "This workspace’s repository isn’t on GitHub, where changes are read from.",
  unavailable: "The cloud couldn’t read this workspace’s changes.",
};

/** A change's word as the tree's mark. No word draws no mark: the panel
 *  doesn't guess what happened to a file. */
function statusOf(word: string | null): FileTreeNode["status"] {
  if (word === null) return undefined;
  if (word === "added") return "added";
  if (word === "removed") return "deleted";
  if (word === "conflicted") return "conflict";
  return "modified";
}

/** What a changed file says about itself, wherever it was read. */
export type ChangedFile = Pick<CloudChangedFile, "path" | "status" | "additions" | "deletions">;

/** Paths as the library's tree: folders first, each level by name. */
export function changeTree(files: readonly ChangedFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let level = root;
    parts.forEach((name, i) => {
      const id = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        level.push({
          id,
          name,
          status: statusOf(f.status),
          statusLabel: f.status ?? undefined,
          added: f.additions ?? undefined,
          removed: f.deletions ?? undefined,
        });
        return;
      }
      let dir = level.find((n) => n.id === id && n.children);
      if (!dir) {
        dir = { id, name, children: [] };
        level.push(dir);
      }
      level = dir.children!;
    });
  }
  const sort = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes
      .map((n) => (n.children ? { ...n, children: sort(n.children) } : n))
      .sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
  return sort(root);
}

export function folders(nodes: readonly FileTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children ? [n.id, ...folders(n.children)] : []));
}

/** What the workspace's commits changed: loading, failed, or read. */
type ChangesRead =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "read"; changes: CloudWorkspaceChanges };

/** The changes as last read for this workspace, at once on a revisit, then
 *  read again behind them; a failed read keeps the ones already shown. */
function useChanges(id: string) {
  const { data, staleError, reload } = useCachedResource(viewKey("changes", id), () =>
    // A plain sentence, so the panel says it as it is.
    cloudApi.changes(id).catch((e) => Promise.reject(cloudProblem(e).message)),
  );
  const read: ChangesRead = data
    ? { state: "read", changes: data }
    : staleError
      ? { state: "failed", message: staleError }
      : { state: "loading" };
  const load = useCallback(() => void reload(), [reload]);
  return { read, load };
}

/** The lines added and removed across the files, when every file says. */
export function totalsOf(files: readonly ChangedFile[]): { added: number; removed: number } | null {
  let added = 0,
    removed = 0;
  for (const f of files) {
    if (f.additions == null || f.deletions == null) return null;
    added += f.additions;
    removed += f.deletions;
  }
  return { added, removed };
}

function Changes({
  read,
  branch,
  onRetry,
}: {
  read: ChangesRead;
  branch: string | null;
  onRetry: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const changes = read.state === "read" ? read.changes : null;
  const tree = useMemo(() => changeTree(changes?.files ?? []), [changes]);
  const totals = useMemo(() => totalsOf(changes?.files ?? []), [changes]);

  if (read.state === "failed") return <ErrorState message={read.message} onRetry={onRetry} />;
  if (!changes) return <LoadingState label="Reading what this workspace changed…" />;
  if (!changes.files.length)
    return (
      <EmptyState
        size="sm"
        icon={GitCompare}
        title="No changes to show"
        body={
          NO_CHANGES[changes.reason ?? ""] ??
          "This workspace’s commits haven’t touched any files yet."
        }
      />
    );
  return (
    <>
      <DetailsChangeScope>
        {/* All changes is the one scope the API backs: it reads the
            workspace's commits, not its working tree, and lists no commits
            to scope to. */}
        <GitChangeScope branch={branch ?? undefined} scope="all" onScopeChange={() => undefined} />
        {totals && (
          <div className="ui-details-change-scope-tools">
            <DiffCount added={totals.added} removed={totals.removed} />
          </div>
        )}
      </DetailsChangeScope>
      <FileTree
        label="Changes"
        nodes={tree}
        defaultExpanded={folders(tree)}
        selected={selected}
        onSelect={(node) => setSelected(node.id)}
      />
      {changes.truncated && (
        <p className="ui-cloud-note">
          The newest {changes.commits_read} commits were read; older changes aren’t listed.
        </p>
      )}
    </>
  );
}

/** The panel's frame: the branch row, the tabs and the body. Shared by the
 *  workspaces the cloud reads and the ones a machine of ours runs, so both
 *  look the same. */
export function PanelFrame({
  branch,
  tools,
  toolbar,
  tab,
  onTab,
  count,
  comments,
  footer,
  children,
}: {
  branch: string | null;
  /** Drawn under the tabs' contents, the width of the panel. */
  footer?: ReactNode;
  /** Drawn at the end of the branch row. */
  tools?: ReactNode;
  /** The pull request row; drawn in place of the plain branch row. */
  toolbar?: ReactNode;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  /** The number on the Changes tab, when there is one to show. */
  count: number | null;
  /** The Comments tab, in a workspace that takes comments. */
  comments?: PanelComments | null;
  children: ReactNode;
}) {
  const tabs: readonly PanelTab[] = comments ? [...PANEL_TABS, "Comments"] : PANEL_TABS;
  return (
    <aside className="ui-cloud-right">
      {toolbar ? (
        <div className="ui-cloud-pr-bar">
          {toolbar}
          {tools}
        </div>
      ) : (branch || tools) && (
        <div className="ui-git-toolbar">
          {branch && (
            <span className="ui-git-summary ui-cloud-branch" aria-label={`Branch ${branch}`}>
              <GitBranch size={14} />
              <span>{branch}</span>
            </span>
          )}
          {tools}
        </div>
      )}
      <nav>
        {tabs.map((t) => (
          <button key={t} data-selected={tab === t} onClick={() => onTab(t)}>
            {t}
            {t === "Changes" && count !== null && (
              <span className="ui-cloud-right-count">{count}</span>
            )}
            {t === "Comments" && comments?.count ? (
              <span className="ui-cloud-right-count">{comments.count}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="ui-cloud-right-files">{tab === "Comments" && comments ? comments.body : children}</div>
      {footer}
    </aside>
  );
}

export function CloudApiWorkspacePanel({
  id,
  branch,
  tab,
  onTab,
  comments,
  onArchive,
}: {
  id: string;
  branch: string | null;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  comments?: PanelComments | null;
  /** Archive the workspace once its pull request is done. */
  onArchive?: () => void;
}) {
  const { read, load } = useChanges(id);
  const count = read.state === "read" && read.changes.files.length ? read.changes.files.length : null;
  // The cloud keeps no push status for a workspace it runs, so the row is the
  // branch's pull request alone: no Push, nothing about commits not yet sent.
  return (
    <PanelFrame
      branch={branch}
      toolbar={<CloudPrToolbar workspaceId={id} branch={branch} onArchive={onArchive} />}
      tab={tab}
      onTab={onTab}
      count={count}
      comments={comments}
    >
        {tab === "Changes" ? (
          <Changes read={read} branch={branch} onRetry={load} />
        ) : tab === "All files" ? (
          <EmptyState
            size="sm"
            icon={FolderTree}
            title="Files aren’t shown here yet"
            body="The runner keeps this workspace’s files on its own machine and doesn’t send them to the app."
          />
        ) : tab === "Checks" ? (
          <CloudPrChecks workspaceId={id} branch={branch} />
        ) : (
          <EmptyState
            size="sm"
            icon={Package}
            title="No artifacts to show"
            body="Previews and files the agent makes for you aren’t sent to the app for this workspace yet."
          />
        )}
    </PanelFrame>
  );
}

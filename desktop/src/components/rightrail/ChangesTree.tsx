// The changed-file list on the Changes tab: the library file tree, each row
// its path (folder dim, name bright) the way a diff lists it, with every
// per-file action in the row's context menu (View, Attach in chat, Open in,
// Copy path, Copy relative path, Stage, Unstage, and Discard behind a
// confirmation). A file in a git repository of its own inside the project
// carries that repository's tag, and its menu commits and pushes, or opens a
// pull request for, that repository. Files marked as viewed in the diff
// gather in a last "Viewed" group, and a file with review comments shows how
// many.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { GitPullRequest, MessageSquare, Minus, Plus, Upload } from "lucide-react";
import type { ChangedFile } from "../../lib/useGitChanges";
import type { NestedRepo } from "../../lib/api";
import { runGitChat } from "../../lib/gitChat";
import { FileTree, type FileTreeNode } from "../ui/file-tree";
import { FileMenuItems, type FileApplication } from "../ui/file-actions-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { Button } from "../ui/button";
import { DetailsCaption } from "../ui/details-panel";
import { changeNodes, type ChangeMode } from "./changeNodes";
import { ChangePath, RepoTag } from "./ChangePath";
import { DiscardChangesDialog, type DiscardTarget } from "./DiscardChangesDialog";
import { needsPolling } from "../../lib/place/workApi";
import { attachToChat, useEditors } from "./files/useFileActions";
import { openInApps } from "./openInApps";
import { matchesRailFilter } from "./railFilter";
import { useChangeReviewMarks } from "./useChangeReviewMarks";
import { VIEWED_GROUP_KEY, withViewedGroup } from "./viewedGroup";
import "../ui/diff-review.css";

const absolute = (root: string, rel: string) => `${root.replace(/\/+$/, "")}/${rel}`;

export type OpenKeys = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };
const NO_KEYS: OpenKeys = { shiftKey: false, metaKey: false, ctrlKey: false };

export type ChangeGroup = {
  key: string;
  /** No caption when the list has only this one group. */
  title?: string;
  files: Array<{ file: ChangedFile; mode: ChangeMode }>;
  /** A header action — Stage all, Unstage all. */
  action?: { label: string; run: () => void };
  /** Collapsed groups show their caption only. */
  collapsed?: boolean;
  onToggle?: () => void;
};

export function ChangesTree({
  repoRoot,
  groups,
  filter,
  selected,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  repoOf,
}: {
  repoRoot: string;
  groups: ChangeGroup[];
  filter: string;
  selected: string | null;
  /** `keys` are the modifiers held by the click that opened it (none from
   *  the keyboard or the menu). */
  onOpen: (path: string, keys: OpenKeys) => void;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
  /** The git repository inside the project a path belongs to, if any. Left
   *  out, every file is the project's own. */
  repoOf?: (path: string) => NestedRepo | undefined;
}) {
  const [discard, setDiscard] = useState<DiscardTarget | null>(null);
  // FileTree reports a selection without its event; remember the modifiers
  // of the pointer that caused it.
  const keys = useRef<OpenKeys>(NO_KEYS);
  const paths = useMemo(
    () => [...new Set(groups.flatMap((g) => g.files.map((entry) => entry.file.path)))],
    [groups],
  );
  const { isViewed, commentCount } = useChangeReviewMarks(repoRoot, paths);
  // A tree on another machine: the apps here can't open a file over there.
  const editors = useEditors(!needsPolling(repoRoot));
  const shownGroups = useMemo(() => withViewedGroup(groups, isViewed), [groups, isViewed]);

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

  return (
    <div
      className="ui-details-change-list"
      onPointerDownCapture={(e) => {
        keys.current = { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey };
      }}
      onKeyDownCapture={() => {
        keys.current = NO_KEYS;
      }}
    >
      {shownGroups.map((group) => {
        const visible = group.files.filter(({ file }) => matchesRailFilter(file.path, filter));
        if (visible.length === 0 && !group.title) return null;
        const byId = new Map<string, { file: ChangedFile; mode: ChangeMode }>();
        const nodes: FileTreeNode[] = [];
        // The row draws the whole path; the node's name is the file name so
        // typing a name still jumps to its row.
        for (const entry of visible) {
          const [node] = changeNodes([entry.file], entry.mode);
          node.name = entry.file.path.split("/").filter(Boolean).pop() ?? entry.file.path;
          byId.set(node.id, entry);
          nodes.push(node);
        }
        return (
          <section
            key={group.key}
            className={group.key === VIEWED_GROUP_KEY ? "ui-changes-viewed" : undefined}
          >
            {group.title && (
              <GroupCaption group={group} count={visible.length} />
            )}
            {!group.collapsed && nodes.length > 0 && (
              <FileTree
                nodes={nodes}
                label="Changed files"
                selected={selected ?? undefined}
                renderName={(node) => {
                  const entry = byId.get(node.id);
                  if (!entry) return node.name;
                  const n = commentCount(entry.file.path);
                  const repo = repoOf?.(entry.file.path);
                  return (
                    <>
                      <ChangePath path={entry.file.path} />
                      {repo && <RepoTag repo={repo} />}
                      {n > 0 && (
                        <span className="ui-changes-comment-count" aria-label={`${n} review comments`}>
                          <MessageSquare size={12} aria-hidden />
                          {n}
                        </span>
                      )}
                    </>
                  );
                }}
                onSelect={(node) => {
                  const entry = byId.get(node.id);
                  if (entry) onOpen(entry.file.path, keys.current);
                }}
                wrapRow={(node, row) => {
                  const entry = byId.get(node.id);
                  if (!entry) return row;
                  const { file, mode } = entry;
                  const repo = repoOf?.(file.path);
                  return (
                    <RowMenu
                      repo={repo && { root: repoRoot, repo }}
                      onView={() => onOpen(file.path, NO_KEYS)}
                      onAttach={
                        file.status === "D" ? undefined : () => attachToChat(absolute(repoRoot, file.path))
                      }
                      applications={
                        file.status === "D" ? undefined : openInApps(editors, absolute(repoRoot, file.path))
                      }
                      onCopyPath={() => copy(absolute(repoRoot, file.path))}
                      onCopyRelativePath={() => copy(file.path)}
                      onStage={mode !== "staged" && onStage ? () => onStage(file.path) : undefined}
                      onUnstage={mode === "staged" && onUnstage ? () => onUnstage(file.path) : undefined}
                      onDiscard={
                        mode !== "staged" && onDiscard
                          ? () => setDiscard({ path: file.path, untracked: mode === "untracked" })
                          : undefined
                      }
                    >
                      {row}
                    </RowMenu>
                  );
                }}
              />
            )}
          </section>
        );
      })}
      <DiscardChangesDialog
        target={discard}
        onCancel={() => setDiscard(null)}
        onConfirm={(path) => {
          onDiscard?.(path);
          setDiscard(null);
        }}
      />
    </div>
  );
}

function GroupCaption({ group, count }: { group: ChangeGroup; count: number }) {
  const title = `${group.title} ${count}`;
  return (
    <div className="ui-details-group-caption">
      {group.onToggle ? (
        <button
          type="button"
          className="ui-details-group-toggle"
          aria-expanded={!group.collapsed}
          onClick={group.onToggle}
        >
          <DetailsCaption>{title}</DetailsCaption>
        </button>
      ) : (
        <DetailsCaption>{title}</DetailsCaption>
      )}
      {group.action && count > 0 && (
        <Button size="xs" variant="ghost" onClick={group.action.run}>
          {group.action.label}
        </Button>
      )}
    </div>
  );
}

/** A nested repository's own git actions, run as a chat in the project's
 *  workspace told to work inside that folder. */
function nestedRepoActions({ root, repo }: { root: string; repo: NestedRepo }) {
  const rel = repo.rel_path;
  return {
    rel,
    commitPush: () => void runGitChat(root, `commit-push:${rel}`, { action: "commit-push", folder: rel }),
    createPr: repo.branch
      ? () =>
          void runGitChat(root, `create-pr:${rel}`, {
            action: "create-pr",
            branch: repo.branch ?? "",
            remote: "origin",
            target: repo.base ?? "main",
            draft: false,
            folder: rel,
          })
      : undefined,
  };
}

function RowMenu({
  repo,
  onView,
  onAttach,
  applications,
  onCopyPath,
  onCopyRelativePath,
  onStage,
  onUnstage,
  onDiscard,
  children,
}: {
  onView: () => void;
  /** Left out for a deleted file: there is nothing left to attach. */
  onAttach?: () => void;
  /** Left out for a deleted file, and on another machine. */
  applications?: FileApplication[];
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  /** The file belongs to this git repository inside the project. */
  repo?: { root: string; repo: NestedRepo };
  children: ReactNode;
}) {
  const nested = repo ? nestedRepoActions(repo) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <FileMenuItems
          onView={onView}
          onAttach={onAttach}
          applications={applications}
          onCopyPath={onCopyPath}
          onCopyRelativePath={onCopyRelativePath}
          // The confirmation opens once the menu has closed, so it gets focus.
          onDiscard={onDiscard ? () => requestAnimationFrame(onDiscard) : undefined}
        />
        {(onStage || onUnstage) && <ContextMenuSeparator />}
        {onStage && (
          <ContextMenuItem onSelect={onStage}>
            <Plus />
            Stage
          </ContextMenuItem>
        )}
        {onUnstage && (
          <ContextMenuItem onSelect={onUnstage}>
            <Minus />
            Unstage
          </ContextMenuItem>
        )}
        {nested && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={nested.commitPush}>
              <Upload />
              Commit and push {nested.rel}
            </ContextMenuItem>
            {nested.createPr && (
              <ContextMenuItem onSelect={nested.createPr}>
                <GitPullRequest />
                Create PR for {nested.rel}
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

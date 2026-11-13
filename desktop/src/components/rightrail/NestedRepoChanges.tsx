// One nested repository's changes in the Git view's Changes list: a folder in
// the project that is a git repository of its own. (The rail's Changes tab
// lists these files in its one list instead, tagged with their repository.)
// It gets its own group, named
// by its folder and branch, with its own file list and its own commit box, so
// a commit, push or pull request here goes to that repository and never to
// the project around it. Create PR is the project's own: a chat in the
// project's workspace writes and opens it, told to work inside the folder.
//
// Rows carry paths from the project root (`cloud/src/app.ts`), so opening,
// diffing, review marks and staging use the same path as every other file;
// the backend sends each git command to the repository that owns the file.

import { useCallback, useMemo, useState } from "react";
import { gitDiscard, gitStage, gitUnstage } from "../../lib/place/workApi";
import { useGitChanges } from "../../lib/useGitChanges";
import { trackedCount, underFolder } from "../../lib/nestedRepos";
import type { NestedRepo } from "../../lib/api";
import { runGitChat, useGitChats } from "../../lib/gitChat";
import { Button } from "../ui/button";
import { DetailsCaption } from "../ui/details-panel";
import { ChangesTree, type OpenKeys } from "./ChangesTree";
import { CommitInput } from "./CommitInput";
import { buildChangeGroups, selectedModeFor, splitChanges } from "./changeGroups";
import { nodeId } from "./changeNodes";
import "../ui/rail-group.css";

export function NestedRepoChanges({
  projectRoot,
  repo,
  filter,
  selected,
  onSelect,
  onOpen,
  onBeforeCommit,
}: {
  projectRoot: string;
  repo: NestedRepo;
  filter: string;
  /** The panel's one selection, a path from the project root. */
  selected: string | null;
  onSelect: (path: string) => void;
  onOpen: (path: string, keys: OpenKeys) => void;
  onBeforeCommit?: () => Promise<boolean>;
}) {
  const changes = useGitChanges(repo.root);
  const [isOpen, setIsOpen] = useState(true);
  const [generatedOpen, setGeneratedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const staged = useMemo(() => underFolder(changes.staged, repo.rel_path), [changes.staged, repo.rel_path]);
  const unstaged = useMemo(() => underFolder(changes.unstaged, repo.rel_path), [changes.unstaged, repo.rel_path]);
  const untracked = useMemo(() => underFolder(changes.untracked, repo.rel_path), [changes.untracked, repo.rel_path]);
  const parts = useMemo(() => splitChanges(staged, unstaged, untracked), [staged, unstaged, untracked]);

  const refresh = useCallback(() => {
    changes.refresh();
    setRefreshTick((t) => t + 1);
  }, [changes]);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      try {
        await run();
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        refresh();
      }
    },
    [refresh],
  );
  const stage = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) void act(() => gitStage(projectRoot, paths));
    },
    [act, projectRoot],
  );
  const unstage = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) void act(() => gitUnstage(projectRoot, paths));
    },
    [act, projectRoot],
  );

  const groups = useMemo(
    () =>
      buildChangeGroups(parts, {
        stage,
        unstage,
        generatedOpen,
        toggleGenerated: () => setGeneratedOpen((o) => !o),
      }),
    [parts, stage, unstage, generatedOpen],
  );

  const count = trackedCount(changes.staged, changes.unstaged) + changes.untracked.length;
  const mine = selected !== null && (selected === repo.rel_path || selected.startsWith(`${repo.rel_path}/`));
  const selectedMode = selectedModeFor(selected, staged, unstaged, untracked);
  const title = repo.branch ? `${repo.rel_path} · ${repo.branch}` : repo.rel_path;
  const chatting = useGitChats(projectRoot);
  const prChat = `create-pr:${repo.rel_path}`;
  const kindNote = repo.kind === "submodule" ? "Submodule" : "Separate repository";

  return (
    <section className="ui-rail-group" data-open={isOpen} aria-label={`${kindNote} ${repo.rel_path}`}>
      <div className="ui-details-group-caption ui-rail-group-caption" title={`${kindNote} at ${repo.root}`}>
        <button
          type="button"
          className="ui-details-group-toggle"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((o) => !o)}
        >
          <DetailsCaption>{count > 0 ? `${title} ${count}` : title}</DetailsCaption>
        </button>
        {repo.branch && (
          <div className="ui-rail-group-actions">
            <Button
              size="xs"
              variant="ghost"
              disabled={chatting(prChat)}
              onClick={() =>
                void runGitChat(projectRoot, prChat, {
                  action: "create-pr",
                  branch: repo.branch ?? "",
                  remote: "origin",
                  target: repo.base ?? "main",
                  draft: false,
                  folder: repo.rel_path,
                })
              }
            >
              Create PR
            </Button>
          </div>
        )}
      </div>
      {isOpen && (
        <div className="ui-rail-group-body">
          {error && <div className="bg-red/10 text-red text-xs px-3 py-1.5">{error}</div>}
          {changes.error && count === 0 ? (
            <DetailsCaption>Aura couldn’t read this repository’s changes. It keeps trying.</DetailsCaption>
          ) : changes.loading && count === 0 ? (
            <DetailsCaption>Looking at what’s changed…</DetailsCaption>
          ) : count === 0 ? (
            <DetailsCaption>No changes in this repository</DetailsCaption>
          ) : (
            <ChangesTree
              repoRoot={projectRoot}
              groups={groups}
              filter={filter}
              selected={mine && selected ? nodeId(selectedMode, selected) : null}
              onOpen={(path, keys) => {
                onSelect(path);
                onOpen(path, keys);
              }}
              onStage={(path) => stage([path])}
              onUnstage={(path) => unstage([path])}
              onDiscard={(path) => void act(() => gitDiscard(projectRoot, [path]))}
            />
          )}
          <CommitInput
            repoRoot={repo.root}
            hasStagedChanges={changes.staged.length > 0}
            refreshTick={refreshTick}
            onBeforeCommit={onBeforeCommit}
            onAfterMutation={refresh}
          />
        </div>
      )}
    </section>
  );
}

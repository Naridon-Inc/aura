// The Changes tab, read like a diff: one row naming how many files changed
// with the lines added and removed (and a menu to widen the scope to the whole
// branch or narrow it to one commit), then every changed file once, by path,
// with generated files folded away at the end and each file's actions in its
// context menu. A folder in the project that is a git repository of its own
// lists its files in the same list, tagged with that repository; its row menu
// commits and pushes, or opens a pull request for, that repository.
//
// The header row's one "Commit and push" hands the project's commit to an
// agent chat, the same action as the git status row above the rail — which
// offers Push first while the branch is ahead, so this is the commit that is
// always there. The Git view draws this list with `staging`: Staged / Changes
// groups with their bulk actions, each nested repository under its own
// heading, and the Git view's own commit box under it all.

import { useCallback, useEffect, useMemo, useState } from "react";
// Through the place seam: a workspace standing in a machine stages and
// discards on the box's checkout, not the laptop's copy (AURA-1306).
import { gitDiscard, gitStage, gitUnstage } from "../../lib/place/workApi";
import { nestedRepoOf } from "../../lib/nestedRepos";
import { AURA_SYNC_ENABLED } from "../../lib/featureFlags";
import { runGitChat, useGitChats } from "../../lib/gitChat";
import { GitFork } from "lucide-react";
import { Button } from "../ui/button";
import { DiffCount } from "../ui/sidebar";
import { GitChangeScope } from "../ui/git-workflow";
import { DetailsCaption, DetailsChangeScope } from "../ui/details-panel";
import { ChangesTree, type OpenKeys } from "./ChangesTree";
import { ScopedChanges } from "./ScopedChanges";
import { nodeId, totals } from "./changeNodes";
import { buildChangeGroups, flatChangeGroups, selectedModeFor } from "./changeGroups";
import { changedFileCount, listedFiles, useChangeList } from "./useChangeList";
import { NestedRepoChanges } from "./NestedRepoChanges";
import { useRailFilter } from "./railFilter";
import { UNCOMMITTED, useChangeScope } from "./useChangeScope";
import { ErrorState, LoadingState } from "../ui/state";
import { useLiveSync } from "./sync/useLiveSync";
import { GoLiveControl } from "./sync/GoLiveControl";
import { IncomingSection } from "./sync/IncomingSection";
import { ConflictsSection } from "./sync/ConflictsSection";
import { resolveAstConflict } from "../../lib/ambientCache";

// "Go live" (real-time co-editing) is hidden from Changes for now — the
// feature stays wired behind AURA_SYNC_ENABLED, we just don't surface the
// control. Flip back to re-expose it.
const SHOW_GO_LIVE = false;

const SECTIONS_OPEN_KEY = "aura.rightRail.sections";

// "generated" is the clubbed bucket of machine churn (.aura/** snapshots,
// build output, editor cruft) — collapsed by default so it stays out of
// the way while the real edits sit expanded above it.
type SectionKey = "staged" | "unstaged" | "untracked" | "generated";
type SectionsOpen = Record<SectionKey, boolean>;

const DEFAULT_OPEN: SectionsOpen = {
  staged: true,
  unstaged: true,
  untracked: true,
  generated: false,
};

function loadSectionsOpen(): SectionsOpen {
  try {
    const raw = localStorage.getItem(SECTIONS_OPEN_KEY);
    if (!raw) return DEFAULT_OPEN;
    return { ...DEFAULT_OPEN, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_OPEN;
  }
}

const filesChanged = (n: number) => `${n} ${n === 1 ? "file" : "files"} changed`;

type OpenMode = "diff" | "diff-new-tab" | "edit";

type Props = {
  repoRoot: string;
  /** Click on a row → open the file in the work surface. The mode is
   *  derived from the MouseEvent modifiers: plain click → "diff",
   *  Shift → "diff-new-tab", Cmd/Ctrl → "edit". App.tsx routes each
   *  mode through the existing editor open path. */
  onOpenFile?: (path: string, mode: OpenMode) => void;
  /** A file picked while the scope is one commit: open that commit's diff on
   *  it. Without it the file opens as it is now. */
  onOpenCommitFile?: (sha: string, path: string) => void;
  /** The Git view: Staged / Changes groups with Stage all and Unstage all,
   *  and each nested repository under its own heading with its own commit
   *  box. Left out, every changed file is one list. */
  staging?: boolean;
  /** The Git view's strict-mode gate before a nested repository's commit. */
  onBeforeCommit?: () => Promise<boolean>;
};

function openModeFor(e: OpenKeys): OpenMode {
  if (e.shiftKey) return "diff-new-tab";
  if (e.metaKey || e.ctrlKey) return "edit";
  return "diff";
}

/** What this panel may say about your working tree, given how much of it git
 *  actually managed to tell us.
 *
 *  `useGitChanges` has always computed an `error` — it is declared in the
 *  exported `GitChanges` type and set in the hook's catch — and this panel
 *  never read it. So when `git status` failed (an index.lock left behind by a
 *  crashed editor, a half-finished rebase, a permissions problem on a network
 *  drive) the lists came back empty with `loading` false, and the panel drew
 *  the one sentence it must never draw on a guess:
 *
 *      No changes yet. Every file matches your last save
 *
 *  On a four-second poll that keeps failing, that sentence is permanent. It is
 *  also the exact reassurance somebody checks before closing the lid, and the
 *  only place in the app that answers "is my work saved?" without opening a
 *  terminal. "I couldn't look" and "there is nothing there" are not the same
 *  answer and this now says which one it has.
 *
 *  A failed read with rows still on screen is deliberately softer: the last
 *  good list is still true as of the last successful poll, so it stays, with
 *  the header admitting it may have moved on. Only a failure with nothing to
 *  show replaces the body — there is nothing to preserve, and a bare panel is
 *  indistinguishable from a clean tree.
 *
 *  `headerNote: null` means "the caller's own counts are the honest note" —
 *  the panel prints `N changed · M generated` in that case. */
export function changesReadout(s: {
  loading: boolean;
  failed: boolean;
  total: number;
  liveActive: boolean;
}): {
  headerNote: string | null;
  body: string | null;
  tone: "known" | "waiting" | "failed";
} {
  if (s.failed && s.total === 0)
    return {
      headerNote: "couldn’t read",
      body: "Aura couldn’t ask git what you’ve changed. Nothing has been lost. This is the reading that failed. It keeps trying every few seconds.",
      tone: "failed",
    };
  // Rows survived a failed refresh: keep them, but stop calling them current.
  if (s.failed)
    return { headerNote: "may be out of date", body: null, tone: "failed" };
  if (s.loading && s.total === 0)
    return {
      headerNote: "reading…",
      body: "Looking at what you’ve changed…",
      tone: "waiting",
    };
  if (s.total === 0)
    return {
      headerNote: "no changes",
      body: s.liveActive
        ? "Your changes are in sync"
        : "No changes yet. Every file matches your last save",
      tone: "known",
    };
  return { headerNote: null, body: null, tone: "known" };
}

export function ChangesPanel({
  repoRoot,
  onOpenFile,
  onOpenCommitFile,
  staging = false,
  onBeforeCommit,
}: Props) {
  // One list, read the way the tab's badge reads it (`useChangeList`): the
  // project's own files, every nested repository's files with paths from the
  // project root, generated files folded at the end. The Git view keeps nested
  // repositories under their own headings instead.
  const { changes, nested, listed, parts } = useChangeList(repoRoot, { withNested: !staging });
  const repoOf = useCallback((path: string) => nestedRepoOf(path, nested), [nested]);
  const [open, setOpen] = useState<SectionsOpen>(loadSectionsOpen);
  const [, setBusyPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after any mutation so the scope row re-reads its branch and commits.
  const [refreshTick, setRefreshTick] = useState(0);

  // Live sync layer (folded into this panel, gated by AURA_SYNC_ENABLED).
  // When off the hook no-ops and never polls.
  const sync = useLiveSync(repoRoot, AURA_SYNC_ENABLED);
  const [liveOpen, setLiveOpen] = useState({ incoming: true, conflicts: true });
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const openLiveFile = useCallback(
    (path: string) => {
      setSelected(path);
      onOpenFile?.(path, "diff");
    },
    [onOpenFile],
  );

  const resolveConflict = useCallback(
    async (id: string, strategy: "ours" | "theirs") => {
      setResolvingId(id);
      try {
        await resolveAstConflict(repoRoot, {
          conflict_id: id,
          strategy,
        });
        await sync.refresh();
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setResolvingId(null);
      }
    },
    [repoRoot, sync.refresh],
  );

  const liveActive = AURA_SYNC_ENABLED && sync.live;

  useEffect(() => {
    localStorage.setItem(SECTIONS_OPEN_KEY, JSON.stringify(open));
  }, [open]);

  // Footer diff badge → focus this panel + open the first changed file
  // in a diff workpane. We synthesise a plain (no-modifier) MouseEvent
  // so the existing `onOpenFile(path, "diff")` path runs unchanged.
  useEffect(() => {
    function onFocus() {
      // Prefer a real edit over machine churn when auto-opening.
      const first =
        parts.sigUnstaged[0] ??
        parts.sigStaged[0] ??
        parts.sigUntracked[0] ??
        listed.unstaged[0] ??
        listed.staged[0] ??
        listed.untracked[0];
      if (!first) return;
      setSelected(first.path);
      onOpenFile?.(first.path, "diff");
    }
    window.addEventListener("aura:focus-changes", onFocus);
    return () => window.removeEventListener("aura:focus-changes", onFocus);
  }, [parts, listed, onOpenFile]);

  const refreshAll = useCallback(async () => {
    await changes.refresh();
    setRefreshTick((t) => t + 1);
  }, [changes]);

  // A checkout (or commit) elsewhere in the git UI changes the working tree —
  // re-read so this panel never shows stale staged/unstaged files.
  useEffect(() => {
    const onGitChanged = () => void refreshAll();
    window.addEventListener("aura:git-changed", onGitChanged);
    return () => window.removeEventListener("aura:git-changed", onGitChanged);
  }, [refreshAll]);

  function toggle(key: SectionKey) {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // A nested repository's list is its own store, which re-reads on the app's
  // git-changed broadcast; the project's re-read alone would leave it a poll
  // behind the click.
  const afterMutation = useCallback(
    async (paths: string[]) => {
      await refreshAll();
      if (paths.some((p) => repoOf(p))) window.dispatchEvent(new CustomEvent("aura:git-changed"));
    },
    [refreshAll, repoOf],
  );

  const stagePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusyPath(paths.join(","));
      try {
        await gitStage(repoRoot, paths);
        await afterMutation(paths);
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyPath(null);
      }
    },
    [repoRoot, afterMutation],
  );

  const unstagePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusyPath(paths.join(","));
      try {
        await gitUnstage(repoRoot, paths);
        await afterMutation(paths);
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyPath(null);
      }
    },
    [repoRoot, afterMutation],
  );

  const discardPath = useCallback(
    async (path: string) => {
      setBusyPath(path);
      try {
        await gitDiscard(repoRoot, [path]);
        await afterMutation([path]);
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyPath(null);
      }
    },
    [repoRoot, afterMutation],
  );

  const filter = useRailFilter();
  const scope = useChangeScope(repoRoot, refreshTick);
  const changeGroups = useMemo(
    () =>
      staging
        ? buildChangeGroups(parts, {
            stage: (paths) => void stagePaths(paths),
            unstage: (paths) => void unstagePaths(paths),
            generatedOpen: open.generated,
            toggleGenerated: () => toggle("generated"),
          })
        : flatChangeGroups(parts, {
            generatedOpen: open.generated,
            toggleGenerated: () => toggle("generated"),
          }),
    [staging, parts, open.generated, stagePaths, unstagePaths],
  );
  const selectedMode = selectedModeFor(selected, listed.staged, listed.unstaged, listed.untracked);
  // Every listed file once, generated ones included: the header's count and
  // its +/− are the list's, the same count the tab's badge shows.
  const changedFiles = useMemo(() => listedFiles(parts), [parts]);
  const shownTotals =
    scope.scope === UNCOMMITTED ? totals(changedFiles) : totals(scope.files ?? []);
  // The project's own commit carries only its own files: a change inside a
  // nested repository commits from that file's menu.
  const ownChanged = changedFiles.some((f) => !repoOf(f.path));
  const chatting = useGitChats(repoRoot);

  const totalChanged = changedFileCount(parts);
  const readout = changesReadout({
    loading: changes.loading,
    failed: changes.error !== null,
    total: totalChanged,
    liveActive,
  });
  // The row reads like a diff's header: how many files changed. One commit
  // keeps its message; the whole branch keeps "All changes".
  const scopeLabel =
    scope.scope === UNCOMMITTED
      ? (readout.headerNote ?? filesChanged(totalChanged))
      : undefined;

  return (
    <div className="h-full flex flex-col overflow-hidden min-w-0">
      <DetailsChangeScope>
        <GitChangeScope
          label={scopeLabel}
          branch={scope.branch || "HEAD"}
          targetBranch={scope.targetBranch}
          branches={scope.branches}
          scope={scope.scope}
          onScopeChange={scope.setScope}
          onTargetBranchChange={scope.setTargetBranch}
          changedFiles={totalChanged}
          commits={scope.commits}
        />
        <div className="ui-details-change-scope-tools">
          <DiffCount added={shownTotals.added} removed={shownTotals.removed} />
          {!staging && scope.scope === UNCOMMITTED && ownChanged && (
            <Button
              size="xs"
              variant="secondary"
              disabled={chatting("commit-push")}
              onClick={() => void runGitChat(repoRoot, "commit-push", { action: "commit-push" })}
            >
              Commit and push
            </Button>
          )}
          <Button
            size="iconXs"
            variant="ghost"
            aria-label="Branch graph"
            title="Branch graph"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:open-branch-graph"))}
          >
            <GitFork />
          </Button>
        </div>
      </DetailsChangeScope>

      {AURA_SYNC_ENABLED && SHOW_GO_LIVE && (
        <GoLiveControl
          live={sync.live}
          busy={sync.busy}
          startedAt={sync.startedAt}
          peers={sync.peers}
          presenceHint={sync.presenceHint}
          onToggle={(next) => void (next ? sync.goLive() : sync.stopLive())}
        />
      )}

      {(error || sync.error) && (
        <div className="bg-red/10 text-red text-xs px-3 py-1.5 border-b border-red/30">
          {error ?? sync.error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {liveActive && (
          <>
            {/* Inbound first — what's arriving sits over what you're sending.
                Both auto-hide when empty (CategorySection count === 0). */}
            <IncomingSection
              impacts={sync.incoming}
              isOpen={liveOpen.incoming}
              onToggle={() =>
                setLiveOpen((o) => ({ ...o, incoming: !o.incoming }))
              }
              onOpenFile={openLiveFile}
            />
            <ConflictsSection
              conflicts={sync.conflicts}
              isOpen={liveOpen.conflicts}
              onToggle={() =>
                setLiveOpen((o) => ({ ...o, conflicts: !o.conflicts }))
              }
              busyId={resolvingId}
              onResolve={resolveConflict}
              onOpenFile={openLiveFile}
            />
          </>
        )}
        {/* The Git view lists nested repositories under their own headings,
            so its own list says whose it is. */}
        {staging && nested.length > 0 && <DetailsCaption>This project</DetailsCaption>}
        {scope.scope !== UNCOMMITTED ? (
          <ScopedChanges
            files={scope.files}
            error={scope.error}
            filter={filter}
            selected={selected}
            onOpen={(path) => {
              setSelected(path);
              if (scope.commitSha && onOpenCommitFile) onOpenCommitFile(scope.commitSha, path);
              else onOpenFile?.(path, "edit");
            }}
          />
        ) : readout.tone === "waiting" ? (
          <LoadingState label={readout.body ?? "Looking at what you’ve changed…"} />
        ) : readout.tone === "failed" && readout.body ? (
          <div className="px-3 py-5">
            <ErrorState
              size="sm"
              title="Aura couldn’t read your changes"
              message={readout.body}
              onRetry={() => void refreshAll()}
            />
          </div>
        ) : readout.body ? (
          <DetailsCaption>{readout.body}</DetailsCaption>
        ) : (
          <ChangesTree
            repoRoot={repoRoot}
            groups={changeGroups}
            filter={filter}
            selected={selected ? nodeId(selectedMode, selected) : null}
            onOpen={(path, keys) => {
              setSelected(path);
              onOpenFile?.(path, openModeFor(keys));
            }}
            onStage={(path) => void stagePaths([path])}
            onUnstage={(path) => void unstagePaths([path])}
            onDiscard={(path) => void discardPath(path)}
            repoOf={staging ? undefined : repoOf}
          />
        )}
        {staging &&
          nested.map((repo) => (
            <NestedRepoChanges
              key={repo.root}
              projectRoot={repoRoot}
              repo={repo}
              filter={filter}
              selected={selected}
              onSelect={setSelected}
              onOpen={(path, keys) => onOpenFile?.(path, openModeFor(keys))}
              onBeforeCommit={onBeforeCommit}
            />
          ))}
      </div>
    </div>
  );
}

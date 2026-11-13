// The right panel beside a workspace whose chat runs on one of the org's
// machines: the worktree over there — its files, what the branch changed and
// where the branch stands — read over the same ssh the chat attaches with,
// and the branch's pull request, read from GitHub by the server.
//
// Nothing here reads a checkout on this laptop. When this laptop can't reach
// the machine, the panel says so instead of showing files from somewhere else.
//
// What it read is kept for the window (useBoxWork, useKeptView), so opening
// the workspace again shows the panel as it was left while it reads again.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderTree, GitCompare, Package, RefreshCw, Unplug } from "lucide-react";

import type { AheadBehind } from "../../lib/api";
import type { CloudWorkspacePlace } from "../../lib/cloudWorkspacesApi";
import { placeFsList, placeGitPush, type WorkAt } from "../../lib/place/placeWork";
import { DetailsChangeScope } from "../ui/details-panel";
import { FileTree, type FileTreeNode } from "../ui/file-tree";
import { GitChangeScope } from "../ui/git-workflow";
import { Button } from "../ui/button";
import { DiffCount } from "../ui/sidebar";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { dirNodes, withChildren, type boxChanges, type BoxWorkTarget } from "./boxWork";
import { changeTree, folders, PanelFrame, totalsOf, type PanelComments, type PanelTab } from "./CloudApiWorkspacePanel";
import { CloudRunPanel } from "../ui/cloud-run-panel";
import { CloudBoxPorts } from "./CloudBoxPorts";
import { CloudPrChecks, CloudPrToolbar } from "./CloudPrToolbar";
import { useBoxRun } from "./useBoxRun";
import { boxKey, textOf, useBoxAhead, useBoxChanges, useTarget, type Read } from "./useBoxWork";
import { useKeptView } from "./useKeptView";

/** How often an open panel reads the machine again on its own. Each read is
 *  an ssh round trip, so it is slow; the refresh button is there for now. */
const REFRESH_MS = 20_000;

const NONE_OPEN: ReadonlySet<string> = new Set();

function Files({ at, tick }: { at: WorkAt; tick: number }) {
  const [nodes, keepNodes] = useKeptView<FileTreeNode[] | null>(boxKey("box-files", at), null);
  const [failed, setFailed] = useState<string | null>(null);
  const [expanded, keepExpanded] = useKeptView(boxKey("box-open", at), NONE_OPEN);
  const [selected, setSelected] = useState<string>();
  const open = useRef(expanded);
  open.current = expanded;

  // The root, then every folder that was open, outermost first, so a
  // refresh keeps the tree as it was left.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let tree = dirNodes(await placeFsList(at, at.repoRoot));
        const folders = [...open.current].sort((a, b) => a.length - b.length);
        const kids = await Promise.all(
          folders.map((f) => placeFsList(at, f).then(dirNodes).catch(() => null)),
        );
        folders.forEach((f, i) => {
          if (kids[i]) tree = withChildren(tree, f, kids[i]!);
        });
        if (live) {
          keepNodes(() => tree);
          setFailed(null);
        }
      } catch (e) {
        if (live) setFailed(textOf(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [at, tick, keepNodes]);

  const toggle = (next: Set<string>, node: FileTreeNode, opened: boolean) => {
    keepExpanded(() => next);
    if (!opened) return;
    placeFsList(at, node.id)
      .then((entries) => keepNodes((tree) => tree && withChildren(tree, node.id, dirNodes(entries))))
      .catch((e) => setFailed(textOf(e)));
  };

  if (failed && !nodes) return <ErrorState message={failed} />;
  if (!nodes) return <LoadingState label="Reading the files on the machine…" />;
  if (!nodes.length)
    return <EmptyState size="sm" icon={FolderTree} title="No files here yet" />;
  return (
    <FileTree
      label="All files"
      nodes={nodes}
      expanded={expanded}
      onExpandedChange={toggle}
      selected={selected}
      onSelect={(node) => setSelected(node.id)}
    />
  );
}

function Changes({
  read,
  branch,
}: {
  read: Read<ReturnType<typeof boxChanges>>;
  branch: string | null;
}) {
  const [selected, setSelected] = useState<string>();
  const files = read.state === "read" ? read.value : null;
  const tree = useMemo(() => changeTree(files ?? []), [files]);
  const totals = useMemo(() => totalsOf(files ?? []), [files]);
  if (read.state === "failed") return <ErrorState message={read.message} />;
  if (!files) return <LoadingState label="Reading what this branch changed…" />;
  if (!files.length)
    return (
      <EmptyState
        size="sm"
        icon={GitCompare}
        title="No changes to show"
        body="Nothing on this branch differs from where it started yet."
      />
    );
  return (
    <>
      <DetailsChangeScope>
        {/* Everything since the branch left its base, committed or not. */}
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
    </>
  );
}

/** Where the branch stands against the one it pushes to, in a few words. */
export function standing(ab: AheadBehind | null): string | null {
  if (!ab) return null;
  if (!ab.has_upstream) return "Not pushed";
  const parts = [ab.ahead && `${ab.ahead} ahead`, ab.behind && `${ab.behind} behind`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Up to date";
}

function Unreachable({ target }: { target: Exclude<BoxWorkTarget, { kind: "ok" }> }) {
  return target.kind === "not-connected" ? (
    <EmptyState
      size="sm"
      icon={Unplug}
      title={`${target.machine} isn’t connected from this laptop`}
      body={`This workspace’s files are on ${target.machine}. Connect it from Cloud to read them here.`}
    />
  ) : (
    <EmptyState
      size="sm"
      icon={FolderTree}
      title="The workspace’s folder isn’t recorded"
      body={`The workspace doesn’t say which folder on ${target.machine} it works in.`}
    />
  );
}

export function CloudBoxWorkPanel({
  workspaceId,
  place,
  tab,
  onTab,
  comments,
  onArchive,
}: {
  workspaceId: string;
  place: CloudWorkspacePlace;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  comments?: PanelComments | null;
  /** Archive the workspace once its pull request is done. */
  onArchive?: () => void;
}) {
  const target = useTarget(place);
  const at = target?.kind === "ok" ? target.at : null;
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [at, refresh]);

  const changes = useBoxChanges(at, tick);
  const ahead = useBoxAhead(at, tick);
  const ab = ahead.state === "read" ? ahead.value : null;
  const branch = place.branch ?? ab?.branch ?? null;
  const count = changes.state === "read" && changes.value.length ? changes.value.length : null;
  // The pull request row says ahead and not pushed; only behind is left for
  // the note beside it.
  const where = ab && ab.behind > 0 ? standing(ab) : null;
  // Pushing moves where the branch stands, so the panel reads it again.
  const push = at && ab ? () => placeGitPush(at, !ab.has_upstream).finally(refresh) : undefined;
  const run = useBoxRun(at, place.machine);

  return (
    <PanelFrame
      branch={branch}
      toolbar={
        <CloudPrToolbar
          workspaceId={workspaceId}
          branch={branch}
          standing={ab ? { ahead: ab.ahead, pushed: ab.has_upstream } : null}
          onPush={push}
          onArchive={onArchive}
          tick={tick}
        />
      }
      tab={tab}
      onTab={onTab}
      count={count}
      comments={comments}
      footer={
        <CloudRunPanel available={run.available} run={run.run}>
          {at && <CloudBoxPorts at={at} />}
        </CloudRunPanel>
      }
      tools={
        at && (
          <>
            {where && <span className="ui-cloud-note">{where}</span>}
            <Button
              variant="ghost"
              size="iconSm"
              aria-label={`Read ${place.machine} again`}
              onClick={refresh}
            >
              <RefreshCw />
            </Button>
          </>
        )
      }
    >
      {!target ? (
        <LoadingState label={`Finding ${place.machine}…`} />
      ) : target.kind !== "ok" ? (
        <Unreachable target={target} />
      ) : tab === "All files" ? (
        <Files at={target.at} tick={tick} />
      ) : tab === "Changes" ? (
        <Changes read={changes} branch={branch} />
      ) : tab === "Checks" ? (
        <CloudPrChecks workspaceId={workspaceId} branch={branch} />
      ) : (
        <EmptyState
          size="sm"
          icon={Package}
          title="No artifacts to show"
          body={`Previews and files the agent makes aren’t collected from ${place.machine} yet.`}
        />
      )}
    </PanelFrame>
  );
}

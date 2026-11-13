// One workspace of a repository: a checkout on this computer. The row is the
// library's sidebar item. Its status icon says what state the workspace is in
// (an agent working, one waiting on you, its pull request open, in draft,
// failing its checks, merged or closed, the repository's own checkout, or a
// branch), its trailing slot carries the PR's number and what changed or how
// long since anything landed, and hovering it shows the workspace's
// preview card. Pinned above the repositories it wears its repository's
// picture instead of a status while nothing is happening in it, since no
// repository row above it says whose it is; archived, it waits at the foot.

import { ArchiveRestore } from "lucide-react";
import { Button } from "../../ui/button";
import { ContextMenu, ContextMenuTrigger } from "../../ui/context-menu";
import { HoverCard, HoverCardTrigger, useHoverCardDismiss } from "../../ui/hover-card";
import { DiffCount, SidebarItem } from "../../ui/sidebar";
import type { WorkspaceStatus } from "../../ui/workspace-status";
import { CloudGlyph } from "../../ui/cloud-glyph";
import { PickMark } from "../../places/ClubRail";
import { ProjectAvatar } from "../../ProjectAvatar";
import { labelForAgentId } from "../../../lib/useLiveAgentSessions";
import { useMovedToCloud } from "../../../lib/movedToCloud";
import { localPlace } from "../../../lib/placeRef";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import { setWorkspaceArchived } from "../../../lib/workspaceCustomization";
import { loadSnapshot } from "../../../lib/workspaceSnapshot";
import { effectiveStage } from "../../../lib/workspaceStage";
import { humanizeCopyTitle } from "../../../lib/workspaceLabel";
import type { WorktreeRef } from "../../../lib/workspaceRef";
import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import { CopyHoverPreview } from "./CopyHoverPreview";
import { RosterActionsMenu, RosterContextMenuContent } from "./rosterMenu";
import { workspaceMenu } from "./rosterMenus";
import { RosterRename } from "./RosterRename";
import type { RepositoryLayout } from "./rosterLayout";
import type { RosterEnv } from "./rosterTypes";
import { prNumberTitle, prWorkspaceStatus } from "./rosterPrStatus";
import { derivedRowStage } from "./rosterStatusLayout";
import type { RosterPick } from "./useRosterPick";

const bare = (p: string) => p.replace(/\/+$/, "");

function rowStatus(input: {
  working: boolean;
  attention: boolean;
  badge: WorktreeBadge | undefined;
  isMain: boolean;
}): WorkspaceStatus {
  if (input.working) return "working";
  if (input.attention) return "permission";
  return prWorkspaceStatus(input.badge?.pr) ?? (input.isMain ? "local" : "branch");
}

export function WorkspaceRow({
  w,
  repo,
  env,
  pick,
  placement = "repository",
}: {
  w: WorktreeRef;
  repo: RepositoryLayout;
  env: RosterEnv;
  pick: RosterPick;
  /** Under its repository, pinned above every repository, archived, or
   *  under its stage when the list is grouped by status. */
  placement?: "repository" | "pinned" | "archived" | "status" | "section";
}) {
  // Before the rename early-return: hooks run on every render.
  const hover = useHoverCardDismiss();
  const movedAway = useMovedToCloud(w.path);
  const root = repo.ws.id;
  // "You are here" is one row however many places are open: standing on a
  // machine means you are not standing in the local checkout, even though
  // `activePath` still points at the folder you came from.
  const isActive = w.path === env.activePath && !env.activeMachineId;
  const isWorking = env.workingRoots.has(bare(w.path));
  const agents = env.agentsForPath(w.path);
  const attention = agents.some((a) => a.attention);
  // A chat that finished while you were elsewhere is only in the workspace's
  // saved tabs; the one in front answers from its live tabs.
  const unread = attention || (!isActive && env.unreadAt(w.path));
  const title =
    env.custom[w.path]?.name ||
    (w.branch ? humanizeCopyTitle(w.branch, false, w.path) : repo.name);
  const badge = env.badgeByPath?.[w.path];
  const pinned = !!env.custom[w.path]?.pinned;
  const archived = placement === "archived";
  // The stage the Dashboard shows: the pull request's, unless moved by hand.
  const derivedStage = derivedRowStage(badge);
  const stage = effectiveStage(env.stagePins[w.path], derivedStage);
  const hasDiff = !!badge && (badge.added > 0 || badge.removed > 0);
  // Since anything landed on this workspace, read off its own HEAD commit, so
  // it says when work last arrived, not when you last clicked the row.
  const age = relativeAgeFromSecs(w.head_committed_at ?? 0, {
    style: "compact",
    now: env.now,
    empty: "",
  });
  // This branch is mid-flight on a machine that isn't this one. Locally the
  // checkout is idle, so without the mark you'd start a second agent on it.
  const cloud = badge?.cloud;
  // Never the repository's own checkout (removing it would take the
  // repository with it) and never the one you are in.
  const canRemove = !!env.actions.onRemoveWorktree && !w.is_main && !isActive;
  const removeBlockedWhy = canRemove
    ? null
    : w.is_main
      ? "This is the repository's own checkout, not a separate workspace. Removing it would take the repository with it."
      : isActive
        ? `You're working in ${title} right now. Open another workspace first, then you can remove this one.`
        : null;
  const switchNo = env.switchNoByPath.get(w.path) ?? null;
  const { picked, pickTitle, toggle } = pick.pickRow(localPlace(w.path));
  const activate = () => (pick.picking ? toggle() : env.actions.onOpenWorktree?.(w.path));
  const entries = () =>
    workspaceMenu(
      {
        root,
        path: w.path,
        title,
        branch: w.branch,
        isMain: w.is_main,
        canRemove,
        removeBlockedWhy,
        switchNo,
        unread: unread
          ? true
          : agents.length > 0 || (!isActive && (loadSnapshot(w.path)?.agentTabs.length ?? 0) > 0)
            ? false
            : null,
        pinned,
        archived,
        pr: badge?.pr && badge.pr.state.toLowerCase() === "open" ? badge.pr.number : null,
        movedToCloud: movedAway?.workspaceId ?? null,
        stage,
        derivedStage,
      },
      {
        actions: env.actions,
        startRename: env.startRename,
        moveTo: env.moveToSection?.(w.path),
      },
    );
  // The repository's own checkout is the repository, not a workspace a
  // section or "Pinned" holds, and an archived one is put back first.
  const drag = !w.is_main && !archived && !pick.picking ? env.dragRow?.(w.path) : undefined;

  if (env.renaming?.key === w.path && env.renaming.at === "workspace") {
    return (
      <div className="ui-roster-row">
        <RosterRename env={env} placeholder={title} label="Workspace name" />
      </div>
    );
  }

  // While a pick is up the status icon becomes this row's checkbox, so the
  // mark you click is the mark that says whether it's in. While Command is
  // held it becomes the row's quick-switch number.
  const quiet = !isWorking && !unread;
  const icon = pick.picking ? (
    <PickMark on={picked} />
  ) : env.cmdHeld && switchNo != null ? (
    <span className="ui-roster-switch-no">{switchNo}</span>
  ) : placement !== "repository" && quiet ? (
    <span className="ui-roster-row-repo" title={repo.name}>
      <ProjectAvatar root={root} name={repo.name} emoji={repo.emoji ?? null} />
    </span>
  ) : undefined;
  const status = icon
    ? undefined
    : rowStatus({ working: isWorking, attention, badge, isMain: w.is_main });
  const unarchive = () => setWorkspaceArchived(w.path, false);

  // The branch's pull request by number; the status mark says where it stands.
  const prMark = badge?.pr;
  const trailing =
    cloud || movedAway || prMark || hasDiff || age ? (
      <span className="ui-roster-trailing">
        {movedAway && !cloud && (
          <span title={`Moved to the cloud, on ${movedAway.machine}. The work carries on there`}>
            <CloudGlyph size={13} label={`Moved to the cloud, on ${movedAway.machine}`} />
          </span>
        )}
        {cloud && (
          <CloudGlyph
            size={13}
            // It breathes only while a box actually holds the job; queued
            // work nobody has picked up is still.
            pulse={cloud.status !== "submitted"}
            label={
              cloud.status === "submitted"
                ? `Queued for a machine. ${labelForAgentId(cloud.agent)} hasn't started yet`
                : `Running on your machine in the cloud. ${labelForAgentId(cloud.agent)}`
            }
          />
        )}
        {prMark && (
          <span className="ui-roster-pr-number" title={prNumberTitle(prMark)}>
            #{prMark.number}
          </span>
        )}
        {hasDiff ? (
          <DiffCount added={badge.added} removed={badge.removed} />
        ) : (
          // With a pull request its number is the row's date line; the age
          // only fills an otherwise empty slot.
          age &&
          !prMark && <span title={`Last commit on this workspace · ${age} ago`}>{age}</span>
        )}
      </span>
    ) : undefined;

  return (
    <HoverCard openDelay={450} closeDelay={150} open={hover.open} onOpenChange={hover.onOpenChange}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <HoverCardTrigger asChild ref={hover.triggerRef}>
            <div
              className="ui-workspace-hover-trigger ui-roster-row"
              data-working={isWorking || undefined}
              data-picked={picked || undefined}
              data-placement={placement === "repository" ? undefined : placement}
              data-archived={archived || undefined}
              data-section-row={placement === "section" ? w.path : undefined}
              title={pick.picking ? pickTitle : undefined}
            >
              <SidebarItem
                label={title}
                revealKey={`workspace:${w.path}`}
                icon={icon}
                status={status}
                selected={isActive && !env.pageUp}
                unread={unread}
                trailing={trailing}
                onClick={activate}
                onPointerDown={drag?.onPointerDown}
                actions={
                  <>
                    {archived && (
                      <Button
                        size="iconXs"
                        variant="ghost"
                        aria-label="Unarchive workspace"
                        title="Unarchive. Put it back in your list"
                        onClick={unarchive}
                      >
                        <ArchiveRestore />
                      </Button>
                    )}
                    <RosterActionsMenu aria-label="Workspace actions" entries={entries} />
                  </>
                }
              />
            </div>
          </HoverCardTrigger>
        </ContextMenuTrigger>
        <RosterContextMenuContent entries={entries} />
      </ContextMenu>
      {!pick.picking && (
        <CopyHoverPreview
          target={{ worktree: w, root, repositoryName: repo.name, emoji: repo.emoji, title }}
          env={env}
        />
      )}
    </HoverCard>
  );
}

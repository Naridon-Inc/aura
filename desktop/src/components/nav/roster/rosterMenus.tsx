// What each kind of row in the workspace list offers. A repository, one of its
// workspaces, and a place that is not on this computer (a machine, or cloud
// work that has not resolved one yet) each get one list of entries, drawn by
// both the right-click menu and the row's "…" button.

import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CircleDashed,
  Columns2,
  Copy,
  FolderOpen,
  FolderSearch,
  GitBranch,
  GitBranchPlus,
  LayoutGrid,
  Mail,
  MailOpen,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Settings,
  Server,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { CloudGlyph } from "../../ui/cloud-glyph";
import {
  WORKSPACE_STAGES,
  WorkspaceStageIcon,
  type WorkspaceStage,
} from "../../ui/workspace-preview-card";
import { requestNoteToWorkspace } from "../../workpanes/workspaces/SayToWorktreeDialog";
import { requestContinueInCloud } from "../../cloudplace/ContinueInCloudDialog";
import { PUBLIC_ROW_PREFIX } from "../../cloudplace/cloudRows";
import { openCloudWorkspace } from "../../../lib/cloudPlace";
import { forgetMovedToCloud } from "../../../lib/movedToCloud";
import { basename } from "../../../lib/paths";
import { api } from "../../../lib/api";
import { openRemoteWorkspace, setWorkspaceRead } from "../../../lib/editorStore";
import { beginClubPick } from "../../../lib/clubGesture";
import { localPlace, remotePlaceOf, type RemotePlaceRef } from "../../../lib/placeRef";
import { openPopout } from "../../../lib/popout";
import { setWorkspaceStage } from "../../../lib/workspaceStage";
import {
  setWorkspaceArchived,
  setWorkspaceEmoji,
  setWorkspacePinned,
} from "../../../lib/workspaceCustomization";
import type { MenuEntry } from "./rosterMenu";
import type { Customization, Renaming, RosterActions } from "./rosterTypes";

const ICON = 14;

export async function copyPath(p: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(p);
  } catch {
    /* clipboard may be unavailable; nothing else to do */
  }
}

export async function revealPath(p: string): Promise<void> {
  try {
    await api.fsRevealInFinder(p);
  } catch {
    /* the file manager may refuse; nothing else to do */
  }
}

export function newWorkspace(repoRoot: string, createFrom = false): void {
  window.dispatchEvent(
    new CustomEvent("aura:new-workspace", {
      detail: createFrom ? { repoRoot, createFrom: true } : { repoRoot },
    }),
  );
}

const SEPARATOR: MenuEntry = { kind: "separator" };

export function repositoryMenu(input: {
  id: string;
  name: string;
  custom: Customization;
  actions: RosterActions;
  startRename: (key: string, at: Renaming["at"]) => void;
  pickIcon: (id: string) => void;
  /** "Move to section", where this list has sections. */
  moveTo?: MenuEntry | null;
}): MenuEntry[] {
  const { id, name, custom, actions, startRename, pickIcon } = input;
  const pinned = !!custom[id]?.pinned;
  const archived = typeof custom[id]?.archived === "number";
  const out: MenuEntry[] = [
    { kind: "label", text: name, title: id },
    {
      kind: "item",
      label: "New workspace",
      icon: <Plus size={ICON} />,
      onSelect: () => newWorkspace(id),
    },
    {
      kind: "item",
      label: "Create from…",
      icon: <GitBranchPlus size={ICON} />,
      shortcut: "⌘⇧N",
      onSelect: () => newWorkspace(id, true),
    },
    // Beside the two "make me another workspace" actions, because that is what
    // it is: a workspace of THIS repository on a computer that isn't this one.
    {
      kind: "item",
      label: "Connect a machine…",
      icon: <CloudGlyph size={ICON} />,
      title: "Run agents on a box that isn't this laptop, working on this repository",
      onSelect: () => openRemoteWorkspace({ repoRoot: id }),
    },
    // The machines already connected, as a list to open one from or check
    // whether it is online.
    {
      kind: "item",
      label: "Machines",
      icon: <Server size={ICON} />,
      title: "Every machine your agents can run on",
      onSelect: () => window.dispatchEvent(new CustomEvent("aura:open-machines")),
    },
  ];
  // Recovery, with the other "my workspaces" actions: when a crash makes
  // worktrees fall off this list while their folders still exist, this finds
  // them and attaches them back.
  if (actions.onFindWorktrees) {
    const find = actions.onFindWorktrees;
    out.push({
      kind: "item",
      label: "Find missing worktrees…",
      icon: <FolderSearch size={ICON} />,
      title: "Scan this repository's worktree folder for checkouts that fell off this list, and attach them back",
      onSelect: () => find(id),
    });
  }
  if (actions.onOpenAllCopies) {
    const all = actions.onOpenAllCopies;
    out.push({
      kind: "item",
      label: "Show all workspaces",
      icon: <LayoutGrid size={ICON} />,
      onSelect: () => all(id),
    });
  }
  out.push(SEPARATOR, {
    kind: "item",
    label: "Repository settings",
    icon: <Settings size={ICON} />,
    onSelect: () => {
      // Scope settings to this repository first, then land on its pane.
      actions.onSelectProject?.(id);
      window.dispatchEvent(
        new CustomEvent("aura:open-settings", { detail: { pane: "copies" } }),
      );
    },
  });
  if (!archived) {
    out.push({
      kind: "item",
      label: "Rename repository",
      icon: <Pencil size={ICON} />,
      keepFocus: true,
      onSelect: () => startRename(id, "repository"),
    });
  }
  out.push({
    kind: "item",
    label: "Change icon",
    icon: <SmilePlus size={ICON} />,
    keepFocus: true,
    onSelect: () => pickIcon(id),
  });
  if (custom[id]?.emoji) {
    out.push({
      kind: "item",
      label: "Reset icon",
      icon: <RotateCcw size={ICON} />,
      onSelect: () => setWorkspaceEmoji(id, undefined),
    });
  }
  out.push({
    kind: "item",
    label: "Copy path",
    icon: <Copy size={ICON} />,
    onSelect: () => void copyPath(id),
  });
  if (!archived) {
    out.push({
      kind: "item",
      label: pinned ? "Unpin repository" : "Pin repository",
      icon: pinned ? <PinOff size={ICON} /> : <Pin size={ICON} />,
      onSelect: () => setWorkspacePinned(id, !pinned),
    });
    if (input.moveTo) out.push(input.moveTo);
  }
  out.push(
    SEPARATOR,
    archived
      ? {
          kind: "item",
          label: "Restore repository",
          icon: <ArchiveRestore size={ICON} />,
          title: "Puts it back in your list",
          onSelect: () => setWorkspaceArchived(id, false),
        }
      : {
          kind: "item",
          label: "Archive repository",
          icon: <Archive size={ICON} />,
          title: "Hides it from your list. Your branch and files stay put",
          onSelect: () => setWorkspaceArchived(id, true),
        },
  );
  if (actions.onCloseProject) {
    const close = actions.onCloseProject;
    out.push({
      kind: "item",
      label: "Remove repository",
      icon: <Trash2 size={ICON} />,
      destructive: true,
      title: "Removes it from your list. Your branch and files stay on disk",
      onSelect: () => close(id),
    });
  }
  return out;
}

/** The workspace a row stands for, as its menu needs it. */
export type WorkspaceMenuTarget = {
  root: string;
  path: string;
  title: string;
  branch: string;
  /** The repository's main checkout, which the record calls `main`. */
  isMain: boolean;
  canRemove: boolean;
  /** Why Remove is greyed, in the user's terms, including what to do about
   *  it. Two different facts block it, and the menu names the one that
   *  applies to the row you opened. `null` when Remove is available. */
  removeBlockedWhy: string | null;
  /** This workspace's ⌘-hold quick-switch number, when it has one. */
  switchNo: number | null;
  /** A chat here is waiting for you (true), none is (false), or no agent has
   *  run here, so there is nothing to mark (null). */
  unread: boolean | null;
  pinned: boolean;
  archived: boolean;
  /** The branch's open pull request, when it has one. */
  pr?: number | null;
  /** The cloud workspace this one's work moved to, when it moved. */
  movedToCloud?: string | null;
  /** Where the work stands, as the Dashboard shows it, and where its pull
   *  request alone would put it. */
  stage: WorkspaceStage;
  derivedStage: WorkspaceStage;
};

export function workspaceMenu(
  menu: WorkspaceMenuTarget,
  input: {
    actions: RosterActions;
    startRename: (key: string, at: Renaming["at"]) => void;
    /** "Move to section", offered beside "Set status" when given. */
    moveTo?: MenuEntry | null;
  },
): MenuEntry[] {
  const { actions, startRename } = input;
  const out: MenuEntry[] = [{ kind: "label", text: menu.title, title: menu.path }];
  if (menu.unread !== null) {
    const read = menu.unread;
    out.push({
      kind: "item",
      label: read ? "Mark as read" : "Mark as unread",
      icon: read ? <MailOpen size={ICON} /> : <Mail size={ICON} />,
      shortcut: "R",
      key: "r",
      onSelect: () => void setWorkspaceRead(menu.path, read),
    });
  }
  // The repository's own checkout is pinned and archived as the repository,
  // from the repository's menu: it is the same key.
  if (!menu.isMain) {
    out.push({
      kind: "item",
      label: menu.pinned ? "Unpin" : "Pin",
      icon: menu.pinned ? <PinOff size={ICON} /> : <Pin size={ICON} />,
      shortcut: "P",
      key: "p",
      onSelect: () => setWorkspacePinned(menu.path, !menu.pinned),
    });
  }
  out.push(
    {
      kind: "sub",
      label: "Set status",
      icon: <CircleDashed size={ICON} />,
      entries: WORKSPACE_STAGES.map((s) => ({
        kind: "item",
        label: s.label,
        icon: <WorkspaceStageIcon stage={s.id} />,
        checked: s.id === menu.stage,
        onSelect: () => setWorkspaceStage(menu.path, s.id, menu.derivedStage),
      })),
    },
    ...(input.moveTo && !menu.isMain && !menu.archived ? [input.moveTo] : []),
    {
      kind: "item",
      label: "Rename",
      icon: <Pencil size={ICON} />,
      keepFocus: true,
      onSelect: () => startRename(menu.path, "workspace"),
    },
    SEPARATOR,
    {
      kind: "item",
      label: "Open workspace",
      icon: <ArrowUpRight size={ICON} />,
      shortcut: menu.switchNo != null && menu.switchNo <= 9 ? `⌘${menu.switchNo}` : undefined,
      onSelect: () => actions.onOpenWorktree?.(menu.path),
    },
    {
      kind: "item",
      label: "Open in new window",
      icon: <AppWindow size={ICON} />,
      onSelect: () =>
        void openPopout({
          kind: "workspace",
          root: menu.path,
          title: menu.title,
        }),
    },
  );
  if (menu.branch) {
    out.push({
      kind: "item",
      label: "Copy branch name",
      icon: <GitBranch size={ICON} />,
      onSelect: () => void copyPath(menu.branch),
    });
  }
  // The branch, its pull request, its uncommitted edits and its chat moved
  // to the team's cloud computer: pushes from there land on the same PR.
  // Once moved, the row leads to where the work went instead.
  const movedTo = menu.movedToCloud;
  if (movedTo) {
    out.push(
      {
        kind: "item",
        label: "Open in cloud",
        icon: <CloudGlyph size={ICON} />,
        title: "This workspace's work moved to the cloud and carries on there",
        onSelect: () => openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${movedTo}`),
      },
      {
        kind: "item",
        label: "Work on it here again",
        icon: <RotateCcw size={ICON} />,
        title: "Clears the moved mark. The cloud workspace stays as it is; archive it there if nobody needs it",
        onSelect: () => forgetMovedToCloud(menu.path),
      },
    );
  } else if (menu.branch && !menu.archived) {
    out.push({
      kind: "item",
      label: "Move to cloud…",
      icon: <CloudGlyph size={ICON} />,
      title: menu.pr ? `Move pull request #${menu.pr} to your team's cloud computer` : "Move this branch to your team's cloud computer",
      onSelect: () =>
        requestContinueInCloud({
          path: menu.path,
          branch: menu.branch,
          title: menu.title,
          pr: menu.pr ?? null,
          isMain: menu.isMain,
        }),
    });
  }
  out.push(
    {
      kind: "item",
      label: "New workspace",
      icon: <Plus size={ICON} />,
      onSelect: () => newWorkspace(menu.root),
    },
    // The second door into the side-by-side gesture, starting from a row you
    // already have your finger on: this workspace goes in, the bar comes up,
    // and the list asks for the other place.
    {
      kind: "item",
      label: "Put side by side…",
      icon: <Columns2 size={ICON} />,
      title: "Work in this and another at once. Pick the second row next",
      onSelect: () => beginClubPick(localPlace(menu.path)),
    },
    // Whoever works here next, person or agent, reads it before starting.
    // The record names the main checkout `main` and every other one by its
    // folder name.
    {
      kind: "item",
      label: "Send a note…",
      icon: <MessageSquare size={ICON} />,
      title: "Leave a line for whoever works in this workspace next",
      onSelect: () =>
        requestNoteToWorkspace({
          repoRoot: menu.root,
          toWorktree: menu.isMain ? "main" : basename(menu.path),
          label: menu.title,
        }),
    },
    SEPARATOR,
    {
      kind: "item",
      label: "Copy path",
      icon: <Copy size={ICON} />,
      onSelect: () => void copyPath(menu.path),
    },
    {
      kind: "item",
      label: "Reveal in Finder",
      icon: <FolderOpen size={ICON} />,
      onSelect: () => void revealPath(menu.path),
    },
  );
  if (!menu.isMain) {
    // Off the list, not off the disk: the branch and files stay, and
    // Unarchive puts the row back.
    out.push(
      SEPARATOR,
      menu.archived
        ? {
            kind: "item",
            label: "Unarchive",
            icon: <RotateCcw size={ICON} />,
            onSelect: () => setWorkspaceArchived(menu.path, false),
          }
        : {
            kind: "item",
            label: "Archive",
            icon: <Archive size={ICON} />,
            title: "Hides it from your list. Its branch and files stay on disk",
            onSelect: () => setWorkspaceArchived(menu.path, true),
          },
    );
  }
  if (actions.onRemoveWorktree) {
    const remove = actions.onRemoveWorktree;
    // With Archive when there is one: the two ways a row leaves the list.
    if (menu.isMain) out.push(SEPARATOR);
    out.push({
      kind: "item",
      label: "Remove workspace…",
      icon: <Trash2 size={ICON} />,
      destructive: true,
      disabled: !menu.canRemove,
      title: menu.canRemove
        ? "Deletes this workspace's checkout from disk"
        : (menu.removeBlockedWhy ?? "This workspace can't be removed"),
      note: menu.canRemove ? null : menu.removeBlockedWhy,
      onSelect: () => {
        if (menu.canRemove) remove(menu.root, menu.path);
      },
    });
  }
  return out;
}

/** A place that isn't on this laptop. It gets the same moves a local
 *  workspace gets, because it is the same kind of thing: somewhere you can
 *  go, and somewhere you can open in a window of its own. */
export type PlaceMenuTarget = {
  place: RemotePlaceRef;
  title: string;
  subtitle: string;
  openLabel: string;
};

export function placeMenu(menu: PlaceMenuTarget): MenuEntry[] {
  return [
    { kind: "label", text: menu.title, title: menu.subtitle },
    {
      kind: "item",
      label: menu.openLabel,
      icon: <CloudGlyph size={ICON} />,
      onSelect: () => openRemoteWorkspace(remotePlaceOf(menu.place)),
    },
    // The window that opens comes up standing on this machine (its shell, its
    // sessions, its agents), not in the local checkout of the same repository.
    // This window is not asked to give the machine up: a second window has its
    // own copy of everything, and the sessions live on the box.
    {
      kind: "item",
      label: "Open in its own window",
      icon: <AppWindow size={ICON} />,
      title: "A second Aura window standing there. This one stays where it is",
      onSelect: () =>
        void openPopout({
          kind: "workspace",
          root: menu.place.repoRoot ?? "",
          place: menu.place,
          title: `Aura. ${menu.title}`,
        }),
    },
  ];
}

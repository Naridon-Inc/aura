// The section menus, written as entry lists for the list's one-menu-two-doors
// drawing (rosterMenu): a section's own menu, and the "Move to section"
// submenu a workspace row and a repository's header carry.

import { FolderInput, FolderMinus, Pencil, Plus, SquarePlus, Trash2 } from "lucide-react";
import { setWorkspacePinned } from "../../../../lib/workspaceCustomization";
import type { MenuEntry } from "../rosterMenu";
import { reposOf, type RosterSectionDef } from "./sectionModel";
import { deleteSection, putInSection, putRepoInSection } from "./sectionStore";
import { openSectionDialog } from "./sectionDialogState";
import { createWorkspaceInSection } from "./sectionCreate";

const ICON = 14;

const glyph = (emoji?: string) =>
  emoji ? (
    <span className="ui-section-menu-glyph" aria-hidden>
      {emoji}
    </span>
  ) : (
    <span className="ui-section-menu-glyph" aria-hidden />
  );

export function sectionMenu(section: RosterSectionDef): MenuEntry[] {
  return [
    {
      kind: "item",
      label: "Create workspace",
      icon: <SquarePlus size={ICON} />,
      onSelect: () => createWorkspaceInSection(section.id),
    },
    {
      kind: "item",
      label: "Edit section",
      icon: <Pencil size={ICON} />,
      keepFocus: true,
      onSelect: () => openSectionDialog({ mode: "edit", id: section.id }),
    },
    {
      kind: "item",
      label: "New section…",
      icon: <Plus size={ICON} />,
      keepFocus: true,
      onSelect: () => openSectionDialog({ mode: "new", before: section.id }),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Delete section",
      icon: <Trash2 size={ICON} />,
      destructive: true,
      title: "Its workspaces and repositories go back to My workspaces",
      onSelect: () => deleteSection(section.id),
    },
  ];
}

/** "Move to section" for the workspace at `path`: every section, the one it
 *  is in checked, then a new section to put it in, and a way out. */
export function moveToSectionEntry(
  path: string,
  sections: readonly RosterSectionDef[],
): MenuEntry {
  return moveEntry({
    sections,
    current: sections.find((s) => s.paths.includes(path)),
    into: (id) => {
      // A workspace is listed once: going into a section takes it out of
      // "Pinned".
      setWorkspacePinned(path, false);
      putInSection(path, id);
    },
    newSection: () => openSectionDialog({ mode: "new", movePath: path }),
    out: () => putInSection(path, null),
  });
}

/** "Move to section" for a whole repository, from its header's menu: the
 *  same choices, filing the repository with all its workspaces. */
export function moveRepoToSectionEntry(
  repoId: string,
  sections: readonly RosterSectionDef[],
): MenuEntry {
  return moveEntry({
    sections,
    current: sections.find((s) => reposOf(s).includes(repoId)),
    into: (id) => {
      // Listed once, as a workspace is: filed in a section, it is unpinned.
      setWorkspacePinned(repoId, false);
      putRepoInSection(repoId, id);
    },
    newSection: () => openSectionDialog({ mode: "new", moveRepo: repoId }),
    out: () => putRepoInSection(repoId, null),
  });
}

function moveEntry(input: {
  sections: readonly RosterSectionDef[];
  current: RosterSectionDef | undefined;
  into: (sectionId: string) => void;
  newSection: () => void;
  out: () => void;
}): MenuEntry {
  const { sections, current, into } = input;
  const entries: MenuEntry[] = sections.map((s) => ({
    kind: "item",
    label: s.name,
    icon: glyph(s.emoji),
    checked: s.id === current?.id,
    disabled: s.id === current?.id,
    onSelect: () => into(s.id),
  }));
  if (entries.length > 0) entries.push({ kind: "separator" });
  entries.push({
    kind: "item",
    label: "New section…",
    icon: <Plus size={ICON} />,
    keepFocus: true,
    onSelect: input.newSection,
  });
  if (current) {
    entries.push({
      kind: "item",
      label: "Remove from section",
      icon: <FolderMinus size={ICON} />,
      onSelect: input.out,
    });
  }
  return { kind: "sub", label: "Move to section", icon: <FolderInput size={ICON} />, entries };
}

// Dragging in the workspace list, on pointer events (the desktop app's web
// view never delivers an HTML5 drop): a workspace, or a whole repository by
// its header, into a section at a spot, onto "Pinned", or back under "My
// workspaces"; a section above or below another. While a workspace or a
// repository is carried over a section a line marks the gap it will land in;
// a section carried over another marks the edge.

import { useState } from "react";
import { usePointerDrag, type DragAt } from "../../../ui/use-pointer-drag";
import { setWorkspacePinned } from "../../../../lib/workspaceCustomization";
import {
  insertIndexAt,
  sectionDropIndex,
  type RosterSectionDef,
} from "./sectionModel";
import { moveSection, putInSection, putRepoInSection } from "./sectionStore";

export type Carried =
  | { kind: "workspace"; path: string }
  | { kind: "repo"; id: string }
  | { kind: "section"; id: string };

export const PINNED_DROP = "pinned";
export const MAIN_DROP = "main";
const SECTION_DROP = "section:";
export const sectionDrop = (id: string) => `${SECTION_DROP}${id}`;
const sectionOf = (key: string | undefined) =>
  key?.startsWith(SECTION_DROP) ? key.slice(SECTION_DROP.length) : null;

/** The line drawn while dragging: `top` in pixels inside the section `key`. */
export type DropLine = { key: string; top: number };

type Landing = { index: number; line: DropLine | null };

/** Where a workspace (or a repository) released at `y` inside a section
 *  lands, and the line that says so, measured from the section's own rows
 *  (or its repositories) less the one carried. `attr` is the data attribute
 *  each of those carries, holding its path or id. */
function listLanding(
  attr: "sectionRow" | "sectionRepo",
  carried: string,
  key: string,
  el: HTMLElement,
  y: number,
): Landing {
  const selector = attr === "sectionRow" ? "[data-section-row]" : "[data-section-repo]";
  const rows = [...el.querySelectorAll<HTMLElement>(selector)].filter(
    (row) => row.dataset[attr] !== carried,
  );
  const boxes = rows.map((row) => row.getBoundingClientRect());
  const index = insertIndexAt(
    boxes.map((b) => b.top + b.height / 2),
    y,
  );
  if (boxes.length === 0) return { index, line: null };
  const origin = el.getBoundingClientRect().top;
  const edge =
    index === 0
      ? boxes[0].top
      : index === boxes.length
        ? boxes[boxes.length - 1].bottom
        : (boxes[index - 1].bottom + boxes[index].top) / 2;
  return { index, line: { key, top: Math.round(edge - origin) - 1 } };
}

/** Where a section released over section `over` lands: above it on its upper
 *  half, below it on its lower half. */
function sectionLanding(
  sections: readonly RosterSectionDef[],
  id: string,
  over: string,
  key: string,
  el: HTMLElement,
  y: number,
): Landing {
  const box = el.getBoundingClientRect();
  const lower = y > box.top + box.height / 2;
  return {
    index: sectionDropIndex(sections, id, over, lower),
    line: { key, top: lower ? Math.round(box.height) + 4 : -5 },
  };
}

function landing(
  sections: readonly RosterSectionDef[],
  item: Carried,
  key: string | undefined,
  at: DragAt,
): Landing | null {
  const over = sectionOf(key);
  if (!over || !key || !at.element) return null;
  if (item.kind === "workspace") return listLanding("sectionRow", item.path, key, at.element, at.y);
  if (item.kind === "repo") return listLanding("sectionRepo", item.id, key, at.element, at.y);
  if (item.id === over) return null;
  return sectionLanding(sections, item.id, over, key, at.element, at.y);
}

/** A repository released on `key`: onto "Pinned" it is pinned, onto "My
 *  workspaces" it is back in no section, into a section it is filed there at
 *  the gap the line marked. It is listed in one place, so each takes it out
 *  of the others. */
function dropRepo(id: string, key: string, land: Landing | null): void {
  if (key === PINNED_DROP) {
    putRepoInSection(id, null);
    setWorkspacePinned(id, true);
    return;
  }
  if (key === MAIN_DROP) {
    putRepoInSection(id, null);
    setWorkspacePinned(id, false);
    return;
  }
  const into = sectionOf(key);
  if (!into || !land) return;
  setWorkspacePinned(id, false);
  putRepoInSection(id, into, land.index);
}

export function useSectionDrag(sections: readonly RosterSectionDef[], scope: string) {
  const [line, setLine] = useState<DropLine | null>(null);

  const drop = (item: Carried, key: string, at: DragAt) => {
    setLine(null);
    if (item.kind === "section") {
      const land = landing(sections, item, key, at);
      if (land) moveSection(item.id, land.index);
      return;
    }
    if (item.kind === "repo") {
      dropRepo(item.id, key, landing(sections, item, key, at));
      return;
    }
    if (key === PINNED_DROP) {
      putInSection(item.path, null);
      setWorkspacePinned(item.path, true);
      return;
    }
    if (key === MAIN_DROP) {
      putInSection(item.path, null);
      setWorkspacePinned(item.path, false);
      return;
    }
    const into = sectionOf(key);
    const land = landing(sections, item, key, at);
    if (!into || !land) return;
    setWorkspacePinned(item.path, false);
    putInSection(item.path, into, land.index);
  };

  const drag = usePointerDrag<Carried>(drop, {
    scope,
    onMove: (item, key, at) => {
      const next = landing(sections, item, key, at)?.line ?? null;
      setLine((cur) =>
        cur?.key === next?.key && cur?.top === next?.top ? cur : next,
      );
    },
  });

  return {
    drag,
    /** Drawn only while a drag is on: Escape or a release elsewhere ends it
     *  with no drop to clear it. */
    line: drag.dragged ? line : null,
    /** A workspace is being carried, so the places it can land light up. */
    carryingWorkspace: drag.dragged?.kind === "workspace",
    /** The repository being carried by its header, if one is. */
    carriedRepo: drag.dragged?.kind === "repo" ? drag.dragged.id : null,
    draggedSection: drag.dragged?.kind === "section" ? drag.dragged.id : null,
  };
}

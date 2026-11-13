// Sections: named, ordered groups of workspaces you make yourself, drawn
// between "Pinned" and "My workspaces". A section holds single workspaces and
// whole repositories, each repository drawn under it with its own header. This file is the pure half: what a
// list of sections looks like after each change, and where a drag that is
// released at a height lands. The store (sectionStore) keeps the list and
// hands it out; nothing here reads storage or the page.

export type RosterSectionDef = {
  id: string;
  name: string;
  /** The glyph drawn before the name, when one was chosen. */
  emoji?: string;
  /** Workspace paths, in the order they are listed. */
  paths: string[];
  /** Repositories filed here whole, by id, in the order they are listed.
   *  Saved before repositories could be filed, a section has none. */
  repos?: string[];
};

/** The fold key for a section. Repository keys are absolute paths and the
 *  pinned key is ":pinned", so this never collides with either. */
export const sectionKey = (id: string) => `:section:${id}`;

const isDef = (v: unknown): v is RosterSectionDef => {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    (s.emoji === undefined || typeof s.emoji === "string") &&
    Array.isArray(s.paths) &&
    s.paths.every((p) => typeof p === "string") &&
    (s.repos === undefined ||
      (Array.isArray(s.repos) && s.repos.every((r) => typeof r === "string")))
  );
};

/** The repositories a section holds, none for one saved without any. */
export const reposOf = (s: RosterSectionDef): readonly string[] => s.repos ?? [];

/** The saved list, or none at all when what was saved is not a list of
 *  sections (an older shape, or a hand edit gone wrong). */
export function parseSections(raw: string | null): RosterSectionDef[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isDef) : [];
  } catch {
    return [];
  }
}

/** A name with its surrounding space taken off; empty means unusable. */
export const sectionName = (name: string) => name.trim();

/** What a section made with the name field left empty is called. The
 *  dialog's field shows it as its placeholder, so Create never does nothing:
 *  pressing it on an empty field makes the section the field promised. */
export const NEW_SECTION_NAME = "New section";

/** The name a new section gets: what was typed, or, when nothing was,
 *  "New section", numbered past any section already called that. */
export function nameForNewSection(typed: string, list: readonly RosterSectionDef[]): string {
  const name = sectionName(typed);
  if (name) return name;
  const taken = new Set(list.map((s) => s.name));
  if (!taken.has(NEW_SECTION_NAME)) return NEW_SECTION_NAME;
  let n = 2;
  while (taken.has(`${NEW_SECTION_NAME} ${n}`)) n += 1;
  return `${NEW_SECTION_NAME} ${n}`;
}

/** The list with a new, empty section added before `before`, or at the end
 *  when there is no such section. */
export function withSection(
  list: readonly RosterSectionDef[],
  section: { id: string; name: string; emoji?: string },
  before?: string,
): RosterSectionDef[] {
  const made: RosterSectionDef = {
    id: section.id,
    name: sectionName(section.name),
    ...(section.emoji ? { emoji: section.emoji } : {}),
    paths: [],
  };
  const at = before ? list.findIndex((s) => s.id === before) : -1;
  const next = [...list];
  next.splice(at < 0 ? next.length : at, 0, made);
  return next;
}

export function withSectionEdited(
  list: readonly RosterSectionDef[],
  id: string,
  edit: { name: string; emoji?: string },
): RosterSectionDef[] {
  return list.map((s) => {
    if (s.id !== id) return s;
    const { emoji: _old, ...rest } = s;
    return { ...rest, name: sectionName(edit.name), ...(edit.emoji ? { emoji: edit.emoji } : {}) };
  });
}

/** The list without the section. Its workspaces go back under their
 *  repositories and its repositories back to "My workspaces"; nothing about
 *  either changes otherwise. */
export function withoutSection(list: readonly RosterSectionDef[], id: string): RosterSectionDef[] {
  return list.filter((s) => s.id !== id);
}

/** The section a workspace is listed in, if any. */
export function sectionOfPath(
  list: readonly RosterSectionDef[],
  path: string,
): RosterSectionDef | undefined {
  return list.find((s) => s.paths.includes(path));
}

/** The list with `path` taken out of whichever section held it and, when
 *  `sectionId` names one, put into that section at `index` (the end when
 *  omitted or past it). A workspace is in at most one section. */
export function withWorkspaceIn(
  list: readonly RosterSectionDef[],
  path: string,
  sectionId: string | null,
  index?: number,
): RosterSectionDef[] {
  return list.map((s) => {
    const kept = s.paths.filter((p) => p !== path);
    if (s.id !== sectionId) return kept.length === s.paths.length ? s : { ...s, paths: kept };
    const at = index === undefined ? kept.length : Math.max(0, Math.min(index, kept.length));
    kept.splice(at, 0, path);
    return { ...s, paths: kept };
  });
}

/** The section a repository is filed under, if any. */
export function sectionOfRepo(
  list: readonly RosterSectionDef[],
  repoId: string,
): RosterSectionDef | undefined {
  return list.find((s) => reposOf(s).includes(repoId));
}

/** The list with repository `repoId` taken out of whichever section held it
 *  and, when `sectionId` names one, filed in that section at `index` among
 *  its repositories (the end when omitted or past it). A repository is in at
 *  most one section. */
export function withRepoIn(
  list: readonly RosterSectionDef[],
  repoId: string,
  sectionId: string | null,
  index?: number,
): RosterSectionDef[] {
  return list.map((s) => {
    const had = reposOf(s);
    const kept = had.filter((r) => r !== repoId);
    if (s.id !== sectionId) return kept.length === had.length ? s : { ...s, repos: kept };
    const at = index === undefined ? kept.length : Math.max(0, Math.min(index, kept.length));
    kept.splice(at, 0, repoId);
    return { ...s, repos: kept };
  });
}

/** The list with section `id` moved to `index`, counted in the list as it is
 *  without that section. */
export function withSectionMoved(
  list: readonly RosterSectionDef[],
  id: string,
  index: number,
): RosterSectionDef[] {
  const moving = list.find((s) => s.id === id);
  if (!moving) return [...list];
  const rest = list.filter((s) => s.id !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, moving);
  return rest;
}

/** Where a drag released at height `y` goes among rows whose vertical middles
 *  are `middles`, top to bottom: before the first row it is above. */
export function insertIndexAt(middles: readonly number[], y: number): number {
  let i = 0;
  while (i < middles.length && middles[i] <= y) i++;
  return i;
}

/** Where section `dragged` lands when released over section `over`, in the
 *  list without `dragged`: before `over` on its upper half, after it on its
 *  lower half. */
export function sectionDropIndex(
  list: readonly RosterSectionDef[],
  dragged: string,
  over: string,
  lowerHalf: boolean,
): number {
  const rest = list.filter((s) => s.id !== dragged);
  const at = rest.findIndex((s) => s.id === over);
  if (at < 0) return rest.length;
  return lowerHalf ? at + 1 : at;
}

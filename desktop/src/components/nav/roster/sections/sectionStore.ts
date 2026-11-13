// The sections you made, kept in this computer's storage and shared by every
// part of the window that draws them, so a change made from a row's menu
// shows in the list at once. Another window of the app sees it through the
// storage event. The shapes and the rules for each change are in
// sectionModel.

import { useSyncExternalStore } from "react";
import {
  parseSections,
  withSection,
  withSectionEdited,
  withRepoIn,
  withSectionMoved,
  withWorkspaceIn,
  withoutSection,
  type RosterSectionDef,
} from "./sectionModel";

const KEY = "aura.roster.sections";

function read(): RosterSectionDef[] {
  try {
    return parseSections(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

let current: RosterSectionDef[] | null = null;
const listeners = new Set<() => void>();

function snapshot(): RosterSectionDef[] {
  if (current === null) current = read();
  return current;
}

function publish(next: RosterSectionDef[]): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the change holds until the window closes */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const fromElsewhere = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    listener();
  };
  window.addEventListener("storage", fromElsewhere);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromElsewhere);
  };
}

const EMPTY: RosterSectionDef[] = [];

export function useRosterSections(): RosterSectionDef[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Make a section, before `before` when given; returns its id. */
export function createSection(input: { name: string; emoji?: string }, before?: string): string {
  const id = newId();
  publish(withSection(snapshot(), { id, ...input }, before));
  return id;
}

export function editSection(id: string, edit: { name: string; emoji?: string }): void {
  publish(withSectionEdited(snapshot(), id, edit));
}

export function deleteSection(id: string): void {
  publish(withoutSection(snapshot(), id));
}

/** Put a workspace in a section at `index`, or take it out of every section
 *  when `sectionId` is null. */
export function putInSection(path: string, sectionId: string | null, index?: number): void {
  publish(withWorkspaceIn(snapshot(), path, sectionId, index));
}

/** File a whole repository in a section at `index` among its repositories,
 *  or take it out of every section when `sectionId` is null. */
export function putRepoInSection(repoId: string, sectionId: string | null, index?: number): void {
  publish(withRepoIn(snapshot(), repoId, sectionId, index));
}

export function moveSection(id: string, index: number): void {
  publish(withSectionMoved(snapshot(), id, index));
}

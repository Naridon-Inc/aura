// "The chat about this project" — one pointer, and now one spelling of it.
//
// `aura.ambient.<root>` is how six surfaces find the conversation a project is
// already having: the rail, the dashboard, the HUD, the launcher, background
// jobs and the turn dispatcher. Each of them spelled the key itself, which was
// fine while the key was a constant and a root.
//
// It stopped being that when a window learned to be in more than one place. A
// project has a copy on this laptop and a copy on every machine you connected,
// and a conversation is about ONE of them — its tools read that disk, run that
// shell, prove that checkout. Two chats about the same project on two different
// machines are two conversations, and a pointer that can only hold one of them
// hands the wrong one back: you stand in a box, ask "the chat about this
// project", and get the one whose hands are on your laptop.
//
// So the place is part of the name. `null` means here, and spells exactly the
// key it always did — pointers written before this still resolve.

import { machineIdForRoot } from "./activeMachine";

/** Where the pointer for `repoRoot` lives, for work running at `machineId`
 *  (`null`/absent = this laptop). */
export function ambientKey(
  repoRoot: string,
  machineId: string | null,
): string {
  const box = machineId?.trim();
  return box ? `aura.ambient.${repoRoot}#${box}` : `aura.ambient.${repoRoot}`;
}

/** The session `repoRoot` is talking to at `machineId`, or null. Unvalidated —
 *  nothing prunes these when a session goes away, so a caller about to OPEN one
 *  should go through `resolveAmbientSession`. */
export function readAmbientSid(
  repoRoot: string | null | undefined,
  machineId: string | null,
): string | null {
  if (!repoRoot) return null;
  try {
    return localStorage.getItem(ambientKey(repoRoot, machineId));
  } catch {
    return null; // private mode — no pointer is a legal answer
  }
}

/** Remember `sid` as the chat about `repoRoot` at `machineId`. */
export function writeAmbientSid(
  repoRoot: string,
  machineId: string | null,
  sid: string,
): void {
  try {
    localStorage.setItem(ambientKey(repoRoot, machineId), sid);
  } catch {
    /* localStorage quota — non-fatal, the pointer is a convenience */
  }
}

/**
 * Are these the same place?
 *
 * The comparison behind every pointer in this file, and the reason it is one
 * function rather than a `===` at each call site: a place is spelled three ways
 * by the time it gets here. The window says `null` for this laptop, the backend
 * says `machine_id: null` for the same thing but may also omit the field
 * entirely, and a request that came through a form can carry `""`. All three
 * mean "this disk", and a check that treats any of them as a fourth place hands
 * back a chat whose tools are on the wrong computer.
 */
export function samePlace(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return (a?.trim() || null) === (b?.trim() || null);
}

/**
 * Where a door pressed RIGHT NOW should start work on `repoRoot`.
 *
 * Every entry point that acts on a user's click asks this rather than assuming
 * "here": ⌘N, the launcher, the HUD's composer, a background job. It is a
 * separate name from `machineIdForRoot` only so the reason is written down at
 * the doors that use it — the value is the same, and deliberately read at the
 * moment of the click, because where the window is standing is exactly what the
 * user was looking at when they pressed it.
 */
export function placeForNewWork(
  repoRoot: string | null | undefined,
): string | null {
  return machineIdForRoot(repoRoot);
}

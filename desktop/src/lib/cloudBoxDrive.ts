// A workspace handed to one of the team's computers, which then answers
// every member's prompt by itself, on the sign-in of whoever started the
// workspace: teammates add to that conversation, they don't bring their own.
//
// No laptop drives such a chat: nothing here opens ssh, starts the agent or
// keeps a lease. Each member sends the normal way, and the computer's answer
// lands on the workspace's log as a reply naming the prompt it answers. All
// this file decides is who may send, what is still being worked on, and which
// computers a workspace can be handed to.

import { invoke } from "@tauri-apps/api/core";

import type { PlaceRoster } from "./api";
import type { CloudMessageRow, CloudWorkspacePlace } from "./cloudWorkspacesApi";

/** The driver a place names when its computer answers by itself. */
export const BOX_DRIVER = "box";
/** Where the computer keeps the projects it works in. */
export const BOX_ROOT = "~/aura-workspaces";
/** The source the computer's answers are stored under. */
export const BOX_SOURCE = "box";

/** Whether the workspace's computer answers every prompt by itself. */
export function isBoxDriven(row: { place?: Pick<CloudWorkspacePlace, "driver"> | null }): boolean {
  return row.place?.driver === BOX_DRIVER;
}

/** One of the team's computers a workspace can be handed to. */
export type BoxComputer = { placeId: string; name: string };

/** The computers that can take a workspace: each one a runner on the team's
 *  board that isn't known to be down. Unlike a chat this laptop drives, the
 *  laptop never reaches the computer, so it needs no entry for it. One row
 *  per runner, though the board may list it more than once. */
export function boxComputersOf(roster: PlaceRoster | null | undefined): BoxComputer[] {
  const seen = new Set<string>();
  const out: BoxComputer[] = [];
  for (const p of roster?.places ?? []) {
    const id = p.runner_id?.trim();
    if (!id || p.online === false || seen.has(id)) continue;
    seen.add(id);
    out.push({ placeId: id, name: p.name.trim() || "the team’s computer" });
  }
  return out;
}

/** What `cloud_box_link` is sent to hand a workspace to `computer`. The
 *  branch is the one the computer checks out for every turn and pushes to;
 *  left out, it works on the repository's default branch. The engine is the
 *  agent it runs: Claude unless the member picked another. */
export function boxLinkFor(computer: BoxComputer, branch?: string | null, engine = "claude") {
  return {
    machine: computer.name,
    remoteRoot: BOX_ROOT,
    branch: branch?.trim() || null,
    engine,
    placeId: computer.placeId,
    driver: BOX_DRIVER,
  };
}

/** Hand the workspace to the computer. Prompts sent from now on are its work. */
export function handToComputer(workspaceId: string, computer: BoxComputer, branch?: string | null, engine?: string) {
  return invoke<unknown>("cloud_box_link", { id: workspaceId, link: boxLinkFor(computer, branch, engine) });
}

/** A computer's answer to a prompt, as opposed to a person's turn. */
export function isBoxAnswer(m: Pick<CloudMessageRow, "role" | "source" | "answers">): boolean {
  return m.role === "assistant" && (m.source === BOX_SOURCE || !!m.answers);
}

/** A computer's answer that says the prompt was not run, and why. */
export function isFailedAnswer(m: Pick<CloudMessageRow, "role" | "source" | "answers" | "failed">): boolean {
  return isBoxAnswer(m) && m.failed === true;
}

function at(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** The prompt the computer is still working on: the newest member prompt
 *  sent since it was given the workspace, while no answer names it. An answer
 *  that names no prompt (an older server) counts for every prompt before it
 *  in the log. Null when nothing is waiting, or before the computer has the
 *  workspace. */
export function waitingPrompt(
  rows: readonly CloudMessageRow[] | null | undefined,
  linkedAt: string | null | undefined,
  /** A member's message addressed to teammates, not the computer: it is on
   *  the log for them and the computer leaves it alone. */
  toPeople: (row: CloudMessageRow) => boolean = () => false,
): CloudMessageRow | null {
  if (!rows?.length) return null;
  const since = at(linkedAt);
  if (!Number.isFinite(since)) return null;
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === "user" && !toPeople(rows[i]!)) {
      last = i;
      break;
    }
  }
  const prompt = last >= 0 ? rows[last]! : null;
  if (!prompt || !(at(prompt.created_at) >= since)) return null;
  const answered = rows.some(
    (r, i) => isBoxAnswer(r) && (r.answers ? r.answers === prompt.id : i > last),
  );
  return answered ? null : prompt;
}

/** Whether this member may send in the workspace's own composer. A computer
 *  that answers by itself takes anyone's prompt; a chat a laptop drives is
 *  sent to through that laptop's chat only. */
export function composerOpen(
  row: { place?: Pick<CloudWorkspacePlace, "driver"> | null; moved?: unknown },
  { readOnly, archived }: { readOnly: boolean; archived: boolean },
): boolean {
  // Moved to a member's computer, the work goes on in the chat there.
  if (readOnly || archived || row.moved) return false;
  return !row.place || isBoxDriven(row);
}

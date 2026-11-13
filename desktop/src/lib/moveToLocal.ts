// Move a cloud workspace to this computer, the other way from "Move to
// cloud": its branch comes into a worktree of the matching project here, its
// conversation into an Aura chat here that goes on with the person's own
// agent, and the cloud workspace is told it moved. Telling it matters: its
// computer stops answering it, so two agents never push the same branch.
//
// Nothing is taken away from the cloud side. The workspace keeps its chat
// and its history, marked with where the work went; GitHub keeps the branch.

import type { BroughtWorktree } from "./api";
import { githubSlugOf, type SeedTurn } from "./cloudBoxChat";
import { isBoxDriven, isFailedAnswer, waitingPrompt } from "./cloudBoxDrive";
import type { CloudMessageRow, CloudWorkspaceRow } from "./cloudWorkspacesApi";

export type MoveToLocalPlan = { ok: false; why: string } | { ok: true; branch: string; repo: string };

type Row = Pick<CloudWorkspaceRow, "status" | "branch" | "place" | "moved">;

/** Whether the workspace can come here now, and if not, why, in a sentence. */
export function planMoveToLocal(
  row: Row,
  /** `owner/name` on GitHub, when the workspace has a repository. */
  repo: string | null | undefined,
  messages: readonly CloudMessageRow[] | null | undefined,
  /** A member's message addressed to teammates: not work the computer owes. */
  toPeople: (row: CloudMessageRow) => boolean = () => false,
): MoveToLocalPlan {
  if (row.moved) {
    return { ok: false, why: `This workspace already moved to ${row.moved.name || "a member’s computer"}. The work goes on there.` };
  }
  if (row.status === "archived" || row.status === "ended") {
    return { ok: false, why: "This workspace is archived. Its chat is kept here, but there’s no work left to move." };
  }
  const branch = row.branch?.trim() || "";
  if (!branch) {
    return {
      ok: false,
      why: "This workspace hasn’t got a branch of its own yet, so there’s nothing to bring to this computer. Once its agent commits, it can move.",
    };
  }
  const name = repo?.trim() || "";
  if (!name) return { ok: false, why: "This workspace isn’t on a GitHub repository, so there’s no branch to fetch." };
  if (isBoxDriven(row) && waitingPrompt(messages ? [...messages] : null, row.place?.linked_at, toPeople)) {
    return {
      ok: false,
      why: `${row.place?.machine || "The cloud computer"} is still working on a prompt. Wait for its answer, then move it, so nothing it pushes is left behind.`,
    };
  }
  return { ok: true, branch, repo: name };
}

/** The most turns copied into the chat here; the oldest go first. */
export const LOCAL_TURNS = 200;

/** The workspace's log as turns of the chat here, oldest first. Answers that
 *  only say a prompt wasn't run are left out, and a teammate's prompt says
 *  whose it was, so the agent here doesn't take it for the person's. */
export function localTurns(rows: readonly CloudMessageRow[], me: string | null): SeedTurn[] {
  const out: SeedTurn[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    if (isFailedAnswer(row) || !row.body.trim()) continue;
    const other = row.role === "user" && row.author_id && row.author_id !== me && row.author_name?.trim();
    const text = other ? `${row.author_name!.trim()}: ${row.body}` : row.body;
    const at = Math.max(0, Math.floor(Date.parse(row.created_at) / 1000) || 0);
    out.push({ role: row.role, text, at, cloud_id: row.id });
  }
  return out.slice(-LOCAL_TURNS);
}

/** The project on this computer whose GitHub origin is `repo`, among the
 *  projects this computer has open. Null when none is. */
export async function findLocalProject(
  repo: string,
  roots: readonly string[],
  originOf: (root: string) => Promise<string | null>,
): Promise<string | null> {
  const wanted = repo.trim().toLowerCase();
  if (!wanted) return null;
  for (const root of roots) {
    const origin = await originOf(root).catch(() => null);
    if (githubSlugOf(origin) === wanted) return root;
  }
  return null;
}

export type MoveToLocalRequest = {
  workspaceId: string;
  branch: string;
  title: string;
  /** The project on this computer the branch comes into. */
  projectRoot: string;
  /** How this computer is shown to the team, e.g. "Sam’s computer". */
  computer: string | null;
  /** Where the work was, for the chat's note. */
  from: string;
  turns: SeedTurn[];
};

export type MoveToLocalDeps = {
  bring: (projectRoot: string, branch: string) => Promise<BroughtWorktree>;
  markMoved: (workspaceId: string, moved: { name: string | null; branch: string | null }) => Promise<unknown>;
  startChat: (path: string, title: string) => Promise<string>;
  /** File the turns onto the (empty) chat. Says whether it filed them. */
  backfill: (sessionId: string, turns: SeedTurn[]) => Promise<boolean>;
  note: (sessionId: string, text: string) => Promise<unknown>;
  /** The folder is worked in here again: drop any "moved to cloud" mark. */
  forgetMoved: (path: string) => void;
};

export type MoveToLocalOutcome = {
  path: string;
  /** The chat the conversation came into, when there was one to bring. */
  sessionId: string | null;
  /** Said when the branch is here but the chat didn't come with it. */
  warning: string | null;
};

/** Bring the branch here, tell the cloud workspace it moved, then copy its
 *  conversation into a chat here. Throws with a sentence the dialog can
 *  show. The branch comes first, so a refusal moves nothing; the cloud is
 *  told before the chat is made, so its computer stops before anyone types
 *  here. A chat that can't be copied only warns: the branch is the work. */
export async function moveToLocal(req: MoveToLocalRequest, deps: MoveToLocalDeps): Promise<MoveToLocalOutcome> {
  let brought: BroughtWorktree;
  try {
    brought = await deps.bring(req.projectRoot, req.branch);
  } catch (e) {
    throw new Error(`Couldn’t bring ${req.branch} to this computer, so nothing was moved: ${errorText(e)}`);
  }
  try {
    await deps.markMoved(req.workspaceId, { name: req.computer, branch: req.branch });
  } catch (e) {
    throw new Error(
      `${req.branch} is on this computer now, in ${brought.path}, but the cloud workspace couldn’t be told it moved, so its computer may still answer and push to it: ${errorText(e)} Try again; the branch won’t be fetched twice.`,
    );
  }
  deps.forgetMoved(brought.path);
  if (!req.turns.length) return { path: brought.path, sessionId: null, warning: null };
  let sessionId: string | null = null;
  try {
    sessionId = await deps.startChat(brought.path, req.title);
    const filed = await deps.backfill(sessionId, req.turns);
    if (!filed) throw new Error("the chat here already had turns of its own.");
    await deps.note(sessionId, `Moved here from ${req.from}. The work goes on on this computer, on ${req.branch}.`).catch(() => undefined);
    return { path: brought.path, sessionId, warning: null };
  } catch (e) {
    return {
      path: brought.path,
      sessionId,
      warning: `${req.branch} is here, but its conversation couldn’t be copied into a chat on this computer: ${errorText(e)} It’s kept in the cloud workspace.`,
    };
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Move a local workspace's branch, and its pull request, to the cloud, so the
// work goes on there and lands on the same branch.
//
// Three things don't travel by themselves, and each gets a plain answer:
//
//  - commits this laptop hasn't pushed: the cloud starts from GitHub's copy
//    of the branch, so they are pushed first, or there is nothing to continue;
//  - uncommitted edits: when the person says so (the default), they are saved
//    in a work-in-progress commit on the branch and pushed with it. Otherwise
//    they stay here. Nothing is stashed or thrown away either way;
//  - the chat: a copy of the last turns goes in as the cloud chat's opening
//    message. It is a note the agent reads, not the agent's own memory.
//
// Two places can take it. The team's cloud computer (`moveToCloud`) answers
// every prompt by itself, so the laptop can close: it checks the branch out
// for each turn and pushes back to it. A machine in this laptop's own book
// (`continueInCloud`) is driven from here instead: `continueBranch` on the box
// chat open checks the branch out as GitHub has it and tracks it.

import type { AheadBehind, ChatTurn } from "./api";
import type { BoxEngine, BoxOpen, BoxTarget } from "./cloudBoxChat";
import type { BoxComputer } from "./cloudBoxDrive";
import type { NewCloudWorkspace } from "./cloudWorkspacesApi";

export type HandoffState = AheadBehind & {
  /** Files with changes git hasn't committed, untracked ones included. */
  uncommitted: number;
};

/** What has to happen on this laptop before the machine can take the branch. */
export type HandoffPlan =
  | { ok: false; why: string }
  | {
      ok: true;
      branch: string;
      /** `publish` when GitHub has never seen the branch. */
      push: "none" | "push" | "publish";
      ahead: number;
      behind: number;
      uncommitted: number;
      /** The uncommitted edits are saved in a commit first and travel. */
      wip: boolean;
    };

const TRUNKS = new Set(["main", "master", "trunk", "develop"]);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `carry`: save uncommitted edits in a commit on the branch so they go too. */
export function planHandoff(state: HandoffState, carry = false): HandoffPlan {
  const branch = state.branch?.trim() || "";
  if (!branch || branch === "HEAD") {
    return { ok: false, why: "This workspace isn’t on a branch, so there’s nothing for the cloud to pick up." };
  }
  if (TRUNKS.has(branch)) {
    return {
      ok: false,
      why: `This workspace is on ${branch}. Continuing in the cloud carries a branch of its own; start a new cloud workspace for work on ${branch}.`,
    };
  }
  if (state.has_upstream && state.ahead > 0 && state.behind > 0) {
    return {
      ok: false,
      why: `${branch} here and on GitHub have both moved on (${plural(state.ahead, "commit")} only here, ${plural(state.behind, "commit")} only on GitHub). Pull first, then continue.`,
    };
  }
  const wip = carry && state.uncommitted > 0;
  if (wip && state.has_upstream && state.behind > 0) {
    return {
      ok: false,
      why: `GitHub has ${plural(state.behind, "commit")} on ${branch} this laptop doesn’t. Pull first, so your uncommitted changes go on top of ${state.behind === 1 ? "it" : "them"}, then move it.`,
    };
  }
  const push = !state.has_upstream ? "publish" : state.ahead > 0 || wip ? "push" : "none";
  return { ok: true, branch, push, ahead: state.ahead, behind: state.behind, uncommitted: state.uncommitted, wip };
}

/** The lines the dialog shows about what happens to this laptop's work. */
export function handoffLines(plan: Extract<HandoffPlan, { ok: true }>): string[] {
  const lines: string[] = [];
  const them = (n: number) => (n === 1 ? "it" : "them");
  if (plan.wip) {
    lines.push(
      `${plural(plan.uncommitted, "file")} with uncommitted changes ${plan.uncommitted === 1 ? "is" : "are"} saved in a work-in-progress commit on ${plan.branch} and go${plan.uncommitted === 1 ? "es" : ""} with it.`,
    );
  }
  const commits = plan.ahead + (plan.wip ? 1 : 0);
  if (plan.push === "publish") lines.push(`${plan.branch} isn’t on GitHub yet. It’s pushed first.`);
  else if (plan.push === "push") lines.push(`${plural(commits, "commit")} not on GitHub yet ${commits === 1 ? "is" : "are"} pushed first.`);
  else lines.push(`Everything committed is already on GitHub.`);
  if (plan.behind > 0) {
    lines.push(`GitHub has ${plural(plan.behind, "commit")} this laptop doesn’t. The cloud starts from GitHub’s copy, so it has them.`);
  }
  if (plan.uncommitted > 0 && !plan.wip) {
    lines.push(
      `${plural(plan.uncommitted, "file")} with uncommitted changes stay${plan.uncommitted === 1 ? "s" : ""} on this laptop. Commit ${them(plan.uncommitted)} first if the cloud should have ${them(plan.uncommitted)}.`,
    );
  }
  return lines;
}

const NOTE_TURNS = 12;
const TURN_CHARS = 600;
const NOTE_CHARS = 6000;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\n{3,}/g, "\n\n");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The turns worth carrying: what the person and the agent said, newest last,
 *  each trimmed, and the oldest dropped until the whole copy fits. */
export function carriedTurns(turns: readonly ChatTurn[]): string[] {
  const said = turns.filter((t) => (t.role === "user" || t.role === "manager") && t.text.trim());
  const lines = said
    .slice(-NOTE_TURNS)
    .map((t) => `${t.role === "user" ? "Me" : "Agent"}: ${clip(t.text, TURN_CHARS)}`);
  while (lines.length > 1 && lines.join("\n\n").length > NOTE_CHARS) lines.shift();
  return lines;
}

export type OpeningNote = {
  branch: string;
  pr: number | null;
  turns: readonly ChatTurn[];
  /** What the person wants done next, in their words. */
  next: string;
  /** The branch's newest commit holds edits that weren't committed yet. */
  wip?: boolean;
};

/** The cloud chat's first message. Null when there is nothing to say: no
 *  chat carried and nothing asked, so the agent waits for the first prompt. */
export function openingNote({ branch, pr, turns, next, wip = false }: OpeningNote): string | null {
  const carried = carriedTurns(turns);
  const ask = next.trim();
  if (!carried.length && !ask) return null;
  const on = pr ? `${branch} (pull request #${pr})` : branch;
  const parts = [
    `I'm continuing ${on}, started on my laptop. It's checked out here as GitHub has it; push to it and the commits land on the same ${pr ? "pull request" : "branch"}.`,
  ];
  if (wip) {
    parts.push(`The newest commit, "${wipMessage(branch)}", holds changes I hadn't committed yet. They may be half done.`);
  }
  if (carried.length) {
    parts.push(
      `Here is a copy of the last part of the chat we had there, newest last. It's for context; it isn't a list of things still to do.\n\n${carried.join("\n\n")}`,
    );
  }
  parts.push(ask ? `Next: ${ask}` : "Look at where the branch is and carry on with what's left.");
  return parts.join("\n\n");
}

export type ContinueRequest = {
  /** The local workspace's folder. */
  path: string;
  title: string;
  pr: number | null;
  /** owner/name on GitHub. */
  repo: string;
  plan: Extract<HandoffPlan, { ok: true }>;
  target: BoxTarget;
  engine: BoxEngine;
  model: string | null;
  authorName: string | null;
  access: NewCloudWorkspace["access"];
  note: string | null;
};

export type ContinueDeps = {
  /** Commit every uncommitted change in the folder with `message`. */
  saveWip: (path: string, message: string) => Promise<unknown>;
  push: (path: string, setUpstream: boolean) => Promise<unknown>;
  create: (draft: NewCloudWorkspace) => Promise<{ id: string }>;
  hold: (workspaceId: string, prompt: string) => void;
  take: (workspaceId: string) => string | null;
  open: (open: BoxOpen) => Promise<unknown>;
  archive: (workspaceId: string) => Promise<unknown>;
};

export type ContinueOutcome = { workspaceId: string };

export function objectiveFor(title: string, branch: string, pr: number | null): string {
  const name = title.trim() || branch;
  const line = pr && !name.includes(`#${pr}`) ? `${name} (#${pr})` : name;
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

/** Push what has to be pushed, make the workspace on the branch and start its
 *  chat on the machine. Throws with a sentence the dialog can show; a
 *  workspace made for a chat that then didn't start is archived again, so a
 *  failure leaves nothing half-made in the cloud. */
export async function continueInCloud(req: ContinueRequest, deps: ContinueDeps): Promise<ContinueOutcome> {
  const { branch } = req.plan;
  await saveAndPush(req.path, req.plan, deps, "nothing was started in the cloud");
  const row = await deps.create({
    objective: objectiveFor(req.title, branch, req.pr),
    repo: req.repo,
    branch,
    intent: req.pr ? `Continues pull request #${req.pr} on ${branch} from a laptop` : `Continues ${branch} from a laptop`,
    prompt: null,
    model: req.model,
    access: req.access,
  });
  if (req.note) deps.hold(row.id, req.note);
  try {
    await deps.open({
      workspaceId: row.id,
      machineId: req.target.machineId,
      placeId: req.target.placeId,
      project: req.target.project,
      branch,
      engine: req.engine,
      authorName: req.authorName,
      continueBranch: true,
    });
  } catch (e) {
    deps.take(row.id);
    await deps.archive(row.id).catch(() => undefined);
    throw new Error(`Nothing was started in the cloud. ${errorText(e)}`);
  }
  return { workspaceId: row.id };
}

/** Save the uncommitted edits in a commit when they travel, then push what
 *  GitHub doesn't have. `nothing` finishes the sentence a failure says. */
async function saveAndPush(
  path: string,
  plan: Extract<HandoffPlan, { ok: true }>,
  deps: Pick<MoveDeps, "saveWip" | "push">,
  nothing: string,
): Promise<void> {
  if (plan.wip) {
    try {
      await deps.saveWip(path, wipMessage(plan.branch));
    } catch (e) {
      throw new Error(`Couldn’t save your uncommitted changes in a commit, so ${nothing}: ${errorText(e)}`);
    }
  }
  if (plan.push === "none") return;
  try {
    await deps.push(path, plan.push === "publish");
  } catch (e) {
    const saved = plan.wip ? " Your changes are saved in a commit on this laptop." : "";
    throw new Error(`Couldn’t push ${plan.branch}, so ${nothing}: ${errorText(e)}${saved}`);
  }
}

/** The files the work-in-progress commit has to stage: every one with a
 *  change git hasn't staged, untracked ones and deletions included. What is
 *  staged already goes in the commit as it is. */
export function wipPaths(entries: readonly { path: string; worktree: string }[]): string[] {
  const out = new Set<string>();
  for (const e of entries) if (e.worktree && e.path.trim()) out.add(e.path);
  return [...out];
}

/** The pull-request read's reasons that mean the computer can't fetch the
 *  branch from GitHub at all, so moving the workspace there would strand it. */
const UNREACHABLE = new Set(["no_github_app", "project_not_in_github_app"]);

export function cannotReach(reason: string | null | undefined): boolean {
  return !!reason && UNREACHABLE.has(reason);
}

/** The message the work-in-progress commit is made with. */
export function wipMessage(branch: string): string {
  return `Work in progress on ${branch}, moved to the cloud`;
}

export type MoveRequest = {
  /** The local workspace's folder. */
  path: string;
  title: string;
  pr: number | null;
  /** owner/name on GitHub. */
  repo: string;
  plan: Extract<HandoffPlan, { ok: true }>;
  /** The team's computer that takes it. */
  computer: BoxComputer;
  model: string | null;
  access: NewCloudWorkspace["access"];
  note: string | null;
};

export type MoveDeps = {
  /** Commit every uncommitted change in the folder with `message`. */
  saveWip: (path: string, message: string) => Promise<unknown>;
  push: (path: string, setUpstream: boolean) => Promise<unknown>;
  create: (draft: NewCloudWorkspace) => Promise<{ id: string }>;
  /** Why the computer couldn't fetch the branch from GitHub, or null when it
   *  can (or that couldn't be told). */
  reach: (workspaceId: string, branch: string) => Promise<string | null>;
  link: (workspaceId: string, computer: BoxComputer, branch: string) => Promise<unknown>;
  prompt: (workspaceId: string, text: string, model: string | null) => Promise<unknown>;
  archive: (workspaceId: string) => Promise<unknown>;
};

export type MoveOutcome = {
  workspaceId: string;
  /** Said when the workspace is on the computer but something after that
   *  didn't happen. */
  warning: string | null;
};

/** Move the workspace to the team's computer: save and push what has to
 *  travel, make the cloud workspace on the branch, check GitHub lets the
 *  computer fetch it, hand it over and send the opening note. Throws with a
 *  sentence the dialog can show; a cloud workspace made for a move that then
 *  can't happen is archived again, so a failure leaves nothing half-made in
 *  the cloud. Work saved on this laptop stays saved. */
export async function moveToCloud(req: MoveRequest, deps: MoveDeps): Promise<MoveOutcome> {
  const { branch } = req.plan;
  await saveAndPush(req.path, req.plan, deps, "nothing was moved to the cloud");
  const row = await deps.create({
    objective: objectiveFor(req.title, branch, req.pr),
    repo: req.repo,
    branch,
    intent: req.pr ? `Moved pull request #${req.pr} on ${branch} from a laptop` : `Moved ${branch} from a laptop`,
    prompt: null,
    model: req.model,
    access: req.access,
  });
  const undo = async (why: string): Promise<never> => {
    await deps.archive(row.id).catch(() => undefined);
    throw new Error(`Nothing was moved to the cloud. ${why}`);
  };
  const refused = await deps.reach(row.id, branch).catch(() => null);
  if (refused) await undo(refused);
  try {
    await deps.link(row.id, req.computer, branch);
  } catch (e) {
    await undo(errorText(e));
  }
  let warning: string | null = null;
  if (req.note) {
    try {
      await deps.prompt(row.id, req.note, req.model);
    } catch (e) {
      warning = `It’s on ${req.computer.name}, but the opening note didn’t send: ${errorText(e)} Send it from the workspace.`;
    }
  }
  return { workspaceId: row.id, warning };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

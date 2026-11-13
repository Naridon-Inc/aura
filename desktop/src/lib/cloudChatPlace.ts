// Where a cloud workspace's chat runs, decided before anything is made.
//
// A workspace with no computer under it has nobody to answer it: no agent
// reads it, so a prompt sent there waits forever. Creating one, or running an
// old one, therefore starts by asking whether the org has a computer this
// laptop can reach and whether you have an agent signed in, and says plainly
// which one is missing. When the computer is there but the project isn't, the
// project is put on it first, with your own sign-in.
//
// The rules are plain functions; the calls to the computer come in as `deps`,
// so all of it is tested without one.

import { api, type BoxSession, type PlaceProjects, type PlaceRoster, type SessionCapture } from "./api";
import { auraComputerStatus, type AuraComputer } from "./auraComputer";
import { candidatesOf, projectFor, type BoxTarget } from "./cloudBoxChat";
import type { CloudMessageRow } from "./cloudWorkspacesApi";

/** A computer that can run a chat, before we know whether it has the project. */
export type ChatComputer = Omit<BoxTarget, "project">;

/** What stands between this laptop and a chat an agent answers. */
export type ChatReadiness =
  | { kind: "ready"; computers: ChatComputer[] }
  /** The org's Aura computer: it is given each new workspace and answers it
   *  itself, so no laptop has to reach it. */
  | { kind: "answers-itself"; name: string; placeId: string }
  | { kind: "no-agent" }
  | { kind: "no-computer" }
  /** On the org's board, but this laptop has no way in yet. */
  | { kind: "unreachable"; name: string }
  | { kind: "offline"; name: string }
  /** The list of computers couldn't be read. */
  | { kind: "unknown" }
  /** In a browser, which reaches no computer itself: only the org's Aura
   *  computer answers a chat started there, and it can't take one now. */
  | { kind: "in-the-app" };

/** The org's Aura computer as the readiness rules need it. */
export type OrgComputer = Pick<AuraComputer, "name" | "stage" | "place_id">;

/** Still being paid for, failed, or going away: it takes no new work. The
 *  server's rule for giving it a workspace is the same. */
const TAKES_NO_WORK = new Set<AuraComputer["stage"]>(["paying", "failed", "ending", "ended"]);

/** The org's Aura computer, when it would take a new workspace now. Asleep
 *  counts: the first prompt wakes it. */
export function computerThatAnswers(
  c: OrgComputer | null | undefined,
): { kind: "answers-itself"; name: string; placeId: string } | null {
  if (!c?.place_id || TAKES_NO_WORK.has(c.stage)) return null;
  return { kind: "answers-itself", name: c.name.trim() || "your Aura computer", placeId: c.place_id };
}

export function readinessOf(
  roster: PlaceRoster | null,
  hasAgent: boolean,
  orgComputer: OrgComputer | null = null,
  web = false,
): ChatReadiness {
  if (!hasAgent) return { kind: "no-agent" };
  const answers = computerThatAnswers(orgComputer);
  if (web) return answers ?? { kind: "in-the-app" };
  if (!roster) return answers ?? { kind: "unknown" };
  const computers = candidatesOf(roster);
  if (computers.length) return { kind: "ready", computers };
  if (answers) return answers;
  const onBoard = roster.places.filter((p) => !!p.runner_id);
  const down = onBoard.find((p) => p.machine && p.online === false);
  if (down) return { kind: "offline", name: down.name };
  const outOfReach = onBoard.find((p) => !p.machine);
  if (outOfReach) return { kind: "unreachable", name: outOfReach.name };
  return { kind: "no-computer" };
}

/** What a blocked chat says, and the one thing that fixes it. */
export type ReadinessNote = {
  message: string;
  fix: "agent" | "computer" | null;
  /** The fixing button's words. */
  label: string | null;
};

export function readinessNote(r: ChatReadiness): ReadinessNote | null {
  switch (r.kind) {
    case "ready":
    case "answers-itself":
      return null;
    case "no-agent":
      return {
        message: "You haven’t set up an agent yet, so nothing would answer in this workspace. Each person uses their own.",
        fix: "agent",
        label: "Set up an agent",
      };
    case "no-computer":
      return {
        message: "Your organization has no cloud computer yet, so no agent can run this workspace.",
        fix: "computer",
        label: "Connect a cloud computer",
      };
    case "unreachable":
      return {
        message: `This laptop can’t reach ${r.name} yet, so it can’t start the agent there.`,
        fix: "computer",
        label: "Connect a cloud computer",
      };
    case "offline":
      return {
        message: `${r.name} is offline, so no agent can run this workspace until it’s back.`,
        fix: "computer",
        label: "See the cloud computer",
      };
    case "unknown":
      return {
        message: "Aura couldn’t check your cloud computers just now. Try again in a moment.",
        fix: null,
        label: null,
      };
    case "in-the-app":
      return {
        message:
          "A chat started on the web runs on your organization’s Aura computer, and it can’t take one right now. Start this one from the Aura app, or look at the computer.",
        fix: "computer",
        label: "See the cloud computer",
      };
  }
}

/** The address a GitHub repository is copied from. */
export function cloneUrlFor(fullName: string): string {
  return `https://github.com/${fullName.trim()}.git`;
}

/** How a copy of a project onto a computer is going, read off its session. */
export type CloneOutcome = { kind: "done" } | { kind: "failed"; reason: string } | { kind: "copying"; percent: number | null };

const CLONED = "Cloned. This project is ready to work in.";
const CLONE_FAILED = "Clone failed — the message above is git's own.";

/** The session prints one of two closing lines; until then git's own progress
 *  is the only news. A failure carries git's last words, which say why. */
export function cloneOutcome(text: string): CloneOutcome {
  const lines = text.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l.includes(CLONED))) return { kind: "done" };
  const failedAt = lines.findIndex((l) => l.includes(CLONE_FAILED));
  if (failedAt >= 0) {
    const why = lines
      .slice(0, failedAt)
      .reverse()
      .find((l) => /^(fatal|error|remote):/i.test(l));
    return { kind: "failed", reason: why ? why.replace(/^(fatal|error|remote):\s*/i, "") : "git stopped without saying why." };
  }
  let percent: number | null = null;
  for (const l of lines) {
    const m = /(Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/.exec(l);
    if (m) percent = Number(m[2]);
  }
  return { kind: "copying", percent };
}

export type ProjectDeps = {
  projects(machineId: string): Promise<PlaceProjects>;
  clone(machineId: string, url: string, dir: string): Promise<BoxSession>;
  capture(machineId: string, session: string): Promise<SessionCapture>;
  stop(machineId: string, session: string): Promise<void>;
  wait(ms: number): Promise<void>;
  now(): number;
};

/** How long a copy is watched before the dialog stops waiting. It keeps going
 *  on the computer either way. */
export const CLONE_PATIENCE_MS = 10 * 60 * 1000;
const CLONE_POLL_MS = 3000;

/** The folder a GitHub repository is copied into. */
function folderOf(fullName: string): string {
  return fullName.trim().split("/").pop() ?? fullName.trim();
}

/** The project's checkout on `computer`, put there first when it isn't. */
export async function ensureProject(
  computer: ChatComputer,
  fullName: string,
  deps: ProjectDeps,
  onStep: (step: string) => void = () => undefined,
): Promise<BoxTarget> {
  const at = computer.machineName;
  onStep(`Checking ${at} for ${fullName}…`);
  const listed = await deps.projects(computer.machineId);
  const found = projectFor(listed.projects, fullName);
  if (found) return { ...computer, project: found.path };
  const kept = listed.withheld.find((w) => w.name.toLowerCase() === folderOf(fullName).toLowerCase());
  if (kept) throw new Error(`${at} has a folder called ${kept.name}, but Aura won’t use it: ${kept.reason}`);

  onStep(`Putting ${fullName} on ${at}…`);
  const session = await deps.clone(computer.machineId, cloneUrlFor(fullName), folderOf(fullName));
  const until = deps.now() + CLONE_PATIENCE_MS;
  for (;;) {
    await deps.wait(CLONE_POLL_MS);
    const read = await deps.capture(computer.machineId, session.name).catch(() => null);
    const outcome = read ? cloneOutcome(read.text) : { kind: "copying" as const, percent: null };
    if (outcome.kind === "failed") {
      await deps.stop(computer.machineId, session.name).catch(() => undefined);
      throw new Error(`Couldn’t put ${fullName} on ${at}: ${outcome.reason}`);
    }
    if (outcome.kind === "done") break;
    if (deps.now() > until)
      throw new Error(`Putting ${fullName} on ${at} is taking a while. It carries on there; try again in a few minutes.`);
    onStep(`Putting ${fullName} on ${at}…${outcome.percent === null ? "" : ` ${outcome.percent}%`}`);
  }
  // The session only holds a shell now; nobody is watching it.
  await deps.stop(computer.machineId, session.name).catch(() => undefined);
  const after = await deps.projects(computer.machineId);
  const cloned = projectFor(after.projects, fullName);
  if (!cloned) throw new Error(`${fullName} was copied onto ${at}, but ${at} doesn’t offer it as one of your organization’s projects.`);
  return { ...computer, project: cloned.path };
}

/** The computer to run on: the first that already has the project, else the
 *  first that can be given it. */
export async function pickComputer(
  computers: readonly ChatComputer[],
  fullName: string,
  projects: ProjectDeps["projects"],
): Promise<ChatComputer | null> {
  for (const c of computers) {
    const listed = await projects(c.machineId).catch(() => null);
    if (listed && projectFor(listed.projects, fullName)) return c;
  }
  return computers[0] ?? null;
}

/** Your messages nobody has answered: everything you sent after the last
 *  answer, except the ones addressed to people. A message with no author
 *  recorded is the workspace owner's. Sent to an agent as one message. */
export function unansweredMine(
  rows: readonly (CloudMessageRow & { author_id?: string | null })[],
  me: string | null,
  ownerId: string | null,
  addressed: (body: string) => boolean,
): { ids: string[]; text: string } | null {
  if (!me) return null;
  let last = -1;
  rows.forEach((r, i) => {
    if (r.role === "assistant") last = i;
  });
  const mine = rows
    .slice(last + 1)
    .filter((r) => r.role === "user" && (r.author_id?.trim() || ownerId) === me)
    .filter((r) => r.body.trim() && !addressed(r.body));
  if (!mine.length) return null;
  return { ids: mine.map((r) => r.id), text: mine.map((r) => r.body.trim()).join("\n\n") };
}

// ── The computer, for real ─────────────────────────────────────────────────

/** Where things stand right now, asked of the org's board. */
export async function chatReadiness(hasAgent: boolean, web = false): Promise<ChatReadiness> {
  const [roster, status] = await Promise.all([
    web ? null : api.placesList().catch(() => null),
    auraComputerStatus().catch(() => null),
  ]);
  return readinessOf(roster, hasAgent, status?.computer ?? null, web);
}

/** The calls `ensureProject` makes, against the real computer. The copy is
 *  made with your own sign-in. */
export const liveProjectDeps: ProjectDeps = {
  projects: (machineId) => api.boxProjects(machineId),
  clone: (machineId, url, dir) => api.boxClone(machineId, url, dir),
  capture: (machineId, session) => api.placeSessionCapture(machineId, session, 200),
  stop: (machineId, session) => api.boxStop(machineId, session),
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => Date.now(),
};

/** The computer and project a chat about `fullName` runs in: the computer
 *  that has it, else the first one, given it. */
export async function placeChat(
  computers: readonly ChatComputer[],
  fullName: string,
  onStep?: (step: string) => void,
): Promise<BoxTarget> {
  const computer = await pickComputer(computers, fullName, liveProjectDeps.projects);
  if (!computer) throw new Error("Your organization has no cloud computer this laptop can reach.");
  return ensureProject(computer, fullName, liveProjectDeps, onStep);
}

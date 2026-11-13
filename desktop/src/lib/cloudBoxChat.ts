// A cloud workspace whose chat runs on one of the org's machines.
//
// The agent (Claude Code or Codex, over the Agent Client Protocol) runs on the
// machine in a worktree of the workspace's project, under tmux, so it carries
// on when this laptop closes. This laptop is the driver: it reads what the
// agent says, shows it in the same chat view local work uses, and copies each
// finished turn onto the workspace's log so teammates see it too.
//
// Everything here that can be decided without the machine is a plain function,
// so it is tested without one. The calls at the bottom are the desktop's
// commands of the same names.

import { invoke } from "@tauri-apps/api/core";

import { api, type BoxProject, type BrainChoice, type PlaceRoster } from "./api";
import { HARNESSES } from "./cloudAgentCredentials";
import { isBoxDriven } from "./cloudBoxDrive";
import type { CloudMessageRow, CloudWorkspacePlace, CloudWorkspaceRow } from "./cloudWorkspacesApi";
import {
  clearManagerTurnInFlight,
  markManagerTurnInFlight,
  setManagerTurnStartedAt,
} from "./managerStore";
import { workBranchName } from "./workNames";

/** The engines a machine chat can run. */
export type BoxEngine = "claude" | "codex";

/** What connecting to a machine chat hands back. */
export type BoxAttached = {
  /** The brain id the chat's turns go to (`place:ws-…`). */
  provider: string;
  /** The machine-book entry that reaches the machine. */
  machineId: string;
  /** The checkout on this laptop the conversation is filed under, when the
   *  machine book knows which one the machine mirrors. */
  repoRoot: string | null;
};

/** Starting a workspace's chat on a machine. */
export type BoxOpen = {
  workspaceId: string;
  machineId: string;
  /** The org's row for the machine; the agent's sign-in is bound to it. */
  placeId: string;
  /** The project's checkout on the machine. */
  project: string;
  branch: string;
  engine: BoxEngine;
  authorName?: string | null;
  /** The branch is already on GitHub (a pull request carried on from a
   *  laptop): the machine checks GitHub's copy out instead of starting one. */
  continueBranch?: boolean;
  /** The teammates' GitHub logins: a message opening with one of them goes
   *  on the shared log for them and not to the agent. */
  people?: string[];
  /** The first message, when the workspace's log already holds it: messages
   *  sent while no computer ran it. The agent gets them; the log doesn't get
   *  them twice. */
  onLog?: string | null;
};

/** A machine, and the project on it, that can run a workspace's chat. */
export type BoxTarget = {
  machineId: string;
  placeId: string;
  machineName: string;
  project: string;
};

/** Whether this member's laptop is the one that drives the workspace's chat.
 *  Only the member who linked the workspace to its machine connects to it;
 *  everyone else reads the turns it copies onto the log. A computer that
 *  answers by itself has no laptop driving it, whoever linked it. */
export function isDriver(
  row: Pick<CloudWorkspaceRow, "place" | "place_linked_by">,
  me: string | null,
): boolean {
  return !!row.place && !isBoxDriven(row) && !!me && row.place_linked_by === me;
}

/** A connect failure that is the laptop not reaching the machine at all:
 *  the network, not the chat. */
function unreachable(message: string): boolean {
  return /ssh: |connect to host|timed out|connection refused|no route to host|could not resolve|network is unreachable|host is down|connection reset|connection closed/i.test(
    message,
  );
}

/** What the member who drives a machine chat is told while this laptop can't
 *  open it: they read it the way their teammates do in the meantime. */
export function cutLine(machine: string, message: string): string {
  const why = unreachable(message)
    ? `This laptop can’t reach ${machine} right now`
    : `The chat on ${machine} didn’t open here (${message.trim() || "no reason given"})`;
  return `${why}, so you’re reading it the way your teammates do.`;
}

/** `owner/name`, lowercased, for a GitHub remote in any of its spellings. */
export function githubSlugOf(remote: string | null | undefined): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec((remote ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The checkout of `fullName` on a machine. The shortest path wins: worktrees
 *  made for earlier chats sit beside the project as `<project>-<branch>`, and
 *  a new chat branches from the project, not from somebody's worktree. */
export function projectFor(projects: BoxProject[], fullName: string): BoxProject | null {
  const wanted = fullName.trim().toLowerCase();
  if (!wanted) return null;
  const hits = projects.filter((p) => githubSlugOf(p.remote) === wanted);
  hits.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  return hits[0] ?? null;
}

/** The engine the chosen model runs on, or null when no machine chat can run
 *  it. The model picker names each model's agent by its label. */
export function engineFor(
  models: ReadonlyArray<{ id: string; provider?: string }>,
  modelId: string,
): BoxEngine | null {
  const provider = models.find((m) => m.id === modelId)?.provider ?? models[0]?.provider;
  const harness = HARNESSES.find((h) => h.label === provider)?.id ?? (provider ? null : "claude");
  return harness === "claude" || harness === "codex" ? harness : null;
}

/** The branch a workspace's worktree gets on the machine. */
export function branchFor(objective: string, workspaceId: string): string {
  const name = workBranchName(objective, new Set());
  return `${name}-${workspaceId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase()}`;
}

/** The machines that can run a chat: on the org's board, reachable from this
 *  laptop, and not known to be down. One row per machine, though the book may
 *  hold it more than once. */
export function candidatesOf(roster: PlaceRoster): Omit<BoxTarget, "project">[] {
  const seen = new Set<string>();
  const out: Omit<BoxTarget, "project">[] = [];
  for (const p of roster.places) {
    if (!p.machine || !p.runner_id || p.online === false || seen.has(p.runner_id)) continue;
    seen.add(p.runner_id);
    out.push({ machineId: p.machine.id, placeId: p.runner_id, machineName: p.name });
  }
  return out;
}

/** The first machine that has `fullName` checked out. */
export async function findMachineFor(fullName: string): Promise<BoxTarget | null> {
  if (!fullName.trim()) return null;
  const roster = await api.placesList().catch(() => null);
  if (!roster) return null;
  for (const c of candidatesOf(roster)) {
    const offered = await api.boxProjects(c.machineId).catch(() => null);
    const project = offered ? projectFor(offered.projects, fullName) : null;
    if (project) return { ...c, project: project.path };
  }
  return null;
}

/** The brain the chat view shows and sends to: the agent on the machine. The
 *  chat header names it, so it says where the work happens. */
export function brainFor(provider: string, engine: string, machine: string): BrainChoice {
  const agent = engine.toLowerCase() === "codex" ? "Codex" : "Claude";
  return {
    id: provider,
    label: `${agent} on ${machine}`,
    kind: "acp",
    active: false,
    requires_api_key: false,
    has_api_key: true,
  };
}

/** Send the prompt typed at create as the chat's first turn. The chat view
 *  picks up a turn already in flight, so this works before it has mounted. */
export async function sendFirstTurn(sessionId: string, text: string, provider: string): Promise<void> {
  markManagerTurnInFlight(sessionId);
  setManagerTurnStartedAt(sessionId, Date.now());
  try {
    await api.brainChatTurn(sessionId, text, { messages: [] }, provider, null);
  } catch (e) {
    clearManagerTurnInFlight(sessionId);
    throw e;
  }
}

// ── Remembered on this laptop ──────────────────────────────────────────────

export type BoxStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const THREAD_PREFIX = "aura.cloudBoxChat.thread.";
/** The local chat session a workspace's machine chat is shown in. */
export const threadKey = (workspaceId: string) => `${THREAD_PREFIX}${workspaceId}`;

/** A store that can say what it holds, as `localStorage` can. */
export type ListedStore = Pick<BoxStore, "getItem"> & { readonly length: number; key(index: number): string | null };

/** Every local session this laptop shows a workspace's machine chat in. */
export function boxChatSessions(store: ListedStore): Set<string> {
  const ids = new Set<string>();
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    const id = key?.startsWith(THREAD_PREFIX) ? store.getItem(key)?.trim() : null;
    if (id) ids.add(id);
  }
  return ids;
}

/** The workspace list without the copies an earlier version made of this
 *  laptop's machine chats: it also listed each chat's local session in the
 *  cloud, under the session's own id, beside the workspace that is the
 *  chat's real row. A row with a machine of its own is a workspace and is
 *  always kept. */
export function withoutMirrors(rows: CloudWorkspaceRow[], sessions: Set<string>): CloudWorkspaceRow[] {
  if (sessions.size === 0) return rows;
  return rows.filter((r) => !!r.place || !sessions.has(r.id));
}
/** The prompt typed at create, sent as the chat's first turn once it opens. */
export const pendingKey = (workspaceId: string) => `aura.cloudBoxChat.pending.${workspaceId}`;

/** The log's rows the first prompt was made of, when it was made of rows. */
const onLogKey = (workspaceId: string) => `aura.cloudBoxChat.onLog.${workspaceId}`;

/** Hold the prompt the chat starts with. `onLog` names the log's rows it was
 *  made from, when the log already has them. */
export function holdFirstPrompt(
  store: BoxStore,
  workspaceId: string,
  prompt: string,
  onLog: readonly string[] = [],
): void {
  const text = prompt.trim();
  if (!text) return;
  store.setItem(pendingKey(workspaceId), text);
  if (onLog.length) store.setItem(onLogKey(workspaceId), onLog.join("\n"));
  else store.removeItem(onLogKey(workspaceId));
}

/** The log's rows the held prompt already stands for. This laptop's copy of
 *  the chat leaves them out, since the prompt itself is its first turn. */
export function heldOnLog(store: Pick<BoxStore, "getItem">, workspaceId: string): Set<string> {
  const ids = store.getItem(onLogKey(workspaceId)) ?? "";
  return new Set(ids.split("\n").filter(Boolean));
}

/** The first prompt, once: taking it removes it, so a reload never sends it
 *  twice. */
export function takeFirstPrompt(store: BoxStore, workspaceId: string): string | null {
  const text = store.getItem(pendingKey(workspaceId));
  if (text === null) return null;
  store.removeItem(pendingKey(workspaceId));
  store.removeItem(onLogKey(workspaceId));
  return text.trim() || null;
}

export type ThreadDeps = {
  store: BoxStore;
  alive(sessionId: string): Promise<boolean>;
  start(repoRoot: string, objective: string, machineId: string, brain: string): Promise<string>;
};

/** The local session this workspace's chat is shown in: the remembered one
 *  while it still loads, else a new one, remembered. A new one is born with
 *  the machine's agent as its brain: the workspace is already its row in the
 *  cloud, so the desktop doesn't list it there as a session of its own. */
export async function sessionFor(
  workspaceId: string,
  at: { repoRoot: string; machineId: string; title: string; brain: string },
  deps: ThreadDeps,
): Promise<{ sessionId: string; resumed: boolean }> {
  const key = threadKey(workspaceId);
  const known = deps.store.getItem(key);
  if (known) {
    if (await deps.alive(known)) return { sessionId: known, resumed: true };
    deps.store.removeItem(key);
  }
  const sessionId = await deps.start(at.repoRoot, at.title, at.machineId, at.brain);
  deps.store.setItem(key, sessionId);
  return { sessionId, resumed: false };
}

// ── What this laptop never saw ─────────────────────────────────────────────

/** The end of the agent's own log on the machine: the answers it finished,
 *  oldest first, and whether it is working on another one now. */
export type BoxAnswers = { answers: string[]; busy: boolean };

/** A question the workspace's log left open, and the answer the agent finished
 *  for it while no laptop was there to keep it. */
export type Recovered = {
  question: CloudMessageRow;
  answer: string;
  /** The id the answer's copy got on the workspace's log, once kept. */
  id?: string | null;
};

/** One turn filed onto this laptop's copy of the chat. `at` is in seconds. */
export type SeedTurn = {
  role: "user" | "assistant";
  text: string;
  at: number;
  /** The id of the turn's copy on the workspace's log, so comments find it
   *  on this laptop's copy. */
  cloud_id?: string | null;
  /** The key a recovered answer was kept under, until its id is known. */
  cloud_key?: string | null;
};

/** The answers that fill the questions left open at the end of the log. A
 *  question is open when no answer follows it; an answer from the agent's log
 *  that is already on the workspace's log is not new. The newest answers go
 *  with the newest questions, and while the agent is still working the newest
 *  question is the one it is on. */
export function recovered(rows: CloudMessageRow[], log: BoxAnswers): Recovered[] {
  let lastAnswer = -1;
  rows.forEach((r, i) => {
    if (r.role === "assistant") lastAnswer = i;
  });
  const open = rows.slice(lastAnswer + 1).filter((r) => r.role === "user");
  if (log.busy) open.pop();
  const kept = new Set(rows.filter((r) => r.role === "assistant").map((r) => r.body.trim()));
  const fresh = log.answers.map((a) => a.trim()).filter((a) => a && !kept.has(a));
  const n = Math.min(open.length, fresh.length);
  const questions = open.slice(open.length - n);
  const answers = fresh.slice(fresh.length - n);
  return questions.map((question, i) => ({ question, answer: answers[i] }));
}

/** The workspace's log as the turns of a chat, each recovered answer right
 *  after its question. */
export function historyFor(rows: CloudMessageRow[], fills: Recovered[]): SeedTurn[] {
  const out: SeedTurn[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const at = Math.max(0, Math.floor(Date.parse(row.created_at) / 1000) || 0);
    out.push({ role: row.role, text: row.body, at, cloud_id: row.id });
    for (const f of fills) {
      if (f.question.id === row.id)
        out.push({ role: "assistant", text: f.answer, at, cloud_id: f.id ?? null, cloud_key: recoveredKey(f.question) });
    }
  }
  return out;
}

/** The key a recovered answer is kept under: one per question, so a second
 *  laptop, or a second try, keeps it once. */
export const recoveredKey = (question: CloudMessageRow) => `recovered-${question.id}`;

export type CatchUpDeps = {
  messages(workspaceId: string): Promise<CloudMessageRow[]>;
  answers(workspaceId: string, place: CloudWorkspacePlace): Promise<BoxAnswers>;
  keep(workspaceId: string, text: string, messageId: string): Promise<unknown>;
  backfill(sessionId: string, turns: SeedTurn[], after: string | null, brain: string): Promise<boolean>;
};

/** Bring this laptop's copy of a machine chat up to date before it is shown.
 *  A new copy (`resumed` false) is filled with the whole workspace's log; an
 *  answer that finished while no laptop was attached is kept on the
 *  workspace's log, and filed after its question here when this copy ends on
 *  that question. Each step is best-effort: a chat that can't catch up still
 *  opens. */
export async function catchUp(
  at: { workspaceId: string; place: CloudWorkspacePlace; sessionId: string; resumed: boolean; provider: string },
  deps: CatchUpDeps,
): Promise<void> {
  const rows = await deps.messages(at.workspaceId).catch(() => [] as CloudMessageRow[]);
  if (rows.length === 0) return;
  const log = await deps
    .answers(at.workspaceId, at.place)
    .catch((): BoxAnswers => ({ answers: [], busy: true }));
  const fills = recovered(rows, log);
  for (const f of fills) {
    const kept = await deps.keep(at.workspaceId, f.answer, recoveredKey(f.question)).catch(() => undefined);
    const id = (kept as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id) f.id = id;
  }
  if (!at.resumed) {
    await deps.backfill(at.sessionId, historyFor(rows, fills), null, at.provider).catch(() => false);
    return;
  }
  for (const f of fills) {
    const answer: SeedTurn = {
      role: "assistant",
      text: f.answer,
      at: 0,
      cloud_id: f.id ?? null,
      cloud_key: recoveredKey(f.question),
    };
    await deps.backfill(at.sessionId, [answer], f.question.body, at.provider).catch(() => false);
  }
}

// ── The desktop's commands ─────────────────────────────────────────────────

/** The row's `place`, in the shape the desktop's commands read. */
export function linkOf(place: CloudWorkspacePlace) {
  return {
    machine: place.machine,
    remoteRoot: place.remote_root,
    branch: place.branch ?? null,
    engine: place.engine,
    agentSessionId: place.agent_session_id ?? null,
    placeId: place.place_id ?? null,
    // A re-link keeps the mode: changing it retires everyone's waiting prompts.
    driver: place.driver ?? null,
  };
}

export const boxChat = {
  /** Make the worktree, start the agent under tmux and connect to it. */
  open: (open: BoxOpen) => invoke<BoxAttached>("cloud_box_chat_open", { open }),
  /** Connect to a chat already running on its machine. */
  attach: (
    workspaceId: string,
    link: CloudWorkspacePlace,
    authorName?: string | null,
    people: readonly string[] = [],
  ) =>
    invoke<BoxAttached>("cloud_box_chat_attach", {
      chat: { workspaceId, link: linkOf(link), authorName: authorName ?? null, people },
    }),
  /** Who the connected chat can address now: a message opening with one of
   *  these logins goes on the log for them and not to the agent. */
  people: (workspaceId: string, authorName: string | null, people: readonly string[]) =>
    invoke<void>("cloud_box_chat_people", { chat: { workspaceId, authorName, people } }),
  /** Let go of the chat here; it keeps running on the machine. */
  release: (workspaceId: string) => invoke<boolean>("cloud_box_chat_release", { workspaceId }),
  /** The end of the agent's log on the machine, read once. */
  answers: (workspaceId: string, link: CloudWorkspacePlace) =>
    invoke<BoxAnswers>("cloud_box_chat_answers", {
      chat: { workspaceId, link: linkOf(link), authorName: null },
    }),
  /** Keep an answer on the workspace's log. */
  keep: (workspaceId: string, text: string, messageId: string) =>
    invoke<unknown>("cloud_box_turn", {
      id: workspaceId,
      role: "assistant",
      text,
      messageId,
      authorName: null,
    }),
  /** File turns onto this laptop's copy of the chat, where it left off. */
  backfill: (sessionId: string, turns: SeedTurn[], after: string | null, brain: string) =>
    invoke<boolean>("cloud_box_chat_backfill", { sessionId, turns, after, brain }),
  /** Stop the chat on its machine. */
  end: (workspaceId: string, link: CloudWorkspacePlace) =>
    invoke<void>("cloud_box_chat_end", {
      chat: { workspaceId, link: linkOf(link), authorName: null },
    }),
};

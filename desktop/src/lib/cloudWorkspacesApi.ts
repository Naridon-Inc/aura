// The cloud's own workspaces and routines — the `/api/v2/public/...` routes,
// proxied by the desktop so the renderer never holds the token.
//
// Kept apart from `api.ts` because every call here can fail for a reason the
// screen has to say out loud (signed out, plan, an older server, an app built
// before these commands existed), and `cloudProblem` is where that is read.

import { invoke } from "@tauri-apps/api/core";

import { myGithubProblem, type MyGithubReason } from "./cloudMyGithub";

/** A cloud workspace as the server answers for it. */
export type CloudWorkspaceRow = {
  id: string;
  objective: string | null;
  /** `running` | `sleeping` | `archived` | `ended`. */
  status: string;
  intent: string | null;
  /** The user id the workspace was opened by. */
  intent_by: string | null;
  agent: string | null;
  branch: string | null;
  model: string | null;
  repo_id: string;
  /** `public-api`, `routine`, … — where it came from. */
  source: string | null;
  /** `cloud` when the cloud opened it (the API, a routine, a chat bot);
   *  `device` when it is a laptop reporting its own agent session. Missing
   *  from servers that predate it — read it through `isCloudWork`. */
  origin?: "cloud" | "device" | null;
  section_id: string | null;
  section: string | null;
  created_at: string;
  last_activity_at: string | null;
  ended_at: string | null;
  /** The member who created the row. Rows made without an `intent` carry
   *  this and no `intent_by`; read the owner with {@link ownerOf}. */
  created_by?: string | null;
  /** Set when the conversation runs on one of the org's machines. */
  place?: CloudWorkspacePlace | null;
  /** The member whose laptop drives that conversation: the one who linked it
   *  to the machine. Null when the workspace has no machine. */
  place_linked_by?: string | null;
  /** Set when the workspace moved to a member's own computer. Its machine no
   *  longer answers it; the work goes on there. */
  moved?: CloudWorkspaceMoved | null;
};

/** Where a workspace's work went when it left the cloud. */
export type CloudWorkspaceMoved = {
  to: "local" | string;
  /** How that computer is shown to the team. */
  name: string | null;
  branch: string | null;
  /** The member who moved it. */
  by: string | null;
  at: string | null;
};

/** Where a workspace's conversation runs, when it is one of the org's
 *  machines. Names the machine; never an address. */
export type CloudWorkspacePlace = {
  kind?: string;
  machine: string;
  remote_root: string;
  branch: string | null;
  engine: string;
  agent_session_id: string | null;
  /** The org place the workspace is linked to, which the sign-in lease names. */
  place_id?: string | null;
  /** `"box"`: the computer answers every member's prompt by itself, on the
   *  sign-in of whoever sent it. Absent: a laptop drives the chat. */
  driver?: string | null;
  /** When the computer was given the workspace; prompts before it are history. */
  linked_at?: string | null;
};

/** The member a workspace belongs to: who created it, else who recorded its
 *  intent (rows from before every create stamped `created_by`). The server's
 *  access check and list query read the same order, so "My workspaces" never
 *  holds a row whose sharing this member cannot manage. */
export function ownerOf(w: Pick<CloudWorkspaceRow, "intent_by" | "created_by">): string | null {
  return w.created_by || w.intent_by || null;
}

export type CloudRoutineTriggerRow = {
  id: string;
  /** `schedule` | `webhook`. */
  kind: string;
  config: unknown;
};

export type CloudRoutineRow = {
  id: string;
  name: string;
  repo: string | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  prompt: string;
  enabled: boolean;
  webhook_configured: boolean;
  triggers: CloudRoutineTriggerRow[];
  run_count: number;
  last_fired_at: string | null;
  created_at: string;
};

export type CreatedRoutine = {
  routine: CloudRoutineRow;
  /** Shown once, at creation — the server keeps only its hash. */
  webhook_url: string | null;
  webhook_secret: string | null;
};

export type FiredRoutine = {
  fired: boolean;
  routine: string;
  workspace_id: string | null;
  run_id: string | null;
  reason: string | null;
};

export type PublicModel = {
  id: string;
  label: string;
  /** The catalog family: `anthropic`, `openai`. */
  provider: string;
  /** The agent that runs it in a workspace: `claude`, `codex`. */
  agent: string;
  /** The caller is signed in to that agent here, so a turn on it can start. */
  available: boolean;
  is_new: boolean;
};

/** One turn in a cloud workspace's log, oldest first. */
export type CloudMessageRow = {
  id: string;
  /** `user` for a prompt, `assistant` for the agent's reply. */
  role: string;
  body: string;
  source: string | null;
  /** The member who sent it, when the message records one. */
  author_id?: string | null;
  author_name?: string | null;
  created_at: string;
  /** On a computer's answer: the id of the prompt it answers. */
  answers?: string | null;
  /** On a computer's answer: the prompt was not run, and the body says why. */
  failed?: boolean | null;
  /** On a prompt: sending it woke the team's sleeping Aura computer, so its
   *  answer waits for the computer to boot. */
  waking?: boolean | null;
};

/** One file a workspace's commits touched, as the newest of them left it. */
export type CloudChangedFile = {
  path: string;
  previous_path: string | null;
  /** GitHub's word: `added`, `modified`, `removed`, `renamed`, … */
  status: string | null;
  additions: number | null;
  deletions: number | null;
  commit: string;
  message: string | null;
};

/** What a workspace's own commits changed. An empty list carries why. */
export type CloudWorkspaceChanges = {
  source: "github" | null;
  /** `not_committed`, `no_github`, `not_on_github` or `unavailable`. */
  reason: string | null;
  files: CloudChangedFile[];
  commits_read: number;
  /** More commits than were read: the list is short, not wrong. */
  truncated: boolean;
};

export type NewCloudWorkspace = {
  objective?: string | null;
  repo?: string | null;
  branch?: string | null;
  prompt?: string | null;
  model?: string | null;
  intent?: string | null;
  /** Who may open it. Left out, everyone in the project. */
  access?: "organization" | "restricted" | null;
};

/** One of a project's open pull requests, as the cloud lists them. */
export type CloudOpenPull = {
  number: number;
  title: string;
  url: string;
  /** The pull request's branch. */
  head: string;
  base: string;
  author: string | null;
  draft: boolean;
  updated_at: string | null;
  /** `owner/name` the branch lives in; null when that copy was deleted. */
  head_repo: string | null;
  /** The branch isn't in the project itself, so the org can't push to it. */
  from_fork: boolean;
};

export type NewCloudRoutine = {
  name: string;
  prompt: string;
  repo?: string | null;
  model?: string | null;
  effort?: string | null;
  enabled?: boolean;
  triggers: { kind: "schedule" | "webhook"; config: unknown }[];
};

export const cloudApi = {
  workspaces: (status?: string) =>
    invoke<CloudWorkspaceRow[]>("cloud_workspaces_list", { status: status ?? null }),
  createWorkspace: (draft: NewCloudWorkspace) =>
    invoke<CloudWorkspaceRow>("cloud_workspace_create", { draft }),
  openPulls: (repo: string) =>
    invoke<{ repo: string; pulls: CloudOpenPull[] }>("cloud_repo_open_pulls", { repo }),
  setWorkspaceState: (id: string, state: "sleep" | "archive") =>
    invoke<CloudWorkspaceRow>("cloud_workspace_set_state", { id, state }),
  renameWorkspace: (id: string, name: string) =>
    invoke<unknown>("cloud_workspace_rename", { id, name }),
  messages: (id: string) => invoke<CloudMessageRow[]>("cloud_workspace_messages", { id }),
  changes: (id: string) => invoke<CloudWorkspaceChanges>("cloud_workspace_changes", { id }),
  prompt: (id: string, text: string, model?: string | null) =>
    invoke<unknown>("cloud_workspace_prompt", { id, text, model: model ?? null }),
  /** Say the workspace moved to this computer: its machine stops answering. */
  markMoved: (id: string, moved: { name: string | null; branch: string | null }) =>
    invoke<CloudWorkspaceRow>("cloud_workspace_moved", { id, moved }),
  models: () => invoke<{ models: PublicModel[] }>("cloud_public_models"),
  routines: () => invoke<CloudRoutineRow[]>("cloud_routines_list"),
  createRoutine: (routine: NewCloudRoutine) =>
    invoke<CreatedRoutine>("cloud_routine_create", { routine }),
  deleteRoutine: (id: string) => invoke<unknown>("cloud_routine_delete", { id }),
  runRoutine: (id: string) => invoke<FiredRoutine>("cloud_routine_run", { id }),
};

/** Why a cloud call didn't answer, in the terms the screen needs. */
export type CloudProblem =
  | { kind: "signed_out"; message: string }
  | { kind: "upgrade"; message: string; feature?: string; planNeeded?: string }
  | { kind: "forbidden"; message: string }
  /** The member's own GitHub is the reason: not connected, or it can't open
   *  or push to the repository. Fixed in Settings → Git → Your GitHub. */
  | { kind: "github"; message: string; reason: MyGithubReason }
  | { kind: "unavailable"; message: string }
  | { kind: "needs_update"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "other"; message: string };

function textOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * The words a request that never got an answer leaves behind: no network, a
 * name that didn't resolve, a refused or timed-out connection. The request
 * library writes them under the URL it tried (`GET https://…: error sending
 * request for url (…)`), which is no sentence for a person.
 */
const UNREACHED = [
  "error sending request",
  "dns error",
  "failed to lookup address",
  "connection refused",
  "connection reset",
  "connection closed before message completed",
  "network is unreachable",
  "operation timed out",
  "timed out",
  "tcp connect error",
  "error trying to connect",
  "client error (connect)",
];

/** What a cloud read says while the cloud can't be reached. The place reads
 *  again on its own, so the sentence promises that and nothing more. */
export const CLOUD_UNREACHED = "Can’t reach Aura’s cloud right now. Trying again…";

/** True when a failed call never reached the cloud at all. */
export function unreached(raw: string): boolean {
  const lower = raw.toLowerCase();
  // A server that answered said so with a status; only an unanswered call
  // is the network's.
  if (/\bhttp [1-5]\d\d\b/.test(lower)) return false;
  return UNREACHED.some((w) => lower.includes(w));
}

const PLAN_WORD: Record<string, string> = { pro: "Pro", team: "Team", enterprise: "Enterprise" };

/** The JSON body a failed call carried, when it carried one. */
function bodyOf(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The server's plan refusal, said with the plan it needs.
 *
 * Every paid route refuses in one shape — `{error:"upgrade_required",
 * feature, plan_needed, message}` — so the plan named here is the server's,
 * not a guess from which page asked. An older server sends only `error`, and
 * gets the general sentence.
 */
function upgradeProblem(raw: string): CloudProblem {
  const body = bodyOf(raw);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const feature = str(body?.feature);
  const planNeeded = str(body?.plan_needed)?.toLowerCase();
  const plan = planNeeded ? PLAN_WORD[planNeeded] : undefined;
  const message =
    str(body?.message) && plan
      ? (str(body?.message) as string)
      : plan
        ? `This needs the ${plan} plan.`
        : "Your organization’s plan doesn’t include this yet.";
  return { kind: "upgrade", message, feature, planNeeded };
}

/**
 * Read a failed call into something a person can act on.
 *
 * The ones that matter are told apart because each has a different next
 * step: sign in, upgrade, update the app, wait for the server, or wait for
 * the connection. Anything else is passed through as the server said it.
 */
export function cloudProblem(e: unknown): CloudProblem {
  const raw = textOf(e);
  const lower = raw.toLowerCase();
  if (unreached(raw)) return { kind: "offline", message: CLOUD_UNREACHED };
  if (lower.includes("no cloud_api_token") || lower.includes("http 401"))
    return { kind: "signed_out", message: "Sign in to Aura’s cloud to see your cloud workspaces." };
  if (lower.includes("upgrade_required")) return upgradeProblem(raw);
  const github = myGithubProblem(raw);
  if (github) return { kind: "github", ...github };
  if (lower.includes("http 403"))
    return { kind: "forbidden", message: "Your account can’t do this in this organization." };
  // A Tauri build without these commands answers "command … not found".
  if (/command [\w_]+ not found/.test(lower) || lower.includes("unknown command"))
    return {
      kind: "needs_update",
      message: "This copy of Aura was built before cloud workspaces. Update Aura to use them.",
    };
  if (lower.includes("http 404") || lower.includes("http 503"))
    return { kind: "unavailable", message: "The cloud server doesn’t offer this yet." };
  return { kind: "other", message: raw };
}

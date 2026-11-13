// A cloud workspace's live events, as a window sees them.
//
// The desktop holds one socket per open workspace (`cloud_workspace_watch`)
// and hands its frames to every window as `cloud-workspace-live` events. A
// viewer folds them into what the agent is doing right now: the reply as it
// is written, each tool as it runs, and a question waiting on the member who
// drives the chat. Finished messages come on the same socket; while it is
// down, the caller reads the message list instead.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CloudMessageRow } from "./cloudWorkspacesApi";

export const LIVE_EVENT = "cloud-workspace-live";

/** The most event keys kept to drop a frame seen twice. */
const SEEN_CAP = 2_000;

export type LiveEvent = {
  seq: number;
  acp_session_id: string;
  kind: string;
  payload: unknown;
};

export type LiveFrame =
  | { kind: "ready"; session?: string; viewers?: number }
  | { kind: "message"; message: CloudMessageRow }
  | { kind: "presence"; viewers?: number }
  | { kind: "acp_event"; event: LiveEvent }
  /** A reaction set or a comment changed; `cloudFeedback.withFrame` reads the
   *  comments (the chat no longer shows reactions). */
  | { kind: "feedback"; op: "reaction" | "comment"; message_id?: string; reactions?: unknown[]; comment?: unknown }
  | { kind: "down"; reason?: string };

export type ToolState = "running" | "done" | "error";

export type LiveStep =
  { kind: "text"; text: string } | { kind: "tool"; id: string; title: string; status: ToolState };

export type LiveState = {
  /** The socket is open and frames are arriving. */
  up: boolean;
  /** Why it isn't, when it dropped. */
  reason: string | null;
  viewers: number;
  /** A turn is under way. */
  working: boolean;
  /** What the agent has said and run this turn, in order. */
  steps: LiveStep[];
  /** What the agent is waiting to be allowed, when it asked. */
  asking: string | null;
  seen: string[];
};

export const EMPTY_LIVE: LiveState = {
  up: false,
  reason: null,
  viewers: 0,
  working: false,
  steps: [],
  asking: null,
  seen: [],
};

const QUIET: Pick<LiveState, "working" | "steps" | "asking"> = {
  working: false,
  steps: [],
  asking: null,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toolStatus(s: unknown): ToolState {
  if (s === "completed") return "done";
  if (s === "failed") return "error";
  return "running";
}

function withText(steps: LiveStep[], text: string): LiveStep[] {
  if (!text) return steps;
  const last = steps[steps.length - 1];
  if (last?.kind === "text")
    return [...steps.slice(0, -1), { kind: "text", text: last.text + text }];
  return [...steps, { kind: "text", text }];
}

function withTool(
  steps: LiveStep[],
  id: string,
  title: string | null,
  status: unknown,
): LiveStep[] {
  const at = steps.findIndex((s) => s.kind === "tool" && s.id === id);
  if (at < 0) {
    return [...steps, { kind: "tool", id, title: title || "Tool", status: toolStatus(status) }];
  }
  const was = steps[at] as LiveStep & { kind: "tool" };
  const next: LiveStep = {
    kind: "tool",
    id,
    title: title || was.title,
    status: status === undefined || status === null ? was.status : toolStatus(status),
  };
  return [...steps.slice(0, at), next, ...steps.slice(at + 1)];
}

/** One protocol frame folded into the turn under way. */
function heard(state: LiveState, e: LiveEvent): LiveState {
  const p = obj(e.payload);
  const on = { ...state, working: true };
  switch (e.kind) {
    case "session/update": {
      const u = obj(p.update);
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          return {
            ...on,
            steps: withText(on.steps, str(obj(u.content).text) ?? ""),
          };
        case "tool_call":
        case "tool_call_update": {
          const id = str(u.toolCallId);
          if (!id) return on;
          return {
            ...on,
            steps: withTool(on.steps, id, str(u.title), u.status),
          };
        }
        default:
          return on;
      }
    }
    case "session/request_permission": {
      const call = obj(p.toolCall);
      return { ...on, asking: str(call.title) || "a step" };
    }
    case "elicitation/create":
      return { ...on, asking: str(p.message) || "an answer" };
    case "_aura/permission_resolved":
    case "_aura/elicitation_resolved":
      return { ...on, asking: null };
    default:
      return on;
  }
}

/** A frame folded into a window's view of the live workspace. */
export function liveStep(state: LiveState, frame: LiveFrame): LiveState {
  switch (frame.kind) {
    case "ready":
      // Whatever happened while the socket was away is on the message
      // list; the caller reads it again, and the next frames rebuild a
      // turn still under way.
      return {
        ...state,
        ...QUIET,
        up: true,
        reason: null,
        viewers: frame.viewers ?? state.viewers,
      };
    case "down":
      return { ...state, up: false, reason: frame.reason ?? null };
    case "presence":
      return { ...state, viewers: frame.viewers ?? state.viewers };
    case "message": {
      const role = frame.message.role;
      if (role === "assistant") return { ...state, ...QUIET };
      if (role === "user") return { ...state, working: true };
      return state;
    }
    case "acp_event": {
      const key = `${frame.event.acp_session_id}:${frame.event.seq}`;
      if (state.seen.includes(key)) return state;
      const seen = [...state.seen, key];
      return heard(
        {
          ...state,
          seen: seen.length > SEEN_CAP ? seen.slice(-SEEN_CAP) : seen,
        },
        frame.event,
      );
    }
    default:
      return state;
  }
}

/** A message that arrived live, put in its place on the list read so far. */
export function withMessage(
  list: CloudMessageRow[] | null,
  m: CloudMessageRow,
): CloudMessageRow[] | null {
  if (list === null) return list;
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0) return [...list.slice(0, at), m, ...list.slice(at + 1)];
  return [...list, m];
}

/** A fresh read of the list, keeping what arrived live after the read
 *  was taken. */
export function withRead(
  list: CloudMessageRow[] | null,
  read: CloudMessageRow[],
): CloudMessageRow[] {
  if (!list?.length) return read;
  const have = new Set(read.map((m) => m.id));
  const last = read.length ? Date.parse(read[read.length - 1].created_at) : -Infinity;
  const later = list.filter((m) => !have.has(m.id) && Date.parse(m.created_at) > last);
  return later.length ? [...read, ...later] : read;
}

type Envelope = { workspace_id: string; frame: LiveFrame };

/** Follow one workspace: frames go to `on` until the returned stop runs. */
export async function followWorkspace(
  id: string,
  on: (frame: LiveFrame) => void,
): Promise<() => void> {
  const unlisten: UnlistenFn = await listen<Envelope>(LIVE_EVENT, (e) => {
    if (e.payload?.workspace_id === id && e.payload.frame) on(e.payload.frame);
  });
  // Only a watch that took is given back: the desktop counts the windows
  // holding a socket, and one that never joined mustn't close another's.
  let joined = false;
  try {
    await invoke("cloud_workspace_watch", { workspaceId: id });
    joined = true;
    // A window that joins a socket another one opened never sees that
    // socket's greeting, so a watch that took is the greeting.
    on({ kind: "ready" });
  } catch (e) {
    on({ kind: "down", reason: e instanceof Error ? e.message : String(e) });
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    unlisten();
    if (joined) {
      void invoke<boolean>("cloud_workspace_unwatch", {
        workspaceId: id,
      }).catch(() => undefined);
    }
  };
}

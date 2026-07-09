//! Fold an append-only `NormalizedEvent[]` into a render-ready timeline.
//!
//! Producers re-emit the SAME `id` to update an event in place (a tool call
//! growing `running → completed`, assistant text accreting deltas, a todo list
//! replaced wholesale). The renderer wants the SETTLED state in first-
//! appearance order, plus quick handles to whatever the agent is currently
//! blocked on (a question set, a plan awaiting Build, a permission prompt).
//! This reducer is that fold — pure and deterministic, no engine knowledge.
//!
//! Merge rules, by kind:
//!   • text       — `delta` accretes onto the same id; a full `text` replaces.
//!   • tool_call  — shallow-merge keyed by `callId`: a later update (the result)
//!                  overlays status/content/output onto the original request,
//!                  keeping fields it doesn't carry (title, input).
//!   • everything else — same id replaces wholesale (todo/plan/question_set are
//!                  full-array/full-object snapshots by contract).

import type {
  NormalizedEvent,
  PermissionRequestEvent,
  PlanEvent,
  QuestionSetEvent,
  TodoEvent,
  ToolCallEvent,
} from "./events";

export type ReducedTimeline = {
  /** Settled events in first-appearance order — what the transcript renders. */
  events: NormalizedEvent[];
  /** The latest live checklist, if any (todo lists replace wholesale). */
  todos: TodoEvent | null;
  /** The newest unanswered question set the agent is blocked on. */
  pendingQuestions: QuestionSetEvent | null;
  /** The newest plan still awaiting Build / Revise. */
  pendingPlan: PlanEvent | null;
  /** The newest tool-permission prompt awaiting allow / deny. */
  pendingPermission: PermissionRequestEvent | null;
  /** Tool calls still `pending`/`running` — drives the "working" affordance. */
  activeToolCalls: ToolCallEvent[];
};

/** Key an event collapses on. Tool calls collapse by `callId` (request +
 *  result share it); everything else by its own `id`. */
function mergeKey(ev: NormalizedEvent): string {
  return ev.kind === "tool_call" ? `tool:${ev.callId}` : `${ev.kind}:${ev.id}`;
}

/** Overlay a later same-key event onto the prior settled one. Tool calls and
 *  text need field-level care; all other kinds are snapshot-replace. */
function merge(prev: NormalizedEvent, next: NormalizedEvent): NormalizedEvent {
  if (prev.kind === "tool_call" && next.kind === "tool_call") {
    return {
      ...prev,
      ...next,
      // A pending/running update may omit settled output; never clobber a real
      // result back to undefined. Keep the richer side per field.
      title: next.title || prev.title,
      input: Object.keys(next.input).length ? next.input : prev.input,
      content: next.content ?? prev.content,
      output: next.output ?? prev.output,
      isError: next.isError ?? prev.isError,
      durationMs: next.durationMs ?? prev.durationMs,
      locations: next.locations ?? prev.locations,
    };
  }
  if (prev.kind === "text" && next.kind === "text") {
    // `delta` accretes; a full `text` (no delta) is a replacement.
    if (next.delta != null) {
      return { ...next, text: prev.text + next.delta, delta: undefined };
    }
    return next;
  }
  // todo / plan / question_set / permission / result / status / session_init /
  // reasoning / error — the latest same-id event wins wholesale.
  return next;
}

/** Fold the raw list into the settled, ordered timeline plus the live handles
 *  the renderer needs. O(n); first-appearance order is preserved. */
export function reduceEvents(events: NormalizedEvent[]): ReducedTimeline {
  const byKey = new Map<string, NormalizedEvent>();
  const order: string[] = [];

  for (const ev of events) {
    const key = mergeKey(ev);
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, merge(prev, ev));
    } else {
      byKey.set(key, ev);
      order.push(key);
    }
  }

  const merged = order.map((k) => byKey.get(k)!);

  let todos: TodoEvent | null = null;
  let pendingQuestions: QuestionSetEvent | null = null;
  let pendingPlan: PlanEvent | null = null;
  let pendingPermission: PermissionRequestEvent | null = null;
  const activeToolCalls: ToolCallEvent[] = [];

  for (const ev of merged) {
    switch (ev.kind) {
      case "todo":
        todos = ev;
        break;
      case "question_set":
        // `partial` marks it still open / unanswered; latest wins.
        pendingQuestions = ev;
        break;
      case "plan":
        if (ev.awaitingApproval) pendingPlan = ev;
        break;
      case "permission_request":
        pendingPermission = ev;
        break;
      case "tool_call":
        if (ev.status === "pending" || ev.status === "running") {
          activeToolCalls.push(ev);
        }
        break;
      default:
        break;
    }
  }

  return {
    events: merged,
    todos,
    pendingQuestions,
    pendingPlan,
    pendingPermission,
    activeToolCalls,
  };
}

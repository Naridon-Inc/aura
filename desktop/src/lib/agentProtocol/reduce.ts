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
//!   • question_set / plan — shallow-merge: an engine reports the ANSWER (or
//!                  the approve/reject decision) as a same-id update that
//!                  carries only what it learned, so the questions and the
//!                  plan body must survive it.
//!   • everything else — same id replaces wholesale (a todo list is a
//!                  full-array snapshot by contract).

import type {
  NormalizedEvent,
  PermissionRequestEvent,
  PlanEvent,
  QuestionSetEvent,
  TodoEvent,
  ToolCallEvent,
  ToolCallStatus,
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
  if (prev.kind === "question_set" && next.kind === "question_set") {
    // The settle update knows the answer and nothing else — it must not blank
    // the questions the original carried.
    return {
      ...prev,
      ...next,
      questions: next.questions.length ? next.questions : prev.questions,
      answer: next.answer ?? prev.answer,
    };
  }
  if (prev.kind === "plan" && next.kind === "plan") {
    // Same shape: the decision arrives without the plan body.
    return {
      ...prev,
      ...next,
      entries: next.entries.length ? next.entries : prev.entries,
      markdown: next.markdown ?? prev.markdown,
      decision: next.decision ?? prev.decision,
    };
  }
  if (prev.kind === "text" && next.kind === "text") {
    // `delta` accretes; a full `text` (no delta) is a replacement.
    if (next.delta != null) {
      return { ...next, text: prev.text + next.delta, delta: undefined };
    }
    return next;
  }
  // todo / permission / result / status / session_init / reasoning / error —
  // the latest same-id event wins wholesale.
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

  // Tool-call status by callId, so a permission prompt can be judged against
  // the call it gates: once that call runs or settles, the human answered the
  // prompt (in this surface or in the terminal) and it is no longer pending.
  const callStatus = new Map<string, ToolCallStatus>();
  for (const ev of merged) {
    if (ev.kind === "tool_call") callStatus.set(ev.callId, ev.status);
  }

  for (const ev of merged) {
    switch (ev.kind) {
      case "todo":
        todos = ev;
        break;
      case "question_set":
        // Latest wins, and an ANSWERED set clears the handle rather than
        // leaving the newest question looking open for the rest of the
        // session. An engine that never reports answers leaves `answer`
        // absent, and its newest set stays pending until the next one.
        pendingQuestions = ev.answer == null ? ev : null;
        break;
      case "plan":
        pendingPlan = ev.awaitingApproval ? ev : null;
        break;
      case "permission_request": {
        const st = ev.callId ? callStatus.get(ev.callId) : undefined;
        const settled = st != null && st !== "pending";
        pendingPermission = settled ? null : ev;
        break;
      }
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

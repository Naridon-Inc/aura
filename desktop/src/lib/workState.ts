// What a piece of agent work is doing right now — one vocabulary, one colour
// ramp, for every surface that shows a crew.
//
// The crew surface described the same state four ways, and two of those are on
// screen together:
//
//                     the plan graph        the plan sidebar      the live
//                     (CrewNodeStatus)      (its own copy)        transcript
//   an agent on it    An agent is on it     An agent is on it     Working on it now
//   finished          Done                  Done                  Finished
//   waiting a turn    Queued                Queued                Queued — about to start
//
// and beside the transcript, the dispatch panel printed the enum: QUEUED,
// RUNNING, DONE, CONFLICT, CANCELLED, FAILED. Those are the runner's words in
// the runner's case, shown to someone who asked for a feature.
//
// The colours had drifted further than the words, and in a way that inverts
// the meaning. Two files each reasoned it out carefully and reached opposite
// conclusions, both comments still in the tree:
//
//   the plan graph      amber = an agent is on it   ("work in flight")
//   the dispatch panel  amber = someone has to look ("a warning, not a
//                                                     destination")
//
// So amber meant "healthy, running" in one panel and "stop and look" in the
// one next to it. Work in flight wins — the task board and the automations
// run dot already read it that way, three surfaces to one. A collision goes
// red with the failures: colour carries severity, the word carries which kind.
//
// The plan graph also spent two different greens one ramp apart — `ready` on
// --color-accent and `done` on --color-accent-green — which on a row of dots
// reads as "these two are the same". Ready is not a live state and doesn't
// need a hue; it sits on the neutral ramp now, and green means finished.
//
// (Its comment said "arctic-blue = ready". --color-accent has been emerald
// since the theme was re-cut; the comment was describing a colour the app
// stopped having.)

/** Every state a unit of agent work can be in, across both vocabularies the
 *  backend speaks — a lane the runner dispatched, and a node in a plan. */
export type WorkState =
  | "queued"
  | "ready"
  | "working"
  | "blocked"
  | "paused"
  | "conflict"
  | "done"
  | "failed"
  | "cancelled";

export type WorkStateTone = {
  /** The chip word — short enough to sit in a row of them. */
  label: string;
  /** The same state as a sentence, for a hover card or a line with room. */
  hint: string;
  /** Severity, not identity: `conflict` and `failed` share red because both
   *  mean "look here", and their labels say which. */
  color: string;
};

export const WORK_STATE: Record<WorkState, WorkStateTone> = {
  queued: {
    label: "Queued",
    hint: "Waiting its turn.",
    color: "var(--color-text-5)",
  },
  ready: {
    label: "Ready",
    hint: "Ready to start.",
    color: "var(--color-text-3)",
  },
  working: {
    label: "Working",
    hint: "An agent is on it.",
    color: "var(--color-amber)",
  },
  blocked: {
    label: "Waiting",
    hint: "Waiting on earlier work.",
    color: "var(--color-text-5)",
  },
  paused: {
    label: "Paused",
    hint: "Paused. Held back.",
    color: "var(--color-text-4)",
  },
  conflict: {
    label: "Needs you",
    hint: "Another lane touched the same files. Someone has to choose.",
    color: "var(--color-red)",
  },
  done: {
    label: "Done",
    hint: "Finished.",
    color: "var(--color-accent-green)",
  },
  failed: {
    label: "Failed",
    hint: "Hit a problem. Needs a retry.",
    color: "var(--color-red)",
  },
  cancelled: {
    label: "Stopped",
    hint: "Stopped before it finished.",
    color: "var(--color-text-4)",
  },
};

// The two vocabularies the backend actually sends. Kept as lookups rather than
// typed unions so this module doesn't have to import from the graph layer that
// defines one of them — a lib reaching up into components is how the copies
// started.

const FROM_LANE: Record<string, WorkState> = {
  queued: "queued",
  running: "working",
  done: "done",
  conflict: "conflict",
  cancelled: "cancelled",
  failed: "failed",
};

const FROM_NODE: Record<string, WorkState> = {
  ready: "ready",
  working: "working",
  blocked: "blocked",
  paused: "paused",
  failed: "failed",
  done: "done",
  // The graph's catch-all. A node with nothing scheduled is one waiting its
  // turn, which is what "queued" already says.
  other: "queued",
};

/** A dispatched lane's status → the app's word for it. */
export function laneState(status: string): WorkState {
  return FROM_LANE[status] ?? "queued";
}

/** A plan node's status → the app's word for it. */
export function nodeState(status: string): WorkState {
  return FROM_NODE[status] ?? "queued";
}

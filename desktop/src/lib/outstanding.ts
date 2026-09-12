// What is still open on a run, after the agent has stopped.
//
// An agent process ending is a fact about a process. The app kept letting it
// read as a fact about the work: the spinner stopped, the session went grey,
// the Summary showed a seal and a green goal, and everything the run left
// unfinished — a check that never ran, a check that failed, a decision it asked
// a person to make, a test only a human can perform — was somewhere else or
// nowhere at all. Nobody was told the run had ended *with things owing*.
//
// So this derives that list, from the evidence the run actually has plus the
// manual steps its plan asked for. Two rules:
//
//   • an item names what is needed, not just that something is missing, and
//     carries the one existing action that would settle it — the checks the app
//     can run, the comparison it can compute, the outcome a person can record.
//     Where nothing in the app can settle it, it says so and stays listed;
//   • an item leaves this list only when its evidence changes or a person
//     records an outcome. Nothing here closes because a process exited, because
//     a task was marked done, or because time passed.
//
// Pure and DOM-free: the wizard renders it, tests read it.

import { stalenessOf, type EvidenceStatus } from "./evidence";
import type { EvidenceItem } from "./sessionEvidence";
import type { ManualCheck } from "./manualChecks";

/** The one existing affordance that would settle an item. `none` is a real
 *  answer — some things genuinely cannot be settled from in here, and offering
 *  a button that does nothing is worse than saying so. */
export type OutstandingAction =
  | { kind: "none" }
  | { kind: "run_checks" }
  | { kind: "check_goal" }
  | { kind: "open_match" }
  | { kind: "record_manual"; checkId: string };

export type OutstandingTone = "bad" | "warn" | "muted";

export type OutstandingItem = {
  /** Stable for the life of the thing it describes, so the surface can key on
   *  it and a recorded outcome replaces the right row. */
  id: string;
  /** What is unresolved, in the reader's words. */
  title: string;
  /** What it would take to resolve it. */
  need: string;
  tone: OutstandingTone;
  action: OutstandingAction;
  /** True when only a person can settle it. Aura will never close these on its
   *  own, and says as much rather than leaving them looking merely overdue. */
  awaitingHuman: boolean;
};

/** How loudly an item asks to be looked at. A known failure beats a result that
 *  has expired, which beats work waiting on a person, which beats a check that
 *  was never run — a thing that broke is more urgent than a thing unknown. */
const RANK: Record<string, number> = { bad: 0, warn: 1, muted: 2 };

export type OutstandingInput = {
  /** The run's evidence ledger, from `sessionEvidence`. */
  evidence: EvidenceItem[];
  /** Its manual steps, merged from the plan and whatever has been recorded. */
  manual: ManualCheck[];
  /** The commit under review and when the reviewed code last moved — used to
   *  age recorded human outcomes exactly like any machine result. */
  review: { revision: string | null; changedAt: number | null };
};

export function outstandingItems(input: OutstandingInput): OutstandingItem[] {
  const items: OutstandingItem[] = [];
  for (const e of input.evidence) {
    const item = fromEvidence(e);
    if (item) items.push(item);
  }
  for (const c of input.manual) {
    const item = fromManual(c, input.review);
    if (item) items.push(item);
  }
  return items.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
}

// ── From the evidence ledger ─────────────────────────────────────────────
// Only the kinds something in the app can still act on. The rest of the
// ledger — the seal, where the code was saved, whether it was released — is
// rendered in full directly below this section, so nothing is hidden by being
// left off a list of things to do.

function fromEvidence(e: EvidenceItem): OutstandingItem | null {
  switch (e.kind) {
    case "executed_check":
      return checkItem(e, {
        action: { kind: "run_checks" },
        failTitle: "The project's checks came back with a problem",
        failNeed: "Fix what they caught, then run them again.",
        notRunTitle: "The project's checks have never been run on this",
        notRunNeed: "Run them to find out whether any of this works.",
        staleNeed: "Run them again against this version.",
      });
    case "structural_goal":
      return checkItem(e, {
        action: { kind: "check_goal" },
        failTitle: "Parts of what was asked for aren't in the code",
        failNeed: "Finish the missing parts, then check it again.",
        notRunTitle: "Nobody has checked whether this was built",
        notRunNeed: "Check it to see whether the parts are in the code.",
        staleNeed: "Check it again against this version.",
      });
    case "intent_alignment":
      if (e.status === "not_run") {
        return {
          id: "evidence:intent_alignment",
          title: "What was asked and what changed haven't been compared",
          need: "Open the Match tab and Aura works it out.",
          tone: "muted",
          action: { kind: "open_match" },
          awaitingHuman: false,
        };
      }
      if (e.status === "unsupported") {
        return {
          id: "evidence:intent_alignment",
          title: "What was asked and what changed can't be compared here",
          need: e.detail,
          tone: "muted",
          action: { kind: "none" },
          awaitingHuman: false,
        };
      }
      return null;
    default:
      return null;
  }
}

function checkItem(
  e: EvidenceItem,
  words: {
    action: OutstandingAction;
    failTitle: string;
    failNeed: string;
    notRunTitle: string;
    notRunNeed: string;
    staleNeed: string;
  },
): OutstandingItem | null {
  const id = `evidence:${e.kind}`;
  if (e.status === "fail") {
    return {
      id,
      title: words.failTitle,
      need: `${e.detail} ${words.failNeed}`.trim(),
      tone: "bad",
      action: words.action,
      awaitingHuman: false,
    };
  }
  if (e.status === "stale") {
    return {
      id,
      title: `${e.title} — the result is about older code`,
      need: `${e.staleReason} ${words.staleNeed}`.trim(),
      tone: "warn",
      action: words.action,
      awaitingHuman: false,
    };
  }
  if (e.status === "not_run") {
    return {
      id,
      title: words.notRunTitle,
      need: words.notRunNeed,
      tone: "warn",
      action: words.action,
      awaitingHuman: false,
    };
  }
  return null;
}

// ── From the manual steps ────────────────────────────────────────────────

function fromManual(
  c: ManualCheck,
  review: { revision: string | null; changedAt: number | null },
): OutstandingItem | null {
  if (c.state === "awaiting") {
    return {
      id: `manual:${c.id}`,
      title: c.text,
      need: "Aura can't do this one. Try it, then record what happened.",
      tone: "warn",
      action: { kind: "record_manual", checkId: c.id },
      awaitingHuman: true,
    };
  }

  if (c.state === "failed") {
    return {
      id: `manual:${c.id}`,
      title: c.text,
      need: c.note
        ? `Someone tried this and it didn't work: ${c.note}`
        : "Someone tried this and it didn't work.",
      tone: "bad",
      action: { kind: "record_manual", checkId: c.id },
      awaitingHuman: true,
    };
  }

  // A pass is a statement about the version it was tried on. The same rule that
  // ages a machine check ages this one: someone testing last week's build told
  // you about last week's build.
  const staleness = stalenessOf({ revision: c.revision, at: c.at }, review);
  if (!staleness.stale) return null;
  return {
    id: `manual:${c.id}`,
    title: c.text,
    need: `${staleness.reason} Try it again on this version and record what happened.`,
    tone: "warn",
    action: { kind: "record_manual", checkId: c.id },
    awaitingHuman: true,
  };
}

// ── Reading the list ─────────────────────────────────────────────────────

/** The line above the list. It exists to break the inference the whole ticket
 *  is about: the agent stopping is not the work being finished, and a page with
 *  nothing red on it is not a page that says this works. */
export function outstandingLead(items: OutstandingItem[]): string {
  if (items.length === 0) {
    return "The agent has finished and nothing here is waiting on a person or a re-check.";
  }
  const people = items.filter((i) => i.awaitingHuman).length;
  const rest = items.length - people;
  const parts: string[] = [];
  if (rest > 0) parts.push(rest === 1 ? "1 check" : `${rest} checks`);
  if (people > 0) parts.push(people === 1 ? "1 step for a person" : `${people} steps for a person`);
  return `The agent has finished. ${parts.join(" and ")} still open.`;
}

/** Whether anything at all is unresolved — for a caller that wants to show a
 *  count somewhere else without re-deriving the list. */
export function hasOutstanding(items: OutstandingItem[]): boolean {
  return items.length > 0;
}

/** What an evidence status contributes, for callers that hold a status without
 *  a full item — kept here so one table decides what counts as unresolved. */
export function statusIsUnresolved(status: EvidenceStatus): boolean {
  return status === "fail" || status === "stale" || status === "not_run";
}

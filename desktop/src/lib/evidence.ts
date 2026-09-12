// What a result actually establishes — one vocabulary for the whole review.
//
// A session wizard puts five different kinds of result on one page: a signed
// record, an asked-vs-changed comparison, a goal Aura proved by reading the
// code, checks that really ran, and where the commit ended up. They are drawn
// the same way — a word, a tick, a colour — so they read as one claim getting
// stronger. They are not. Each answers a different question, and each is silent
// about the questions the others answer:
//
//   • a valid signature says the record wasn't altered. It says nothing about
//     whether the code works;
//   • a structural goal pass says the parts exist in the code and are wired
//     together. Nothing ran. No test passed;
//   • a successful push says bytes reached a remote. Nobody is running it.
//
// So every kind carries two fixed sentences: what it establishes, and what it
// explicitly does not. They travel together — a surface that shows one without
// the other is how "sealed" came to mean "working".
//
// The second half of this module is about time. A check is a statement about a
// particular version of the code, and it stops being true the moment the code
// moves. A verdict recorded against one commit must not read as current on
// another, and an open task is not evidence that a check is still good.
//
// Pure and DOM-free on purpose: these are the rules, testable without a
// renderer. See components/workpanes/SessionEvidence for the drawing.

/** The kinds of evidence a review surface can hold. Each is a different
 *  question with a different answer; none of them substitutes for another. */
export type EvidenceKind =
  | "record_integrity"
  | "intent_alignment"
  | "structural_goal"
  | "executed_check"
  | "git_fact"
  | "deployment";

/** How a result stands. Absence has three distinct shapes and none of them is
 *  a pass: nobody ran it, it can't be run here, or there's nothing to read. */
export type EvidenceStatus =
  | "pass"
  | "fail"
  | "not_run"
  | "unsupported"
  | "unavailable"
  | "stale";

/** Who says so. An agent reporting its own success is a claim; Aura running a
 *  check is an observation. Collapsing the two is how "the AI said it's done"
 *  became a green tick. */
export type Observer = "aura" | "agent";

/** The colour family a status earns. Only a real pass is ever green. */
export type EvidenceTone = "good" | "bad" | "warn" | "muted";

export type EvidenceMeaning = {
  /** What this kind is called, to someone who doesn't write code. */
  title: string;
  /** The claim it genuinely supports. */
  establishes: string;
  /** The claim people read into it that it does not support. */
  doesNotEstablish: string;
};

const MEANING: Record<EvidenceKind, EvidenceMeaning> = {
  record_integrity: {
    title: "The record is intact",
    establishes:
      "Nothing in this record has been altered since it was written down.",
    doesNotEstablish:
      "It says nothing about whether the change works. An intact record of a broken change is still intact.",
  },
  intent_alignment: {
    title: "The change matches what was asked",
    establishes:
      "The code that changed lines up with what was asked for and what the AI said it would do.",
    doesNotEstablish:
      "Matching the request is not the same as working. Nothing was run to find out.",
  },
  structural_goal: {
    title: "The parts are in the code",
    establishes:
      "Aura read the code and found the parts this needs, connected to each other.",
    doesNotEstablish:
      "Aura read the code, it did not run it. No test passed because of this.",
  },
  executed_check: {
    title: "Checks that actually ran",
    establishes:
      "These commands really ran against this code, and this is what they returned.",
    doesNotEstablish:
      "Only what was run was checked. Anything those commands don't cover is still untried.",
  },
  git_fact: {
    title: "Where the code ended up",
    establishes:
      "The change is recorded in the project's history at the version named here.",
    doesNotEstablish:
      "Saving and sending code is not releasing it. Nobody is running this because of that.",
  },
  deployment: {
    title: "Released to people",
    establishes: "The change reached somewhere people actually use.",
    doesNotEstablish:
      "Being live says nothing about being correct. It only says it is out there.",
  },
};

/** The reading order for a review surface: integrity, then what was intended,
 *  then what was read, then what was run, then where it went. Weakest evidence
 *  of working behaviour first, so the page doesn't build to a false crescendo. */
export const EVIDENCE_ORDER: EvidenceKind[] = [
  "record_integrity",
  "intent_alignment",
  "structural_goal",
  "executed_check",
  "git_fact",
  "deployment",
];

export function meaningOf(kind: EvidenceKind): EvidenceMeaning {
  return MEANING[kind];
}

/** The one cross-kind rule the whole module exists to hold: only a check that
 *  actually executed can speak to whether the software behaves. Reading code,
 *  signing a record and pushing a commit all cannot, however green they look. */
export function impliesWorkingBehaviour(kind: EvidenceKind): boolean {
  return kind === "executed_check";
}

const STATUS_WORD: Record<EvidenceStatus, string> = {
  pass: "Passed",
  fail: "Failed",
  not_run: "Not run",
  unsupported: "Can't check here",
  unavailable: "No evidence",
  stale: "Out of date",
};

/** One line saying what this status means, for the reader who wants to know
 *  why a row isn't green. Absence never borrows a pass's words. */
const STATUS_HINT: Record<EvidenceStatus, string> = {
  pass: "This was checked and it came back clean.",
  fail: "This was checked and it came back with a problem.",
  not_run: "Nobody has run this. It is neither passing nor failing.",
  unsupported: "This can't be worked out from here, so it stays unanswered.",
  unavailable: "There is nothing recorded to read. Missing is not passing.",
  stale: "This ran against an older version of the code. Run it again to know.",
};

export function statusWord(status: EvidenceStatus): string {
  return STATUS_WORD[status];
}

export function statusHint(status: EvidenceStatus): string {
  return STATUS_HINT[status];
}

/** Only a genuine pass earns the good tone. A failure is bad, an out-of-date
 *  result is a warning, and every flavour of "we don't know" stays muted —
 *  never green, never alarming. */
export function toneOf(status: EvidenceStatus): EvidenceTone {
  if (status === "pass") return "good";
  if (status === "fail") return "bad";
  if (status === "stale") return "warn";
  return "muted";
}

export function observerNote(observer: Observer): string {
  return observer === "agent"
    ? "The AI reported this about its own work. Aura did not check it."
    : "Aura worked this out itself.";
}

// ── Time and revision ──────────────────────────────────────────────────────

/** When and against what a result was produced. `revision` is null when the
 *  check ran against uncommitted working code. */
export type CheckedAt = {
  revision?: string | null;
  /** Unix millis. Null when the check never ran. */
  at?: number | null;
};

/** The version being reviewed, and when its code last moved. */
export type UnderReview = {
  revision?: string | null;
  /** Unix millis of the newest change to the reviewed code. */
  changedAt?: number | null;
};

export type Staleness = {
  stale: boolean;
  /** Plain sentence naming why it no longer applies. Empty when it still does,
   *  and empty when there is no result to be stale in the first place. */
  reason: string;
};

const FRESH: Staleness = { stale: false, reason: "" };

/** Does a recorded result still describe the code being reviewed?
 *
 *  Deliberately narrow: it looks at the version the check ran against and the
 *  clock, and at nothing else. In particular it never consults the task or
 *  goal the check belongs to — a task staying open is not evidence that a check
 *  is still good, and treating it as such is how a verdict from last week came
 *  to sit on top of code written this morning. */
export function stalenessOf(checked: CheckedAt, review: UnderReview): Staleness {
  const at = checked.at ?? null;
  // Never run means never stale. The status already says "Not run", and calling
  // that out of date would imply a result exists to have expired.
  if (at == null) return FRESH;

  const was = normaliseRevision(checked.revision);
  const now = normaliseRevision(review.revision);

  if (was && now && !sameRevision(was, now)) {
    return {
      stale: true,
      reason:
        "This was checked against a different version of the code than the one you're looking at.",
    };
  }
  if (!was && now) {
    return {
      stale: true,
      reason:
        "This was checked against uncommitted code, not the saved version you're looking at.",
    };
  }
  if (was && !now) {
    return {
      stale: true,
      reason:
        "This was checked against a saved version, and you're looking at code that has since been edited.",
    };
  }

  const changedAt = review.changedAt ?? null;
  if (changedAt != null && at < changedAt) {
    return {
      stale: true,
      reason: "The code changed after this was checked.",
    };
  }
  return FRESH;
}

/** The status a result should carry once staleness is taken into account. A
 *  stale pass is not a pass; a stale failure is still worth showing as stale,
 *  because the problem it found may already be fixed. Absence is left alone —
 *  there is no result to age. */
export function agedStatus(
  status: EvidenceStatus,
  staleness: Staleness,
): EvidenceStatus {
  if (!staleness.stale) return status;
  if (status === "pass" || status === "fail") return "stale";
  return status;
}

function normaliseRevision(rev?: string | null): string {
  return (rev ?? "").trim();
}

/** Git shortens shas freely, so one surface's `a1b2c3d` and another's full
 *  40-character form are the same commit and must not read as two versions. */
function sameRevision(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 7 && longer.startsWith(shorter);
}

// ── Combining ──────────────────────────────────────────────────────────────

/** Severity, worst first — the order a summary must respect so it can never
 *  read greener than the evidence under it. */
const SEVERITY: EvidenceStatus[] = [
  "fail",
  "stale",
  "unavailable",
  "unsupported",
  "not_run",
  "pass",
];

/** The honest headline status for a set of results.
 *
 *  Passing requires every result to pass, and requires there to be results at
 *  all: an empty ledger is "no evidence", never a clean bill. Anything less
 *  than unanimous reports the weakest thing in the set, so one failure or one
 *  out-of-date verdict is never averaged away by the greens around it. */
export function overallStatus(statuses: EvidenceStatus[]): EvidenceStatus {
  if (statuses.length === 0) return "unavailable";
  for (const candidate of SEVERITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "unavailable";
}

/** Can this set of results support "it works"? Only if something actually ran
 *  and passed. A page full of green signatures, matches and pushes cannot. */
export function supportsWorkingClaim(
  items: Array<{ kind: EvidenceKind; status: EvidenceStatus }>,
): boolean {
  return items.some(
    (i) => impliesWorkingBehaviour(i.kind) && i.status === "pass",
  );
}

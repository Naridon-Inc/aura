// The evidence ledger for one run — what the wizard actually holds, sorted into
// kinds, with every claim bounded to the version it was made about.
//
// This is the assembly half of `lib/evidence`: that module says what each kind
// of result may claim, this one says which results this particular run has. It
// is deliberately a pure function of plain data so the scenario the ticket asks
// for — a sealed run with a structural pass, a failing check and a push but no
// deployment — can be built and read without a renderer.
//
// Two rules do all the work here:
//   • a row exists for every kind, including the kinds with nothing in them.
//     A missing deployment has to be visible as "no evidence", because the
//     alternative is a reviewer inferring deployment from a green page;
//   • every result carries the version it was measured against, and any result
//     measured against another version reads as out of date. Nothing about the
//     goal, the task or the session can override that.

import {
  agedStatus,
  meaningOf,
  stalenessOf,
  type EvidenceKind,
  type EvidenceStatus,
  type Observer,
} from "./evidence";
import type { GoalVerdict } from "./goalStore";

export type EvidenceItem = {
  kind: EvidenceKind;
  /** Plain-words name of the kind, from the shared vocabulary. */
  title: string;
  status: EvidenceStatus;
  observer: Observer;
  /** The concrete fact for this run, in plain words. */
  detail: string;
  /** Why the result no longer describes the reviewed code. Empty when it does,
   *  and empty when there is no result to have expired. */
  staleReason: string;
  /** The version this result is about; null when it was measured against
   *  uncommitted code or measures nothing. */
  revision: string | null;
  /** Unix millis the result was produced; null when it never was. */
  checkedAt: number | null;
};

/** What a goal's structural verdict is worth as evidence. Only "everything is
 *  there" passes: a partial result did not establish the goal, and calling it
 *  anything softer than a failed check is how "4 of 7 parts" came to sit under
 *  a green tick. */
export function statusFromGoalVerdict(verdict: GoalVerdict): EvidenceStatus {
  if (verdict === "verified") return "pass";
  if (verdict === "unknown") return "not_run";
  return "fail";
}

export type GoalEvidence = {
  verdict: GoalVerdict;
  ok: number;
  total: number;
  /** Unix millis of the check; null when it never ran. */
  at: number | null;
  /** The commit it was anchored to; null for a working-tree check. */
  revision: string | null;
};

export type ChecksEvidence = {
  status: EvidenceStatus;
  /** One plain line of counts. */
  line: string;
  /** Unix millis; null when nothing is recorded. */
  ranAt: number | null;
  /** The commit they ran against, when known. The Checks surface doesn't record
   *  one today, so this is usually null — which is itself a fact the staleness
   *  rule uses rather than papers over. */
  revision: string | null;
};

export type SessionEvidenceInput = {
  /** Does this run carry a signed record block? */
  signed: boolean;
  /** Whether an asked-vs-changed comparison can be computed here at all, and
   *  the plain reason when it can't. */
  alignment: { available: boolean; unsupportedReason: string };
  /** The commit under review; null for a working-tree run. */
  revision: string | null;
  /** Unix millis the reviewed code last moved. */
  codeChangedAt: number | null;
  /** How many files this run changed. */
  fileCount: number;
  goal: GoalEvidence | null;
  checks: ChecksEvidence | null;
};

/** Build the run's ledger, in the shared reading order. Every kind gets a row;
 *  the kinds this run has nothing for say so in their own words. */
export function sessionEvidence(input: SessionEvidenceInput): EvidenceItem[] {
  const review = { revision: input.revision, changedAt: input.codeChangedAt };
  const items: EvidenceItem[] = [];

  // 1 · The record itself. Sealed or not is a property of the row, known
  // without running anything; the seal's live re-check lives on its own tab.
  items.push(
    plain(
      "record_integrity",
      input.signed ? "pass" : "unavailable",
      input.signed
        ? "This run is sealed. Aura re-checks the seal itself on the Genuine record tab."
        : "This run wasn't sealed, so there's no seal to check.",
    ),
  );

  // 2 · Asked versus changed. Available or not, it is never a pass from here:
  // the comparison is computed when its tab is opened, and a row that claimed
  // the result of a check nobody asked for would be the exact fault this
  // ledger exists to catch.
  items.push(
    input.alignment.available
      ? plain(
          "intent_alignment",
          "not_run",
          "Open the Match tab and Aura compares what was asked with what actually changed.",
        )
      : plain("intent_alignment", "unsupported", input.alignment.unsupportedReason),
  );

  // 3 · The structural goal check — the one most easily mistaken for a test.
  items.push(goalItem(input.goal, review));

  // 4 · Checks that really executed. The only kind that can speak to behaviour,
  // and the one most often simply absent.
  items.push(checksItem(input.checks, review));

  // 5 · Where the change ended up. Only shown when this run changed something.
  if (input.fileCount > 0) {
    items.push(
      input.revision
        ? plain(
            "git_fact",
            "pass",
            `Saved in the project's history as ${shortRevision(input.revision)}.`,
            input.revision,
          )
        : plain(
            "git_fact",
            "unavailable",
            "These changes aren't saved to the project's history yet.",
          ),
    );
  }

  // 6 · Release. Aura observes nothing here, and that silence has to be a row:
  // a reviewer reading a page of green must be able to see that nothing on it
  // said the change reached anyone.
  items.push(
    plain(
      "deployment",
      "unavailable",
      "Aura has no record of this change being released anywhere.",
    ),
  );

  return items;
}

function goalItem(
  goal: GoalEvidence | null,
  review: { revision: string | null; changedAt: number | null },
): EvidenceItem {
  if (!goal || goal.at == null) {
    return plain(
      "structural_goal",
      "not_run",
      "Nobody has asked Aura to check whether the parts of this are in the code.",
    );
  }
  const staleness = stalenessOf({ revision: goal.revision, at: goal.at }, review);
  const base = statusFromGoalVerdict(goal.verdict);
  return {
    kind: "structural_goal",
    title: meaningOf("structural_goal").title,
    status: agedStatus(base, staleness),
    observer: "aura",
    detail: goalDetail(goal),
    staleReason: staleness.reason,
    revision: goal.revision,
    checkedAt: goal.at,
  };
}

function goalDetail(goal: GoalEvidence): string {
  if (goal.total <= 0) {
    return "Aura couldn't work out which parts this needs.";
  }
  if (goal.ok >= goal.total) {
    return `All ${goal.total} ${parts(goal.total)} this needs are in the code.`;
  }
  return `${goal.ok} of ${goal.total} ${parts(goal.total)} this needs are in the code.`;
}

function checksItem(
  checks: ChecksEvidence | null,
  review: { revision: string | null; changedAt: number | null },
): EvidenceItem {
  if (!checks || checks.ranAt == null) {
    return plain(
      "executed_check",
      "not_run",
      "No checks have been run against this code. Nothing here has been tried.",
    );
  }
  // The Checks surface records when it ran but not which version it ran
  // against. Feeding that gap in as "no revision" would produce a confident
  // wrong sentence — "checked against uncommitted code" — about something we
  // simply don't know. With the version unknown the only honest question left
  // is the clock: did these run before this code existed?
  const revisionKnown = (checks.revision ?? "").trim() !== "";
  const staleness = stalenessOf(
    { revision: revisionKnown ? checks.revision : review.revision, at: checks.ranAt },
    review,
  );
  return {
    kind: "executed_check",
    title: meaningOf("executed_check").title,
    status: agedStatus(checks.status, staleness),
    observer: "aura",
    detail: revisionKnown
      ? checks.line
      : `${checks.line} Aura doesn't record which version they ran against.`,
    staleReason: staleness.reason,
    revision: revisionKnown ? checks.revision : null,
    checkedAt: checks.ranAt,
  };
}

/** The weakest verdict in a set — the one a summary has to report. A goal that
 *  was checked and came up short outranks one that was never checked, because
 *  a known shortfall is a stronger reason to look than an open question. */
export function weakestVerdict(verdicts: GoalVerdict[]): GoalVerdict {
  const order: GoalVerdict[] = ["not_wired", "partial", "unknown", "verified"];
  for (const candidate of order) {
    if (verdicts.includes(candidate)) return candidate;
  }
  return "unknown";
}

/** Fold the checks recorded *against this run* into one piece of evidence.
 *
 *  Only runs stamped with this run's key belong here: a verdict another session
 *  recorded on the same goal is evidence about that session's code, and letting
 *  it stand in is exactly how an old pass came to describe new work. Freshness
 *  takes the oldest check in the set, because a ledger is only as current as
 *  its stalest member, and the version is dropped when the checks disagree
 *  about which one they measured. */
export function foldGoalEvidence(runs: GoalEvidenceRun[]): GoalEvidence | null {
  const dated = runs.filter((r) => typeof r.at === "number");
  if (dated.length === 0) return null;
  let ok = 0;
  let total = 0;
  let oldest = dated[0].at;
  const revisions = new Set<string>();
  for (const r of dated) {
    ok += r.ok;
    total += r.total;
    if (r.at < oldest) oldest = r.at;
    revisions.add((r.commit ?? "").trim());
  }
  return {
    verdict: weakestVerdict(dated.map((r) => r.verdict)),
    ok,
    total,
    at: oldest,
    revision: revisions.size === 1 ? [...revisions][0] || null : null,
  };
}

/** The shape `foldGoalEvidence` needs from a stored goal run — a structural
 *  subset of `goalStore`'s `GoalRun`, so the fold stays testable on its own. */
export type GoalEvidenceRun = {
  verdict: GoalVerdict;
  ok: number;
  total: number;
  at: number;
  commit?: string | null;
};

function plain(
  kind: EvidenceKind,
  status: EvidenceStatus,
  detail: string,
  revision: string | null = null,
): EvidenceItem {
  return {
    kind,
    title: meaningOf(kind).title,
    status,
    observer: "aura",
    detail,
    staleReason: "",
    revision,
    checkedAt: null,
  };
}

function parts(n: number): string {
  return n === 1 ? "part" : "parts";
}

/** Git's own short form — enough to identify a version, short enough to read. */
export function shortRevision(rev: string): string {
  const trimmed = rev.trim();
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
}

// What is still open after the agent stops.
//
//   bun test ./tests/outstanding.test.ts
//
// AURA-1365: a process exiting is not a goal being met. The session went grey,
// the Summary showed a seal and a verdict, and the checks that failed, the ones
// that never ran, and the handset test a person still owed were nowhere on the
// page. These tests are the reader who comes back an hour later and needs to
// know what is left — and they hold the list to the rule that nothing leaves it
// except by evidence changing or a person recording an outcome.

import { describe, expect, it } from "bun:test";

import { sessionEvidence, type SessionEvidenceInput } from "../src/lib/sessionEvidence";
import { outstandingItems, outstandingLead, type OutstandingItem } from "../src/lib/outstanding";
import type { ManualCheck } from "../src/lib/manualChecks";

const HOUR = 3_600_000;
const NOW = 1_757_000_000_000;
const COMMIT = "a1b2c3d4e5f6";
const RUN = "block_9f2";
const HANDSET = "Call the number and check the callback arrives on a real handset";

/** A finished run in its best case: sealed, committed, a passing structural
 *  check and the project's checks green against the same version. */
function input(over: Partial<SessionEvidenceInput> = {}): SessionEvidenceInput {
  return {
    signed: true,
    alignment: { available: true, unsupportedReason: "" },
    revision: COMMIT,
    codeChangedAt: NOW - HOUR,
    fileCount: 3,
    goal: { verdict: "verified", ok: 4, total: 4, at: NOW, revision: COMMIT },
    checks: { status: "pass", line: "3 passed.", ranAt: NOW, revision: COMMIT },
    ...over,
  };
}

function items(
  over: Partial<SessionEvidenceInput> = {},
  manual: ManualCheck[] = [],
): OutstandingItem[] {
  const base = input(over);
  return outstandingItems({
    evidence: sessionEvidence(base),
    manual,
    review: { revision: base.revision, changedAt: base.codeChangedAt },
  });
}

function find(list: OutstandingItem[], id: string): OutstandingItem {
  const found = list.find((i) => i.id === id);
  if (!found) throw new Error(`no "${id}" in [${list.map((i) => i.id).join(", ")}]`);
  return found;
}

function manual(over: Partial<ManualCheck> = {}): ManualCheck {
  return {
    id: "manual_x1",
    runKey: RUN,
    text: HANDSET,
    state: "awaiting",
    note: "",
    at: null,
    revision: null,
    by: "",
    ...over,
  };
}

describe("what a finished run still owes", () => {
  it("says the agent finished without saying the work did", () => {
    const list = items({ alignment: { available: false, unsupportedReason: "" } });

    expect(outstandingLead(list)).toContain("The agent has finished");
    // Never a sentence a reader can take as "and it works".
    expect(outstandingLead(list).toLowerCase()).not.toContain("works");
  });

  it("carries a failing check as the loudest thing on the list", () => {
    const list = items({
      checks: { status: "fail", line: "2 passed and 1 came back with a problem.", ranAt: NOW, revision: COMMIT },
    });

    const first = list[0];
    expect(first.id).toBe("evidence:executed_check");
    expect(first.tone).toBe("bad");
    expect(first.need).toContain("run them again");
  });

  it("keeps a check nobody ever ran on the list, rather than reading silence as fine", () => {
    const list = items({ checks: null });

    const item = find(list, "evidence:executed_check");
    expect(item.title).toContain("never been run");
    expect(item.action).toEqual({ kind: "run_checks" });
  });

  it("lists a structural check that came up short, with what is missing", () => {
    const list = items({
      goal: { verdict: "partial", ok: 2, total: 5, at: NOW, revision: COMMIT },
    });

    const item = find(list, "evidence:structural_goal");
    expect(item.tone).toBe("bad");
    expect(item.need).toContain("2 of 5");
    expect(item.action).toEqual({ kind: "check_goal" });
  });

  it("re-opens a result that was measured against different code", () => {
    // The check passed — against the commit before this one.
    const list = items({
      goal: { verdict: "verified", ok: 4, total: 4, at: NOW - 2 * HOUR, revision: "9f8e7d6c" },
    });

    const item = find(list, "evidence:structural_goal");
    expect(item.tone).toBe("warn");
    expect(item.need).toContain("Check it again against this version");
  });

  it("offers the comparison that exists instead of describing it", () => {
    const item = find(items(), "evidence:intent_alignment");

    expect(item.action).toEqual({ kind: "open_match" });
  });

  it("reports a comparison that can't be made here, and keeps it listed", () => {
    const list = items({
      alignment: {
        available: false,
        unsupportedReason: "This record came from the cloud, so the code isn't on this computer.",
      },
    });

    const item = find(list, "evidence:intent_alignment");
    expect(item.need).toContain("came from the cloud");
    expect(item.action).toEqual({ kind: "none" });
  });

  it("leaves nothing on the list when every result is green and current", () => {
    const list = items({ alignment: { available: false, unsupportedReason: "" } });

    // The alignment row is the only survivor in the all-green case, and only
    // because it genuinely hasn't been computed. Drop it and the list is empty.
    expect(list.filter((i) => i.id !== "evidence:intent_alignment")).toHaveLength(0);
  });
});

describe("a step only a person can do", () => {
  it("is waiting on a human from the moment the plan names it", () => {
    const list = items({}, [manual()]);

    const item = find(list, "manual:manual_x1");
    expect(item.awaitingHuman).toBe(true);
    expect(item.title).toBe(HANDSET);
    expect(item.need).toContain("record what happened");
  });

  it("stays on the list although the run ended and everything else is green", () => {
    const list = items({}, [manual()]);

    expect(list.some((i) => i.id === "manual:manual_x1")).toBe(true);
  });

  it("leaves the list only when a person records that it worked", () => {
    const done = manual({ state: "passed", at: NOW, revision: COMMIT, by: "Ashiq" });

    expect(items({}, [done]).some((i) => i.id.startsWith("manual:"))).toBe(false);
  });

  it("comes back when the code moves under a passing human outcome", () => {
    const done = manual({ state: "passed", at: NOW - 3 * HOUR, revision: "9f8e7d6c", by: "Ashiq" });

    const item = find(items({}, [done]), "manual:manual_x1");
    expect(item.tone).toBe("warn");
    expect(item.need).toContain("Try it again on this version");
  });

  it("keeps a failed human outcome loud, with what the person saw", () => {
    const failed = manual({ state: "failed", note: "Silent — no callback in 5 min", at: NOW });

    const item = find(items({}, [failed]), "manual:manual_x1");
    expect(item.tone).toBe("bad");
    expect(item.need).toContain("no callback in 5 min");
    expect(item.awaitingHuman).toBe(true);
  });

  it("counts people's steps apart from checks in the line above the list", () => {
    const list = items({ checks: null }, [manual()]);

    const lead = outstandingLead(list);
    expect(lead).toContain("1 step for a person");
    expect(lead).toContain("check");
  });

  it("says plainly when nothing is left, without implying the change works", () => {
    const lead = outstandingLead([]);

    expect(lead).toContain("nothing here is waiting");
    expect(lead.toLowerCase()).not.toContain("works");
    expect(lead.toLowerCase()).not.toContain("done");
  });
});

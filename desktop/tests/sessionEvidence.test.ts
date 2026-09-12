// The evidence ledger a reviewer reads on a run.
//
//   bun test ./tests/sessionEvidence.test.ts
//
// AURA-1364's acceptance scenario, built as data: a signed run with a passing
// structural check, a failing check that really ran, and a commit but no
// deployment evidence — then the code moves. An unfamiliar reviewer has to come
// away with the failure, the missing deployment and which earlier results are
// now out of date. These tests are that reviewer.

import { describe, expect, test } from "bun:test";

import { supportsWorkingClaim, type EvidenceKind } from "../src/lib/evidence";
import {
  foldGoalEvidence,
  sessionEvidence,
  statusFromGoalVerdict,
  weakestVerdict,
  type EvidenceItem,
  type SessionEvidenceInput,
} from "../src/lib/sessionEvidence";

const HOUR = 3_600_000;
const NOW = 1_757_000_000_000;

function pick(items: EvidenceItem[], kind: EvidenceKind): EvidenceItem {
  const found = items.find((i) => i.kind === kind);
  if (!found) throw new Error(`no ${kind} row in the ledger`);
  return found;
}

/** The scenario the ticket specifies, at the moment of review. */
function scenario(over: Partial<SessionEvidenceInput> = {}): SessionEvidenceInput {
  return {
    signed: true,
    alignment: { available: true, unsupportedReason: "" },
    revision: "a1b2c3d",
    codeChangedAt: NOW - 4 * HOUR,
    fileCount: 3,
    goal: {
      verdict: "verified",
      ok: 4,
      total: 4,
      at: NOW - 3 * HOUR,
      revision: "a1b2c3d",
    },
    checks: {
      status: "fail",
      line: "2 passed and 1 came back with a problem.",
      ranAt: NOW - 3 * HOUR,
      revision: "a1b2c3d",
    },
    ...over,
  };
}

describe("every kind gets a row, including the empty ones", () => {
  test("a missing release is visible, not simply absent", () => {
    const items = sessionEvidence(scenario());
    const release = pick(items, "deployment");
    expect(release.status).toBe("unavailable");
    expect(release.detail).toMatch(/no record of this change being released/i);
  });

  test("a run that changed nothing has no history row to claim", () => {
    const items = sessionEvidence(scenario({ fileCount: 0, revision: null }));
    expect(items.find((i) => i.kind === "git_fact")).toBeUndefined();
  });

  test("an unsealed run says there is no seal, not that the seal failed", () => {
    const items = sessionEvidence(scenario({ signed: false }));
    const record = pick(items, "record_integrity");
    expect(record.status).toBe("unavailable");
    expect(record.status).not.toBe("fail");
  });

  test("a comparison that can't be computed here says why", () => {
    const items = sessionEvidence(
      scenario({
        alignment: {
          available: false,
          unsupportedReason: "This run has no saved version to compare against.",
        },
      }),
    );
    const match = pick(items, "intent_alignment");
    expect(match.status).toBe("unsupported");
    expect(match.detail).toMatch(/no saved version/i);
  });

  test("a comparison nobody has asked for is never reported as passing", () => {
    const match = pick(sessionEvidence(scenario()), "intent_alignment");
    expect(match.status).toBe("not_run");
  });
});

describe("the reviewer reads the run as specified", () => {
  const items = sessionEvidence(scenario());

  test("the failure is the failure", () => {
    expect(pick(items, "executed_check").status).toBe("fail");
  });

  test("the structural pass stays a structural pass", () => {
    const goal = pick(items, "structural_goal");
    expect(goal.status).toBe("pass");
    expect(goal.detail).toMatch(/in the code/i);
  });

  test("the commit is a saved version, named", () => {
    const git = pick(items, "git_fact");
    expect(git.status).toBe("pass");
    expect(git.detail).toContain("a1b2c3d");
  });

  test("none of the green here adds up to working software", () => {
    // The one row that could speak to behaviour is the one that failed.
    expect(supportsWorkingClaim(items)).toBe(false);
  });
});

describe("then the code changes", () => {
  // Same run, reviewed after later edits landed on top of it: the reviewed
  // version has moved on from the one every earlier result was measured against.
  const after = sessionEvidence(
    scenario({ revision: "9f8e7d6", codeChangedAt: NOW }),
  );

  test("the structural pass is no longer current", () => {
    const goal = pick(after, "structural_goal");
    expect(goal.status).toBe("stale");
    expect(goal.staleReason).toMatch(/different version/i);
  });

  test("the failing check is out of date too, not quietly resolved", () => {
    const checks = pick(after, "executed_check");
    expect(checks.status).toBe("stale");
    expect(checks.staleReason).not.toBe("");
  });

  test("each out-of-date row still names the version it was measured against", () => {
    for (const row of after.filter((r) => r.status === "stale")) {
      expect(row.revision).toBe("a1b2c3d");
      expect(row.checkedAt).not.toBeNull();
    }
  });

  test("the seal is unaffected — it was never about the code working", () => {
    expect(pick(after, "record_integrity").status).toBe("pass");
  });
});

describe("a structural verdict is worth exactly what it is", () => {
  test("only everything-in-place passes", () => {
    expect(statusFromGoalVerdict("verified")).toBe("pass");
  });

  test("a partial result did not establish the goal", () => {
    expect(statusFromGoalVerdict("partial")).toBe("fail");
    expect(statusFromGoalVerdict("not_wired")).toBe("fail");
  });

  test("an inconclusive check is not run, not failed", () => {
    expect(statusFromGoalVerdict("unknown")).toBe("not_run");
  });

  test("a goal nobody checked reads as not run, and says so plainly", () => {
    const goal = pick(sessionEvidence(scenario({ goal: null })), "structural_goal");
    expect(goal.status).toBe("not_run");
    expect(goal.detail).toMatch(/nobody has asked/i);
  });

  test("a partial count is spelled out rather than rounded to a verdict", () => {
    const goal = pick(
      sessionEvidence(
        scenario({
          goal: { verdict: "partial", ok: 4, total: 7, at: NOW, revision: "a1b2c3d" },
        }),
      ),
      "structural_goal",
    );
    expect(goal.detail).toContain("4 of 7");
  });
});

describe("checks that were never run", () => {
  test("read as untried, never as clean", () => {
    const checks = pick(sessionEvidence(scenario({ checks: null })), "executed_check");
    expect(checks.status).toBe("not_run");
    expect(checks.detail).toMatch(/nothing here has been tried/i);
  });

  test("and a working claim cannot rest on them", () => {
    expect(supportsWorkingClaim(sessionEvidence(scenario({ checks: null })))).toBe(
      false,
    );
  });
});

describe("checks whose version nobody recorded", () => {
  const unrecorded = (ranAt: number) =>
    scenario({
      checks: { status: "pass", line: "3 passed.", ranAt, revision: null },
    });

  test("say so, rather than inventing which code they ran on", () => {
    const checks = pick(sessionEvidence(unrecorded(NOW)), "executed_check");
    expect(checks.detail).toMatch(/doesn't record which version/i);
    expect(checks.revision).toBeNull();
    // And they are not accused of having run on uncommitted code, which is a
    // confident sentence about something nobody knows.
    expect(checks.staleReason).not.toMatch(/uncommitted/i);
  });

  test("are judged on the clock instead", () => {
    // Ran three hours before this run's code even existed.
    const before = pick(
      sessionEvidence(unrecorded(NOW - 8 * HOUR)),
      "executed_check",
    );
    expect(before.status).toBe("stale");
    expect(before.staleReason).toMatch(/changed after/i);
  });

  test("and a run after the code still counts", () => {
    expect(pick(sessionEvidence(unrecorded(NOW)), "executed_check").status).toBe(
      "pass",
    );
  });
});

describe("folding the checks recorded against one run", () => {
  test("nothing recorded is no evidence at all", () => {
    expect(foldGoalEvidence([])).toBeNull();
  });

  test("the weakest verdict is the one reported", () => {
    expect(weakestVerdict(["verified", "partial", "verified"])).toBe("partial");
    expect(weakestVerdict(["verified", "unknown"])).toBe("unknown");
    expect(weakestVerdict(["partial", "not_wired"])).toBe("not_wired");
    expect(weakestVerdict(["verified", "verified"])).toBe("verified");
  });

  test("a known shortfall outranks a question nobody asked", () => {
    expect(weakestVerdict(["unknown", "partial"])).toBe("partial");
  });

  test("freshness is the oldest check in the set, not the newest", () => {
    const folded = foldGoalEvidence([
      { verdict: "verified", ok: 2, total: 2, at: NOW, commit: "a1b2c3d" },
      { verdict: "verified", ok: 1, total: 1, at: NOW - 6 * HOUR, commit: "a1b2c3d" },
    ]);
    expect(folded?.at).toBe(NOW - 6 * HOUR);
    expect(folded?.ok).toBe(3);
    expect(folded?.total).toBe(3);
    expect(folded?.revision).toBe("a1b2c3d");
  });

  test("checks that disagree about the version claim none", () => {
    const folded = foldGoalEvidence([
      { verdict: "verified", ok: 1, total: 1, at: NOW, commit: "a1b2c3d" },
      { verdict: "verified", ok: 1, total: 1, at: NOW, commit: "9f8e7d6" },
    ]);
    expect(folded?.revision).toBeNull();
  });
});

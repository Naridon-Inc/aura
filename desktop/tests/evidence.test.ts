// What each result is allowed to claim.
//
//   bun test ./tests/evidence.test.ts
//
// AURA-1364. The session wizard draws a signed record, an asked-vs-changed
// match, a goal Aura proved by reading the code, and a commit the same way: a
// word and a tick. Read down the page they compound into "this works", which
// none of them says. These tests hold the three separations the ticket names
// verbatim — a signature is not working software, reading code is not running
// it, and sending a commit is not releasing it — plus the two that keep absence
// honest: a check that predates the code it judges is out of date, and nothing
// at all is never a pass.

import { describe, expect, test } from "bun:test";

import {
  EVIDENCE_ORDER,
  agedStatus,
  impliesWorkingBehaviour,
  meaningOf,
  observerNote,
  overallStatus,
  stalenessOf,
  statusHint,
  statusWord,
  supportsWorkingClaim,
  toneOf,
  type EvidenceKind,
  type EvidenceStatus,
} from "../src/lib/evidence";

describe("what a result establishes", () => {
  test("only a check that ran can speak to working behaviour", () => {
    expect(impliesWorkingBehaviour("executed_check")).toBe(true);
    for (const kind of EVIDENCE_ORDER.filter((k) => k !== "executed_check")) {
      expect(impliesWorkingBehaviour(kind)).toBe(false);
    }
  });

  test("a valid signature never implies the feature works", () => {
    const m = meaningOf("record_integrity");
    expect(m.establishes).toMatch(/altered/i);
    expect(m.doesNotEstablish).toMatch(/works/i);
  });

  test("a structural goal pass never implies a runtime test passed", () => {
    const m = meaningOf("structural_goal");
    // The establishing sentence has to say it read the code, not that the goal
    // is met — "Aura checked it" is exactly the phrasing that reads as a test.
    expect(m.establishes).toMatch(/read the code/i);
    expect(m.doesNotEstablish).toMatch(/did not run it/i);
    expect(m.doesNotEstablish).toMatch(/no test passed/i);
  });

  test("a successful push never implies deployment", () => {
    const m = meaningOf("git_fact");
    expect(m.doesNotEstablish).toMatch(/not releasing/i);
    // And deployment is its own kind, so "no deployment evidence" is a row a
    // reviewer can see rather than a row that silently isn't drawn.
    expect(EVIDENCE_ORDER).toContain("deployment" as EvidenceKind);
  });

  test("every kind says both what it shows and what it doesn't", () => {
    for (const kind of EVIDENCE_ORDER) {
      const m = meaningOf(kind);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.establishes.length).toBeGreaterThan(0);
      expect(m.doesNotEstablish.length).toBeGreaterThan(0);
      expect(m.establishes).not.toBe(m.doesNotEstablish);
    }
  });

  test("evidence is ordered so the page doesn't build to a false crescendo", () => {
    // Anything that can't speak to behaviour reads before the thing that can.
    const ran = EVIDENCE_ORDER.indexOf("executed_check");
    expect(EVIDENCE_ORDER.indexOf("record_integrity")).toBeLessThan(ran);
    expect(EVIDENCE_ORDER.indexOf("structural_goal")).toBeLessThan(ran);
  });
});

describe("who says so", () => {
  test("an agent's own report is marked as a claim, not an observation", () => {
    expect(observerNote("agent")).toMatch(/did not check/i);
    expect(observerNote("aura")).not.toMatch(/did not check/i);
    expect(observerNote("agent")).not.toBe(observerNote("aura"));
  });
});

describe("failed, not run, unsupported, unavailable and stale stay distinct", () => {
  const all: EvidenceStatus[] = [
    "pass",
    "fail",
    "not_run",
    "unsupported",
    "unavailable",
    "stale",
  ];

  test("each has its own word and its own explanation", () => {
    const words = new Set(all.map(statusWord));
    const hints = new Set(all.map(statusHint));
    expect(words.size).toBe(all.length);
    expect(hints.size).toBe(all.length);
  });

  test("lack of evidence never becomes a green pass", () => {
    expect(toneOf("pass")).toBe("good");
    for (const s of ["not_run", "unsupported", "unavailable"] as const) {
      expect(toneOf(s)).toBe("muted");
      expect(statusWord(s)).not.toBe(statusWord("pass"));
    }
    expect(toneOf("fail")).toBe("bad");
    expect(toneOf("stale")).toBe("warn");
  });

  test("missing evidence says so in words, rather than staying silent", () => {
    expect(statusHint("unavailable")).toMatch(/missing is not passing/i);
    expect(statusHint("not_run")).toMatch(/neither passing nor failing/i);
  });
});

describe("a check applies to the code it ran against", () => {
  const HOUR = 3_600_000;
  const now = 1_757_000_000_000;

  test("a verdict from another version is out of date", () => {
    const s = stalenessOf(
      { revision: "aaaaaaa1", at: now },
      { revision: "bbbbbbb2" },
    );
    expect(s.stale).toBe(true);
    expect(s.reason).toMatch(/different version/i);
  });

  test("the same commit written short and long is one version, not two", () => {
    const s = stalenessOf(
      { revision: "a1b2c3d", at: now },
      { revision: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
    );
    expect(s.stale).toBe(false);
  });

  test("code that changed after the check makes it out of date", () => {
    const s = stalenessOf(
      { revision: "a1b2c3d", at: now - HOUR },
      { revision: "a1b2c3d", changedAt: now },
    );
    expect(s.stale).toBe(true);
    expect(s.reason).toMatch(/changed after/i);
  });

  test("a check of uncommitted code doesn't describe the saved version", () => {
    const s = stalenessOf({ revision: null, at: now }, { revision: "a1b2c3d" });
    expect(s.stale).toBe(true);
    expect(s.reason).toMatch(/uncommitted/i);
  });

  test("a check of a saved version doesn't describe code edited since", () => {
    const s = stalenessOf({ revision: "a1b2c3d", at: now }, { revision: null });
    expect(s.stale).toBe(true);
    expect(s.reason).toMatch(/since been edited/i);
  });

  test("a check that never ran is not called out of date", () => {
    // "Out of date" would imply a result exists to have expired. It doesn't.
    const s = stalenessOf({ revision: "a1b2c3d", at: null }, { revision: "zz" });
    expect(s.stale).toBe(false);
    expect(s.reason).toBe("");
  });

  test("the same task still being open does not keep a check current", () => {
    // The rule looks only at the version and the clock. Nothing about the goal,
    // the task or the session it belongs to can make a stale verdict read fresh
    // — which is the exact way an old pass used to survive a code change.
    const openTaskSameGoal = stalenessOf(
      { revision: "old1234", at: now - 5 * HOUR },
      { revision: "new5678", changedAt: now },
    );
    expect(openTaskSameGoal.stale).toBe(true);
  });

  test("a stale pass stops being a pass", () => {
    const s = stalenessOf({ revision: "old1234", at: now }, { revision: "new5678" });
    expect(agedStatus("pass", s)).toBe("stale");
    expect(agedStatus("fail", s)).toBe("stale");
    // Absence has no result to age — it keeps saying what it already said.
    expect(agedStatus("not_run", s)).toBe("not_run");
    expect(agedStatus("unavailable", s)).toBe("unavailable");
  });

  test("a current pass is left alone", () => {
    expect(agedStatus("pass", { stale: false, reason: "" })).toBe("pass");
  });
});

describe("a summary is never greener than what's under it", () => {
  test("one failure outweighs any number of passes", () => {
    expect(overallStatus(["pass", "pass", "fail", "pass"])).toBe("fail");
  });

  test("one out-of-date verdict outweighs the passes around it", () => {
    expect(overallStatus(["pass", "stale", "pass"])).toBe("stale");
  });

  test("everything passing is the only way to pass", () => {
    expect(overallStatus(["pass", "pass"])).toBe("pass");
    expect(overallStatus(["pass", "not_run"])).toBe("not_run");
  });

  test("nothing at all is no evidence, not a clean bill", () => {
    expect(overallStatus([])).toBe("unavailable");
  });

  test("a page of signatures, matches and pushes cannot claim it works", () => {
    expect(
      supportsWorkingClaim([
        { kind: "record_integrity", status: "pass" },
        { kind: "intent_alignment", status: "pass" },
        { kind: "structural_goal", status: "pass" },
        { kind: "git_fact", status: "pass" },
      ]),
    ).toBe(false);
  });

  test("a check that ran and passed can", () => {
    expect(
      supportsWorkingClaim([
        { kind: "structural_goal", status: "pass" },
        { kind: "executed_check", status: "pass" },
      ]),
    ).toBe(true);
  });

  test("a check that ran but is out of date cannot", () => {
    expect(
      supportsWorkingClaim([{ kind: "executed_check", status: "stale" }]),
    ).toBe(false);
  });
});

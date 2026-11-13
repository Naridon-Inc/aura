import { describe, expect, test } from "bun:test";

import type { AheadBehind, PrCheck, PrSummary } from "../../lib/api";
import { isRerunnable } from "../pr/checks/fixChecksPrompt";
import { readyToMerge } from "./ChecksStatus";
import { sortChecks } from "./useBranchChecks";

const check = (name: string, bucket: string, url = ""): PrCheck => ({
  name,
  bucket,
  raw: bucket.toUpperCase(),
  url,
  workflow: "",
  description: "",
  failure_reason: "",
});

const pr = (over: Partial<PrSummary> = {}): PrSummary =>
  ({
    number: 7,
    title: "t",
    state: "OPEN",
    is_draft: false,
    review_decision: "APPROVED",
    checks_failing: 0,
    checks_pending: 0,
    ...over,
  }) as PrSummary;

const level: AheadBehind = { ahead: 0, behind: 0, has_upstream: true, branch: "feat" };

describe("the Checks list", () => {
  test("failing first, then running, then passing, GitHub's order within each", () => {
    const out = sortChecks([
      check("a", "success"),
      check("b", "pending"),
      check("c", "failure"),
      check("d", "success"),
      check("e", "failure"),
    ]);
    expect(out.map((c) => c.name)).toEqual(["c", "e", "b", "a", "d"]);
  });

  test("only an Actions run can be re-run from here", () => {
    expect(isRerunnable(check("ci", "failure", "https://github.com/a/b/actions/runs/12/job/3"))).toBe(true);
    expect(isRerunnable(check("ext", "failure", "https://ci.example.com/build/9"))).toBe(false);
  });
});

describe("Ready to merge", () => {
  test("an open, approved, green PR on a level branch is ready", () => {
    expect(readyToMerge(pr(), level, 0, 0)).toBe(true);
  });

  test("anything still to do holds it back", () => {
    expect(readyToMerge(pr({ is_draft: true }), level, 0, 0)).toBe(false);
    expect(readyToMerge(pr({ checks_failing: 1 }), level, 0, 0)).toBe(false);
    expect(readyToMerge(pr({ checks_pending: 1 }), level, 0, 0)).toBe(false);
    expect(readyToMerge(pr({ review_decision: "CHANGES_REQUESTED" }), level, 0, 0)).toBe(false);
    expect(readyToMerge(pr({ review_decision: "REVIEW_REQUIRED" }), level, 0, 0)).toBe(false);
    expect(readyToMerge(pr({ state: "MERGED" }), level, 0, 0)).toBe(false);
    expect(readyToMerge(pr(), { ...level, ahead: 1 }, 0, 0)).toBe(false);
    expect(readyToMerge(pr(), { ...level, behind: 2 }, 0, 0)).toBe(false);
    expect(readyToMerge(pr(), level, 3, 0)).toBe(false);
    expect(readyToMerge(pr(), level, 0, 1)).toBe(false);
    expect(readyToMerge(pr(), null, 0, 0)).toBe(false);
    expect(readyToMerge(null, level, 0, 0)).toBe(false);
  });
});

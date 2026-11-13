// What these pin: the Checks tab's facts about its workspace's pull request.
// The run list beats GitHub's roll-up once it is read, the reviewers line
// waits for the detail rather than saying "nobody", and Merge is only called
// ready when the branch here agrees, not on GitHub's word alone.

import { describe, expect, test } from "bun:test";

import type { PrCheck, PrDetail, PrStackNode, PrSummary } from "../../lib/api";
import { checksTally, mergeLine, reviewersLine, stackLine } from "./checksPrModel";

const SUMMARY = {
  checks_state: "success",
  checks_total: 4,
  checks_passing: 4,
  checks_failing: 0,
  checks_pending: 0,
} as PrSummary;

const run = (name: string, bucket: string): PrCheck => ({
  name,
  bucket,
  raw: bucket,
  url: "",
  workflow: "",
  description: "",
  failure_reason: "",
}) as PrCheck;

const DETAIL = (over: Partial<PrDetail> = {}): PrDetail =>
  ({
    number: 103,
    state: "OPEN",
    author: "dana",
    head_ref: "feat/stack-api",
    base_ref: "main",
    is_draft: false,
    mergeable: "MERGEABLE",
    review_decision: null,
    url: "https://example.com/pull/103",
    reviewers: [],
    ...over,
  }) as PrDetail;

describe("checksTally", () => {
  test("GitHub's roll-up until the runs are read", () => {
    expect(checksTally(SUMMARY, null)).toEqual({
      state: "success",
      passing: 4,
      failing: 0,
      pending: 0,
      total: 4,
    });
  });

  test("the read runs win once they are in", () => {
    const t = checksTally(SUMMARY, [run("build", "success"), run("e2e", "failure"), run("lint", "queued")]);
    expect(t).toEqual({ state: "failure", passing: 1, failing: 1, pending: 1, total: 3 });
    expect(checksTally(SUMMARY, []).state).toBeNull();
  });
});

describe("reviewersLine", () => {
  test("waits for the detail, then names reviewers or says there are none", () => {
    expect(reviewersLine(null)).toBeNull();
    expect(reviewersLine(DETAIL())).toBe("No reviewers");
    expect(
      reviewersLine(
        DETAIL({
          reviewers: [
            { login: "riya", state: "COMMENTED" },
            { login: "lee", state: "PENDING" },
          ],
        }),
      ),
    ).toBe("riya (commented), lee");
  });
});

describe("mergeLine", () => {
  const green = checksTally(SUMMARY, null);

  test("ready only when this branch agrees", () => {
    expect(mergeLine(DETAIL(), green, [], true)).toBe("Ready to merge");
    expect(mergeLine(DETAIL(), green, [], false)).toBe("Ready once the branch is in step");
  });

  test("loading until the detail is read, then what is in the way", () => {
    expect(mergeLine(null, green, [], false)).toBe("Loading status…");
    const red = checksTally(SUMMARY, [run("e2e", "failure")]);
    expect(mergeLine(DETAIL(), red, [], false)).toBe("Checks failed");
    expect(mergeLine(DETAIL({ is_draft: true }), green, [], false)).toBe("Draft PR open");
  });
});

describe("stackLine", () => {
  const node = (number: number, parent: number | null, children: number[] = []): PrStackNode => ({
    number,
    title: `#${number}`,
    head_ref: `b${number}`,
    base_ref: parent ? `b${parent}` : "main",
    author: "",
    state: "OPEN",
    is_draft: false,
    aura_risk_score: null,
    url: "",
    children,
    parent,
    gt_managed: false,
  }) as PrStackNode;

  test("a pull request built on another says which", () => {
    expect(stackLine([node(98, null, [99]), node(99, 98)], 99)).toBe("On #98");
  });

  test("the one underneath says what builds on it", () => {
    expect(stackLine([node(98, null, [99]), node(99, 98)], 98)).toBe("#99 builds on this");
    expect(stackLine([node(98, null, [99, 100]), node(99, 98), node(100, 98)], 98)).toBe(
      "2 pull requests build on this",
    );
  });

  test("a pull request on its own, or not in the list, has no stack row", () => {
    expect(stackLine([node(98, null)], 98)).toBeNull();
    expect(stackLine([node(98, null, [99]), node(99, 98)], 7)).toBeNull();
  });
});

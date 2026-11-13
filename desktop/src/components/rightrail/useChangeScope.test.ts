// The commit rows a machine's Changes dropdown offers come from its whole
// graph; only the line HEAD stands on is a scope this checkout can diff.

import { describe, expect, test } from "bun:test";

import type { GraphCommit } from "../../lib/api";
import { headLine } from "./useChangeScope";

function c(sha: string, parents: string[], head = false): GraphCommit {
  return {
    sha,
    short: sha.slice(0, 7),
    parents,
    author: "Ada",
    author_email: "ada@example.net",
    timestamp: 1_700_000_000,
    subject: `commit ${sha}`,
    refs: head ? [{ name: "HEAD", kind: "head" }] : [],
  } as GraphCommit;
}

describe("headLine", () => {
  test("walks first parents from HEAD, skipping other branches", () => {
    const graph = [c("other", ["b"]), c("head", ["b", "side"], true), c("side", ["a"]), c("b", ["a"]), c("a", [])];
    expect(headLine(graph, 10).map((e) => e.sha)).toEqual(["head", "b", "a"]);
  });

  test("stops at the limit", () => {
    const graph = [c("head", ["b"], true), c("b", ["a"]), c("a", [])];
    expect(headLine(graph, 2).map((e) => e.sha)).toEqual(["head", "b"]);
  });

  test("an empty graph has no rows", () => {
    expect(headLine([], 5)).toEqual([]);
  });
});

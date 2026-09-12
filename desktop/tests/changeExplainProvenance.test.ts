// Whose account of a change the reviewer is reading, and whether it is still
// about the change in front of them.
//
//   bun test ./tests/changeExplainProvenance.test.ts
//
// AURA-1361. Three separate ways the before/after account could mislead:
//
//   1. It described a diff that no longer existed. The held entry was keyed by
//      (repo, file, commit), and a working-tree edit has no commit — so the
//      FIRST account of a file was pinned and served for every later edit of
//      it. Edit, revisit, and you read a description of code you had changed.
//
//   2. A failed request looked exactly like "nothing to describe". Both
//      resolved to the same empty value with `source: "none"`, so a change Aura
//      had merely failed to read was presented as a change with nothing to say
//      about it, with no way to ask again.
//
//   3. Every reason read as Aura's. `aura snapshot-file --why` records the
//      author's own words against a file — 196 of them in this repo's log —
//      and nothing distinguished a quote from a reading.

import { describe, expect, test } from "bun:test";

import {
  EMPTY_EXPLANATION,
  FAILED_EXPLANATION,
  explanationFailed,
  hasExplanation,
  isInferredFromDiff,
  whyIsRecorded,
  type ChangeExplanation,
} from "../src/lib/changeExplain";

function explanation(over: Partial<ChangeExplanation> = {}): ChangeExplanation {
  return {
    before: "Every retry waited the same flat half-second.",
    what: "Retries now wait a delay that doubles each attempt.",
    why: "so we stop tripping the rate limit",
    why_source: "model",
    source: "model",
    diff_hash: "abc123",
    ...over,
  };
}

describe("a failure is not an absence", () => {
  test("the two results are distinguishable", () => {
    expect(explanationFailed(FAILED_EXPLANATION)).toBe(true);
    expect(explanationFailed(EMPTY_EXPLANATION)).toBe(false);
    expect(explanationFailed(explanation())).toBe(false);
    expect(explanationFailed(null)).toBe(false);
  });

  test("neither carries words, which is why they were once confused", () => {
    // Both are wordless. That is exactly why `hasExplanation` alone could not
    // tell them apart, and why the surface needs `explanationFailed` too.
    expect(hasExplanation(FAILED_EXPLANATION)).toBe(false);
    expect(hasExplanation(EMPTY_EXPLANATION)).toBe(false);
    expect(hasExplanation(explanation())).toBe(true);
  });

  test("a loading state is neither", () => {
    // `null` is "the request is still out". A surface that treats it as failure
    // flashes an error on every open.
    expect(explanationFailed(null)).toBe(false);
    expect(hasExplanation(null)).toBe(false);
  });
});

describe("whose account this is", () => {
  test("a reason the author wrote down is a quote", () => {
    const e = explanation({
      why: "require Apple's status: Accepted verdict before stapling",
      why_source: "recorded",
      why_author: "ashiqwayanad007",
      why_stated_at: 1_788_000_000,
    });
    expect(whyIsRecorded(e)).toBe(true);
    expect(isInferredFromDiff(e)).toBe(false);
  });

  test("a model reading the diff is not", () => {
    expect(whyIsRecorded(explanation())).toBe(false);
    expect(whyIsRecorded(explanation({ why_source: "cache" }))).toBe(false);
    expect(whyIsRecorded(explanation({ why_source: "fallback" }))).toBe(false);
  });

  test("a recorded marker with no words behind it claims nothing", () => {
    // Presenting an empty quote as "stated by …" would attribute a sentence
    // nobody wrote.
    expect(whyIsRecorded(explanation({ why: "   ", why_source: "recorded" }))).toBe(false);
  });

  test("words mined from the diff with no model reachable say so", () => {
    const e = explanation({ source: "fallback", why_source: "fallback" });
    expect(isInferredFromDiff(e)).toBe(true);
    expect(isInferredFromDiff(explanation())).toBe(false);
  });

  test("an older backend that sends no provenance claims none", () => {
    // `why_source` is optional on the wire. Absent must read as "not recorded",
    // never as recorded — the failure has to be in the safe direction.
    const { why_source: _dropped, ...legacy } = explanation();
    expect(whyIsRecorded(legacy as ChangeExplanation)).toBe(false);
  });
});

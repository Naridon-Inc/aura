import { describe, expect, test } from "bun:test";

import { forkPrLocalBranch, prStartPoint, prStartSelection, sanitizeBranchName } from "./prStartPoint";

describe("prStartPoint", () => {
  test("a same-repo PR starts from its head branch as before", () => {
    expect(
      prStartPoint({ number: 41, head_ref: "feat/login", is_cross_repository: false }),
    ).toBe("feat/login");
  });

  test("a fork PR starts from pull/<n>/head fetched into pr-<n>-<headref>", () => {
    expect(
      prStartPoint({ number: 41, head_ref: "feat/login", is_cross_repository: true }),
    ).toBe("pull/41/head:pr-41-feat/login");
  });
});

describe("forkPrLocalBranch", () => {
  test("keeps a plain head ref and prefixes the PR number", () => {
    expect(
      forkPrLocalBranch({ number: 7, head_ref: "fix-typo", is_cross_repository: true }),
    ).toBe("pr-7-fix-typo");
  });

  test("a head ref that sanitizes to nothing falls back to pr-<n>", () => {
    expect(
      forkPrLocalBranch({ number: 7, head_ref: "///", is_cross_repository: true }),
    ).toBe("pr-7");
  });
});

describe("sanitizeBranchName", () => {
  test("replaces unsafe characters and trims separators", () => {
    expect(sanitizeBranchName("  weird name~^:?*[ ")).toBe("weird-name");
    expect(sanitizeBranchName("a..b//c/")).toBe("a.b/c");
    expect(sanitizeBranchName("-lead")).toBe("lead");
  });
});

describe("prStartSelection", () => {
  const pr = {
    number: 41,
    title: "Retry with backoff",
    head_ref: "feat/login",
    base_ref: "main",
    is_cross_repository: false,
  };

  test("a pull request from this repo continues on its own branch", () => {
    expect(prStartSelection(pr)).toEqual({
      kind: "pr",
      ref: "feat/login",
      label: "#41 Retry with backoff",
      continues: { branch: "feat/login", base: "main" },
    });
  });

  test("a fork's pull request starts a branch of its own, as before", () => {
    const picked = prStartSelection({ ...pr, is_cross_repository: true });
    expect(picked.ref).toBe("pull/41/head:pr-41-feat/login");
    expect(picked.continues).toBeUndefined();
  });

  test("a missing base still continues, merging into nothing named", () => {
    expect(prStartSelection({ ...pr, base_ref: "" }).continues).toEqual({
      branch: "feat/login",
      base: null,
    });
  });
});

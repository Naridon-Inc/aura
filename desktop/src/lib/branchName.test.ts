// Run with: bun test src/lib/branchName.test.ts

import { describe, expect, test } from "bun:test";
import { looksLikeBranchName } from "./branchName";

describe("a branch named in an answer", () => {
  test("a work-type prefix makes it a branch", () => {
    for (const b of ["feat/cloud-parity", "fix/toast-gap", "release/0.20.1-integration", "chore/deps", "hotfix/v2/login"]) {
      expect(looksLikeBranchName(b)).toBe(true);
    }
  });

  test("a remote in front, or a full ref, makes it a branch", () => {
    for (const b of ["origin/main", "upstream/feat/x", "refs/heads/main", "refs/remotes/origin/main"]) {
      expect(looksLikeBranchName(b)).toBe(true);
    }
  });
});

describe("what stays a path", () => {
  test("ordinary folders", () => {
    for (const p of ["src/components", "aura-shell/src/lib", "docs/guide", "test/fixtures", "build/out"]) {
      expect(looksLikeBranchName(p)).toBe(false);
    }
  });

  test("anything git would refuse as a branch name", () => {
    for (const p of ["feat/", "feat//x", "feat/.hidden", "feat/a..b", "feat/x.lock", "feat/a b", "main"]) {
      expect(looksLikeBranchName(p)).toBe(false);
    }
  });
});

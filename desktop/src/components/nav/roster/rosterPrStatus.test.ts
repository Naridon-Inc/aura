import { describe, expect, test } from "bun:test";

import { prNumberTitle, prWorkspaceStatus } from "./rosterPrStatus";

const open = { number: 7, state: "OPEN" };

describe("prWorkspaceStatus", () => {
  test("no pull request is no PR mark", () => {
    expect(prWorkspaceStatus(undefined)).toBeNull();
  });

  test("merged and closed read from the state, whatever the checks say", () => {
    expect(prWorkspaceStatus({ number: 1, state: "MERGED", checks: "failure" })).toBe("merged");
    expect(prWorkspaceStatus({ number: 1, state: "CLOSED", draft: true })).toBe("closed-pr");
  });

  test("an open PR: failing checks, then draft, then running checks, then open", () => {
    expect(prWorkspaceStatus({ ...open, checks: "failure", draft: true })).toBe("checks-failing");
    expect(prWorkspaceStatus({ ...open, draft: true, checks: "pending" })).toBe("draft-pr");
    expect(prWorkspaceStatus({ ...open, checks: "pending" })).toBe("checks-pending");
    expect(prWorkspaceStatus({ ...open, checks: "success" })).toBe("open-pr");
    expect(prWorkspaceStatus({ ...open, checks: null })).toBe("open-pr");
  });

  test("an unknown state draws no PR mark rather than guessing", () => {
    expect(prWorkspaceStatus({ number: 3, state: "LOCKED" })).toBeNull();
  });
});

describe("prNumberTitle", () => {
  test("names the number and where it stands", () => {
    expect(prNumberTitle({ ...open, checks: "failure" })).toBe("#7 · Checks failing");
    expect(prNumberTitle({ number: 9, state: "CLOSED" })).toBe("#9 · Closed without merging");
  });
});

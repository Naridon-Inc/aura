import { describe, expect, test } from "bun:test";

import { chatTabMarkKind } from "./chatTabMark";

// The mark an Aura chat's tab wears follows what it is called: waiting until it
// has a subject, the pull-request mark for a review, Aura's own otherwise.

describe("an Aura chat's mark", () => {
  test("waits while the chat has no subject", () => {
    for (const label of ["New chat", "Aura", "Conversation", "Manager", "chat", "  "]) {
      expect(chatTabMarkKind(label)).toBe("pending");
    }
  });

  test("is the review mark once the subject is a review", () => {
    for (const label of [
      "Review the billing webhook PR",
      "Reviewing the cloud sign-in changes",
      "PR #93 feedback",
      "Address pull request comments",
    ]) {
      expect(chatTabMarkKind(label)).toBe("review");
    }
  });

  test("is Aura's own for any other subject", () => {
    for (const label of ["Fix the login redirect", "Preview the landing page", "Prune old branches"]) {
      expect(chatTabMarkKind(label)).toBe("named");
    }
  });
});

import { describe, expect, test } from "bun:test";

import { buildSelfKeys, isSelfSender } from "./identity";

// A signed-in Aura account IS the identity. Before this, "me" was anchored only
// on the GitHub login (`gh api user`); a user signed into Aura but without `gh`
// set up had their handle treated as WEAK (an email-prefix a colleague could
// share), so their own messages could file as a stranger's. The account, being
// a deliberate cross-machine claim, is now a strong anchor in its own right.

describe("the Aura account as an identity source", () => {
  test("a signed-in account is a strong 'me' key", () => {
    const keys = buildSelfKeys({ auraAccount: "mhask" });
    expect(keys.strong.has("mhask")).toBe(true);
  });

  test("with only the account (no gh anchor), the handle is STRONG not weak", () => {
    const keys = buildSelfKeys({ auraAccount: "mhask", handle: "mhask" });
    // Strong → recognised as us even from an install we can't device-match.
    expect(isSelfSender("mhask", keys)).toBe(true);
    expect(keys.weak.has("mhask")).toBe(false);
  });

  test("signed out (no account, no gh), the email-prefix handle stays weak", () => {
    // A colleague on a shared git email must not be absorbed, so with no anchor
    // the handle is device-confirmed (weak), not automatically us.
    const keys = buildSelfKeys({ handle: "ashiqwayanad007" });
    expect(keys.weak.has("ashiqwayanad007")).toBe(true);
    expect(keys.strong.has("ashiqwayanad007")).toBe(false);
  });

  test("a blank account is not an anchor", () => {
    const keys = buildSelfKeys({ auraAccount: "  ", handle: "x" });
    expect(keys.strong.has("x")).toBe(false);
  });
});

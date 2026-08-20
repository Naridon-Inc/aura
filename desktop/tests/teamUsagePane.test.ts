// Settings → Organization → Team → Usage, driven in a real window.
//
//   bun test
//
// The pane read:
//
//     Token spend
//     ┌────────────────────────────────────────────────┐
//     │ Couldn't load token usage: no cloud_api_token  │   ← amber, alarming
//     └────────────────────────────────────────────────┘
//     Sign in to the cloud (Onboarding → Cloud) to see per-member spend.
//
// Three things wrong in four lines. Not being signed in is this pane's one
// precondition, not a failure, and it was drawn as the app's failure colour.
// What it named was `cloud_api_token` — a key in a JSON file on this disk,
// shown to someone whose actual situation is "I haven't signed in yet". And
// the fix was prose naming a menu path rather than a button, in an app where
// signing in is one dispatch away and every other surface offers it.
//
// Underneath, the pane inferred signed-out from a failed request. Cost &
// usage had already been through this exact bug and fixed it by asking
// `cloud_auth_status`, which reads the same credential the billing call
// reads — so "you are not signed in" is knowable rather than guessed, and a
// timeout on a signed-in machine no longer tells you to sign in.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const TEAM = "components/settings/TeamTab.tsx";

/** The pane, comments stripped — the note above says the words it removed. */
async function pane(): Promise<string> {
  const src = await readSrc(TEAM);
  return src.slice(
    src.indexOf("function TeamUsagePane("),
    src.indexOf("function relAge("),
  );
}

describe("team usage — signed out is a state, not an error", () => {
  test("the raw failure is no longer the headline", async () => {
    const p = await pane();
    expect(p).not.toContain("Couldn't load token usage");
    // A menu path a reader has to walk themselves, in place of the button.
    expect(p).not.toContain("Onboarding");
  });

  test("whether you're signed in is asked, not inferred", async () => {
    const p = await pane();
    expect(p).toContain("api\n      .cloudAuthStatus()");
    expect(p).toContain("setSignedIn(st?.connected === true)");
    // The check failing is its own answer, and not the same as "no".
    expect(p).toContain("setSignedIn(null)");
  });

  test("signed out gets an empty state with a working button", async () => {
    const p = await pane();
    expect(p).toContain("if (error && signedIn === false)");
    expect(p).toContain("Sign in to see what your team is spending");
    expect(p).toContain('new CustomEvent("aura:open-signin")');
  });

  test("a real failure keeps the detail, under a sentence", async () => {
    const p = await pane();
    expect(p).toContain("<ErrorState");
    expect(p).toContain("Couldn’t load token spend");
    // Signed in, so this is not something the reader has to go and set up.
    expect(p).toContain("signedIn === null");
    expect(p).toContain("onRetry={retry}");
  });

  test("Try again asks the network, not the minute-old cache", async () => {
    const p = await pane();
    // The spend read is shared with Overview and Cost & usage and held for
    // 60s; retrying into it would replay the same answer.
    expect(p).toContain("invalidateBillingUsage()");
    expect(p).toContain("setAttempt((n) => n + 1)");
    expect(p).toContain("}, [attempt]);");
  });

  test("and loading uses the one loader the app has", async () => {
    const p = await pane();
    expect(p).toContain("<LoadingState label=");
    expect(p).not.toContain("Loading token usage…");
  });
});

// Run with: bun test src/components/cloudplace/CloudAgentSignIn.test.tsx
//
// A running sign-in shows one line and at most one thing to do: open the
// sign-in page, enter a one-time code, or paste the code a sign-in page hands
// back. These pin that markup for each step.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SignInStatus } from "../../lib/cloudAgentSignIn";
import { SignInProgress } from "./CloudAgentSignIn";

const at = (phase: SignInStatus["phase"], more: Partial<SignInStatus> = {}): SignInStatus => ({
  phase,
  url: null,
  code: null,
  codePrompt: null,
  account: null,
  error: null,
  missingCli: false,
  ...more,
});

const draw = (s: SignInStatus) =>
  renderToStaticMarkup(<SignInProgress status={s} onCancel={() => undefined} onCode={async () => null} />);

describe("a running sign-in", () => {
  test("waiting on the browser: a spinner, the line, Cancel, and the page if it didn't open", () => {
    const html = draw(at("browser", { url: "https://claude.ai/oauth/authorize?x=1" }));
    expect(html).toContain("ui-activity-loader");
    expect(html).toContain("Finish signing in in your browser…");
    expect(html).toContain(">Cancel<");
    expect(html).toContain("Open the sign-in page");
    expect(html).not.toContain("Paste");
  });

  test("a sign-in page that can't hand the code back asks for it", () => {
    expect(draw(at("browser", { codePrompt: "required" }))).toContain("Paste the code the sign-in page shows you");
    expect(draw(at("browser", { codePrompt: "optional" }))).toContain("Did the sign-in page show a code?");
  });

  test("a device sign-in shows the code to enter and where", () => {
    const html = draw(at("device_code", { code: "ABCD-12EFG", url: "https://auth.openai.com/codex/device" }));
    expect(html).toContain("Enter this code on the sign-in page");
    expect(html).toContain(">ABCD-12EFG<");
    expect(html).toContain("Copy code");
    // One click copies the code and opens the page it goes on.
    expect(html).toContain("Copy code and open sign-in");
    expect(html).toContain("15 minutes");
  });

  test("saving can't be cancelled halfway", () => {
    const html = draw(at("saving"));
    expect(html).toContain("Saving your sign-in…");
    expect(html).not.toContain(">Cancel<");
  });

  test("once connected it stops spinning and names the account", () => {
    const html = draw(at("connected", { account: "sam@example.com · Plus" }));
    expect(html).toContain("Connected as sam@example.com · Plus");
    expect(html).not.toContain("ui-activity-loader");
    expect(html).not.toContain(">Cancel<");
  });
});

describe("a sign-in run on the org's computer, from the web", () => {
  const remote = (phase: SignInStatus["phase"], more: Partial<SignInStatus> = {}) =>
    at(phase, { computer: "Aura computer", ...more });

  test("says which computer it is starting on", () => {
    expect(draw(remote("starting"))).toContain("Starting the sign-in on Aura computer…");
  });

  test("the Claude page is the first thing to open, and the code it shows comes back here", () => {
    const html = draw(remote("browser", { url: "https://claude.ai/oauth/authorize?x=1", codePrompt: "required" }));
    expect(html).toContain("Open Claude sign-in");
    expect(html).not.toContain("Browser didn");
    expect(html).toContain("Paste the code Claude shows you");
    expect(html).toContain(">Cancel<");
  });

  test("once the code is in, only the wait is left", () => {
    const html = draw(remote("browser", { url: "https://claude.ai/oauth/authorize?x=1" }));
    expect(html).toContain("Open Claude sign-in");
    expect(html).not.toContain("Paste");
  });

  test("Codex's one-time code reads the same as in the app", () => {
    const html = draw(remote("device_code", { code: "ABCD-12EFG", url: "https://auth.openai.com/codex/device" }));
    expect(html).toContain(">ABCD-12EFG<");
    expect(html).not.toContain("Open Claude sign-in");
  });
});

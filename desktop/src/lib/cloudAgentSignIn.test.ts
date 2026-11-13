import { describe, expect, test } from "bun:test";

import { canSignIn, pastedCode, signInLine, signInRunning, type SignInStatus } from "./cloudAgentSignIn";

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

describe("canSignIn", () => {
  test("Claude Code and Codex sign in from here; Cursor takes a key", () => {
    expect(canSignIn("claude")).toBe(true);
    expect(canSignIn("codex")).toBe(true);
    expect(canSignIn("cursor")).toBe(false);
  });
});

describe("signInRunning", () => {
  test("a sign-in is going until it connects, fails or is stopped", () => {
    for (const p of ["starting", "browser", "device_code", "saving"] as const) expect(signInRunning(p)).toBe(true);
    for (const p of ["connected", "failed", "cancelled"] as const) expect(signInRunning(p)).toBe(false);
  });
});

describe("signInLine", () => {
  test("says what the member does next, in words", () => {
    expect(signInLine(at("browser"))).toBe("Finish signing in in your browser…");
    expect(signInLine(at("device_code", { code: "ABCD-12EFG" }))).toBe("Enter this code on the sign-in page");
  });

  test("a sign-in on the org's computer says so", () => {
    expect(signInLine(at("starting", { computer: "Aura computer" }))).toBe("Starting the sign-in on Aura computer…");
    expect(signInLine(at("browser", { computer: "Aura computer" }))).toBe(
      "Sign in on the Claude page, then paste the code it shows you.",
    );
    expect(signInLine(at("starting"))).toBe("Opening the sign-in page…");
  });

  test("a connected sign-in names its account when it has one", () => {
    expect(signInLine(at("connected", { account: "sam@example.com · Plus" }))).toBe(
      "Connected as sam@example.com · Plus",
    );
    expect(signInLine(at("connected"))).toBe("Connected");
  });

  test("a failure says why, or at least that it didn't finish", () => {
    expect(signInLine(at("failed", { error: "Claude Code isn't installed on this computer." }))).toBe(
      "Claude Code isn't installed on this computer.",
    );
    expect(signInLine(at("failed"))).toContain("didn’t finish");
  });
});

describe("pastedCode", () => {
  test("a pasted code is trimmed to its one word", () => {
    expect(pastedCode("  abc123#state \n")).toBe("abc123#state");
  });

  test("nothing, or more than one word, sends nothing", () => {
    expect(pastedCode("   ")).toBeNull();
    expect(pastedCode("two words")).toBeNull();
  });
});

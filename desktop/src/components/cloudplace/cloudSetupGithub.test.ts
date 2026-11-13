import { describe, expect, test } from "bun:test";

import type { ConnectCandidate, ConnectStart } from "../../lib/cloudGithub";
import { githubButton } from "./cloudSetupGithub";

const start: ConnectStart = { ticket: "t", install_url: "i", authorize_url: "a" };
const cand = (over: Partial<ConnectCandidate>): ConnectCandidate => ({
  id: 1,
  account_login: "acme",
  can_connect: true,
  connected_here: false,
  connected_elsewhere: false,
  ...over,
});

describe("the setup step's Connect GitHub button", () => {
  test("follows the trip through GitHub", () => {
    expect(githubButton({ at: "idle" }, false)).toMatchObject({ label: "Connect GitHub", act: "begin" });
    expect(githubButton({ at: "starting" }, false).act).toBeNull();
    expect(githubButton({ at: "installing", start }, false)).toMatchObject({ act: "continue" });
    expect(githubButton({ at: "signing_in", start }, false)).toMatchObject({ act: "again" });
  });

  test("one account: nothing to press while it connects itself", () => {
    const b = githubButton({ at: "answered", start, ticket: { status: "answered", candidates: [cand({})] } }, false);
    expect(b).toMatchObject({ label: "Connecting…", act: null });
  });

  test("several accounts go to Settings to pick; none says why", () => {
    const many = { status: "answered" as const, candidates: [cand({ id: 1 }), cand({ id: 2 })] };
    expect(githubButton({ at: "answered", start, ticket: many }, false).act).toBe("choose");
    const none = { status: "answered" as const, candidates: [] };
    expect(githubButton({ at: "answered", start, ticket: none }, false)).toMatchObject({ act: "begin" });
    expect(githubButton({ at: "answered", start, ticket: none }, false).note).toContain("didn’t list");
  });

  test("ran out or refused: start again, with GitHub's reason", () => {
    const expired = { status: "expired" as const, candidates: [] };
    expect(githubButton({ at: "answered", start, ticket: expired }, false).note).toContain("too long");
    const refused = { status: "refused" as const, problem: "Denied on GitHub.", candidates: [] };
    expect(githubButton({ at: "answered", start, ticket: refused }, false)).toMatchObject({
      act: "begin",
      note: "Denied on GitHub.",
    });
  });
});

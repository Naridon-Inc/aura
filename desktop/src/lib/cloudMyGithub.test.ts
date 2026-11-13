import { describe, expect, it } from "bun:test";
import {
  githubBlock,
  isGithubName,
  isMyGithubReason,
  myGithubLine,
  myGithubProblem,
  myGithubRefusal,
  myTicketProblem,
  myTicketSettled,
  reachableRepos,
  startableRepos,
  type MyGithubRepos,
} from "./cloudMyGithub";

const NAMES = ["uniskool/web", "uniskool/api", "local/notes", "someone/else"];

const mine = (over: Partial<MyGithubRepos>): MyGithubRepos => ({
  connected: true,
  login: "mo",
  repos: [
    { full_name: "Uniskool/Web", push: true },
    { full_name: "uniskool/api", push: false },
  ],
  ...over,
});

describe("the Your GitHub row", () => {
  it("says who is connected, or what connecting is for", () => {
    expect(myGithubLine({ connected: true, login: "mo", linked_at: null })).toBe("Connected as @mo");
    expect(myGithubLine({ connected: true, login: null, linked_at: null })).toBe("Connected");
    expect(myGithubLine({ connected: false, login: null, linked_at: null })).toContain("Not connected");
    expect(myGithubLine(null)).toContain("Not connected");
  });

  it("waits until GitHub has answered the ticket", () => {
    expect(myTicketSettled("waiting")).toBe(false);
    expect(myTicketSettled("connected")).toBe(true);
    expect(myTicketSettled("refused")).toBe(true);
    expect(myTicketSettled("expired")).toBe(true);
  });

  it("says why a settled ticket didn't connect", () => {
    expect(myTicketProblem({ status: "connected", login: "mo" })).toBeNull();
    expect(myTicketProblem({ status: "expired" })).toContain("too long");
    expect(myTicketProblem({ status: "refused", problem: "You declined on GitHub." })).toBe("You declined on GitHub.");
    expect(myTicketProblem({ status: "refused", problem: " " })).toContain("Connect again");
  });
});

describe("which repositories a member can start on", () => {
  it("tells GitHub names from names that live only in Aura", () => {
    expect(isGithubName("uniskool/web")).toBe(true);
    expect(isGithubName("local/notes")).toBe(false);
    expect(isGithubName("LOCAL/notes")).toBe(false);
    expect(isGithubName("just-a-name")).toBe(false);
    expect(isGithubName("a/b/c")).toBe(false);
    expect(isGithubName("../web")).toBe(false);
  });

  it("keeps what the member's GitHub opens, whatever its case", () => {
    const r = reachableRepos(NAMES, mine({}));
    expect(r.names).toEqual(["uniskool/web", "uniskool/api", "local/notes"]);
    expect(r.hidden).toBe(1);
  });

  it("keeps only Aura-only names when nothing is connected", () => {
    const r = reachableRepos(NAMES, mine({ connected: false, login: null, repos: null }));
    expect(r.names).toEqual(["local/notes"]);
    expect(r.hidden).toBe(3);
  });

  it("leaves the server to decide when the list isn't known", () => {
    expect(reachableRepos(NAMES, null)).toEqual({ names: NAMES, hidden: 0 });
    expect(reachableRepos(NAMES, mine({ repos: null }))).toEqual({ names: NAMES, hidden: 0 });
  });

  it("blocks the dialog only when GitHub leaves nothing to start on", () => {
    const github = ["uniskool/web"];
    const off = mine({ connected: false, login: null, repos: null });
    expect(githubBlock(off, reachableRepos(github, off))).toContain("Connect it");
    const none = mine({ repos: [] });
    expect(githubBlock(none, reachableRepos(github, none))).toContain("@mo can’t open any");
    expect(githubBlock(off, reachableRepos(NAMES, off))).toBeNull();
    expect(githubBlock(null, reachableRepos(github, null))).toBeNull();
    expect(githubBlock(mine({}), reachableRepos(github, mine({})))).toBeNull();
  });
});

describe("refusals the member can fix", () => {
  it("knows its reasons and nothing else", () => {
    expect(isMyGithubReason("github_not_connected")).toBe(true);
    expect(isMyGithubReason("github_cannot_open")).toBe(true);
    expect(isMyGithubReason("no_github_push_access")).toBe(true);
    expect(isMyGithubReason("no_github_app")).toBe(false);
    expect(isMyGithubReason(null)).toBe(false);
  });

  it("says the server's sentence, else a plain one that points at Your GitHub", () => {
    expect(myGithubRefusal("github_cannot_open", "Your GitHub account @mo can’t open a/b.")).toBe(
      "Your GitHub account @mo can’t open a/b.",
    );
    expect(myGithubRefusal("github_not_connected", null)).toContain("Settings → Git → Your GitHub");
  });

  it("reads one out of a failed call's text", () => {
    const raw =
      'HTTP 409 Conflict: {"error":"Cloud workspaces push and open pull requests as you, so connect your GitHub first.","reason":"github_not_connected"}';
    expect(myGithubProblem(raw)).toEqual({
      reason: "github_not_connected",
      message: "Cloud workspaces push and open pull requests as you, so connect your GitHub first.",
    });
    expect(myGithubProblem('HTTP 403 Forbidden: {"error":"no","reason":"forbidden"}')).toBeNull();
    expect(myGithubProblem("HTTP 502 Bad Gateway: upstream")).toBeNull();
    expect(myGithubProblem("HTTP 409: {not json}")).toBeNull();
  });
});

describe("which repositories a workspace starts on", () => {
  it("gives the Aura computer only what it can clone from GitHub", () => {
    expect(startableRepos(NAMES, true)).toEqual({
      names: ["uniskool/web", "uniskool/api", "someone/else"],
      offGithub: 1,
    });
  });

  it("leaves every one for a computer that already holds the project", () => {
    expect(startableRepos(NAMES, false)).toEqual({ names: NAMES, offGithub: 0 });
  });
});

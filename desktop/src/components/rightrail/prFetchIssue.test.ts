import { describe, expect, test } from "bun:test";

import { originText } from "../../lib/originUrl";
import { originToHttpBase } from "../../lib/worktreeActions";
import { prFetchIssue, remoteHostAndRepo } from "./prFetchIssue";

const GH = "git@github.com:acme/app.git";
const read = (reason: string | null, over: Partial<Parameters<typeof prFetchIssue>[0]> = {}) =>
  prFetchIssue({ reason, showingPr: false, origin: GH, online: true, ...over });

describe("remoteHostAndRepo", () => {
  test("reads ssh, scp-style and https remotes", () => {
    expect(remoteHostAndRepo("git@github.com:acme/app.git")).toEqual({ host: "github.com", repo: "acme/app" });
    expect(remoteHostAndRepo("ssh://git@gitlab.com/acme/app.git")).toEqual({ host: "gitlab.com", repo: "acme/app" });
    expect(remoteHostAndRepo("https://github.com/acme/app")).toEqual({ host: "github.com", repo: "acme/app" });
    expect(remoteHostAndRepo("")).toBeNull();
  });

  test("an origin that isn't text reads as no remote instead of throwing", () => {
    for (const bad of [null, undefined, 42, {}, ["git@github.com:acme/app.git"]]) {
      expect(remoteHostAndRepo(bad)).toBeNull();
      expect(originToHttpBase(bad)).toBe("");
      expect(originText(bad)).toBe("");
    }
    expect(originText("  git@github.com:acme/app.git\n")).toBe("git@github.com:acme/app.git");
  });
});

describe("prFetchIssue", () => {
  test("a read that landed has no issue", () => {
    expect(read(null)).toBeNull();
  });

  test("a repo with no remote expects no pull request", () => {
    expect(read("no git remotes found", { origin: "" })).toBeNull();
  });

  test("offline names itself, before and after a pull request is on screen", () => {
    const first = read(null, { online: false });
    expect(first).toMatchObject({ kind: "offline", title: "No internet connection", replacesLabel: true });
    expect(first?.description).toBe("PR info can’t be loaded while offline.");
    expect(first?.action).toBeUndefined();
    const again = read("x", { online: false, showingPr: true });
    expect(again?.description).toBe(
      "PR info can’t be refreshed while offline. The status shown may be out of date.",
    );
    expect(again?.replacesLabel).toBe(false);
  });

  test("a remote on another forge has no PR info", () => {
    const issue = read("none of the git remotes configured for this repository point to a known GitHub host", {
      origin: "git@gitlab.com:acme/app.git",
    });
    expect(issue).toMatchObject({ kind: "unsupported", title: "PR info unavailable" });
    expect(issue?.description).toBe("PR information isn’t available for gitlab.com.");
    expect(issue?.action).toBeUndefined();
  });

  test("a rejected token asks for GitHub access, with Open settings", () => {
    const issue = read("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    expect(issue).toMatchObject({
      kind: "access-required",
      title: "GitHub access required",
      description: "The current GitHub connection can’t access acme/app.",
      action: "open-settings",
    });
  });

  test("a repository GitHub can't find is named", () => {
    const issue = read("GraphQL: Could not resolve to a Repository with the name 'acme/old-app'. (repository)");
    expect(issue?.title).toBe("Couldn’t load PR info");
    expect(issue?.description).toBe(
      "GitHub couldn’t find acme/old-app. It may have been renamed, deleted, or be inaccessible with the current connection.",
    );
    expect(issue?.action).toBe("retry");
  });

  test("a timeout and any other failure, first read and refresh", () => {
    expect(read("request timed out after 20s")?.description).toBe(
      "GitHub didn’t respond before the request timed out.",
    );
    expect(read("operation timeout", { showingPr: true })).toMatchObject({
      kind: "refresh-error",
      title: "Couldn’t refresh PR info",
      description: "The latest PR refresh timed out. The status shown may be out of date.",
      replacesLabel: false,
    });
    expect(read("gh: exit status 1")?.description).toBe("Aura couldn’t get PR information from GitHub.");
    expect(read("gh: exit status 1", { showingPr: true })?.description).toBe(
      "The latest PR refresh failed. The status shown may be out of date.",
    );
  });

  test("a non-string origin still yields the row's words, never a throw", () => {
    expect(read("HTTP 404: Could not resolve to a Repository", { origin: 42 })).toMatchObject({
      kind: "initial-error",
      description: "GitHub couldn’t find this repository. It may have been renamed, deleted, or be inaccessible with the current connection.",
    });
    expect(read(null, { origin: {}, online: false })).toBeNull();
  });

  test("a missing gh is not mistaken for an access problem", () => {
    expect(read("gh CLI not found — install from https://cli.github.com/ then run `gh auth login`")?.kind).toBe(
      "initial-error",
    );
  });
});

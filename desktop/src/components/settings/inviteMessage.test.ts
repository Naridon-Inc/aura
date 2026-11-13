import { describe, expect, test } from "bun:test";
import { DOWNLOAD_URL, githubHandle, inviteMessage } from "./inviteMessage";

describe("the message an admin sends someone they added", () => {
  test("says where to get Aura and which GitHub account to sign in with", () => {
    const text = inviteMessage("Acme", "octocat");
    expect(text).toContain("Acme");
    expect(text).toContain(DOWNLOAD_URL);
    expect(text).toContain("@octocat");
  });

  test("a username typed with @ or spaces is the same person", () => {
    expect(githubHandle("  @octocat ")).toBe("octocat");
    expect(githubHandle("@@octocat")).toBe("octocat");
    expect(githubHandle("octocat")).toBe("octocat");
  });

  test("the message never doubles the @", () => {
    expect(inviteMessage("Acme", githubHandle("@octocat"))).not.toContain("@@");
  });
});

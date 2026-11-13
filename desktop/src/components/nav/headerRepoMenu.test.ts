import { describe, expect, test } from "bun:test";

import { githubPageOf } from "./HeaderRepoMenu";

describe("the header's Open on GitHub", () => {
  test("an ssh or https origin on GitHub is its page", () => {
    expect(githubPageOf("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(githubPageOf("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
  });
  test("an origin elsewhere, or none, offers no GitHub page", () => {
    expect(githubPageOf("git@gitlab.com:owner/repo.git")).toBe("");
    expect(githubPageOf("")).toBe("");
  });
});

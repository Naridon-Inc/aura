import { describe, expect, test } from "bun:test";

import { readPrTemplate, withRepoContext, type RepoContextDeps } from "./gitChatContext";

const RULES = { review: "", pr: "Title format: [AREA] summary.", conflicts: "Prefer ours under gen/." };

function deps(template: string | null = null) {
  const asked: string[] = [];
  const d: RepoContextDeps = {
    instructions: async (root) => {
      asked.push(`rules:${root}`);
      return RULES;
    },
    template: async (root) => {
      asked.push(`template:${root}`);
      return template;
    },
  };
  return { d, asked };
}

const PR = { action: "create-pr", branch: "feat/x", remote: "origin", target: "main", draft: false } as const;

describe("withRepoContext", () => {
  test("Create PR carries the repo's pull request rules and its template", async () => {
    const { d, asked } = deps("## Summary\n");
    const chat = await withRepoContext("/r", PR, d);
    expect(asked).toEqual(["rules:/r", "template:/r"]);
    expect(chat.text).toContain(RULES.pr);
    expect(chat.text).toContain("## Summary");
    expect(chat.text).not.toContain(RULES.conflicts);
  });

  test("a nested repository's PR reads that repository's template, and the project's rules", async () => {
    const { d, asked } = deps("## Summary\n");
    const chat = await withRepoContext("/r/", { ...PR, folder: "cloud" }, d);
    expect(asked).toEqual(["rules:/r/", "template:/r/cloud"]);
    expect(chat.text).toContain("separate git repository in the `cloud/` folder");
  });

  test("what the caller already set is not read again", async () => {
    const { d, asked } = deps("## Summary\n");
    const chat = await withRepoContext("/r", { ...PR, preferences: null, template: null }, d);
    expect(asked).toEqual([]);
    expect(chat.text).not.toContain(RULES.pr);
  });

  test("Resolve carries the repo's conflict rules, not its pull request rules", async () => {
    const { d } = deps();
    for (const req of [
      { action: "resolve-conflicts", target: "main" } as const,
      { action: "resolve-local-conflicts" } as const,
    ]) {
      const chat = await withRepoContext("/r", req, d);
      expect(chat.text).toContain(RULES.conflicts);
      expect(chat.text).not.toContain(RULES.pr);
    }
  });

  test("the other actions read nothing", async () => {
    const { d, asked } = deps();
    await withRepoContext("/r", { action: "commit-push" }, d);
    await withRepoContext("/r", { action: "resolve-incompatible" }, d);
    expect(asked).toEqual([]);
  });
});

describe("readPrTemplate", () => {
  test("the first place with readable text wins", async () => {
    const read = async (path: string) =>
      path.endsWith("/.github/pull_request_template.md")
        ? { text: "## What\n", status: "ok" }
        : Promise.reject(new Error("missing"));
    expect(await readPrTemplate("/r", read)).toBe("## What\n");
  });

  test("an empty or unreadable template is no template", async () => {
    const read = async () => ({ text: "  \n", status: "ok" });
    expect(await readPrTemplate("/r", read)).toBeNull();
    const binary = async () => ({ text: "", status: "binary" });
    expect(await readPrTemplate("/r", binary)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";

import type { PrCheck, PrComment } from "./api";
import {
  attachedFile,
  createPrInstructions,
  failingCheckFile,
  gitChatFor,
  PR_INSTRUCTIONS_FILE,
  userPreferences,
} from "./gitChatPrompts";

const base = { branch: "feat/login", remote: "origin", target: "main", draft: false };

describe("createPrInstructions", () => {
  test("a PR for a nested repository sends every command into its folder", () => {
    const text = createPrInstructions({ ...base, folder: "cloud" });
    expect(text).toContain(
      "The user requested a PR.\n\nThis PR is for the separate git repository in the `cloud/` folder, not for the project around it. Run every git and gh command below from inside `cloud/`.\n\nFollow these steps",
    );
    expect(createPrInstructions(base)).not.toContain("separate git repository");
  });

  test("says the branch, the target and the steps, in order", () => {
    const text = createPrInstructions(base);
    expect(text.startsWith("The user likes the current state of the code.\n\n")).toBe(true);
    expect(text).toContain("The current branch is feat/login.\nThe target branch is origin/main.\nThe user requested a PR.");
    const steps = text.split("\n").filter((l) => l.startsWith("- "));
    expect(steps).toHaveLength(5);
    expect(steps[0]).toContain("skills related to creating PRs");
    expect(steps[1]).toContain("Run `git status`");
    expect(steps[2]).toContain("`git push -u origin HEAD`");
    expect(steps[3]).toBe("- Use `git diff origin/main...` to review the PR diff");
    expect(steps[4]).toBe(
      "- Use `gh pr create --base main` to create a PR onto the target branch. Keep the title under 80 characters. Keep the description under five sentences, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.",
    );
    expect(text.trimEnd().endsWith("If any of these steps fail, ask the user for help.")).toBe(true);
  });

  test("a draft says so", () => {
    expect(createPrInstructions({ ...base, draft: true })).toContain("The user requested a draft PR.");
  });

  test("a written title and description are used as-is, and the template steps aside", () => {
    const text = createPrInstructions({
      ...base,
      title: "Sign in with Google",
      description: "Adds the button.",
      template: "## Why",
    });
    expect(text).toContain("`gh pr create --base main --title <title> --body <description>` to create a PR onto the target branch.");
    expect(text).not.toContain("Keep the title under 80 characters");
    expect(text).toContain("## PR Title\n\nThe user has provided this PR title. Use it exactly as-is:\nSign in with Google");
    expect(text).toContain("## PR Description\n\nThe user has provided this PR description. Use it exactly as-is:\nAdds the button.");
    expect(text).not.toContain("## PR Description Template");
  });

  test("the repo's template rides along when there's no description", () => {
    const text = createPrInstructions({ ...base, template: "## Why\n\n## Testing" });
    expect(text).toContain("## PR Description Template");
    expect(text).toContain("```markdown\n## Why\n\n## Testing\n```");
  });

  test("the repo's rules come last and win", () => {
    const text = createPrInstructions({ ...base, preferences: "Link the ticket." });
    expect(text).toContain("## User Preferences\n<user-preferences>\nLink the ticket.\n</user-preferences>");
    expect(text.indexOf("<user-preferences>")).toBeGreaterThan(text.indexOf("ask the user for help"));
  });

  test("names nothing of Aura's own machinery", () => {
    const text = createPrInstructions({ ...base, preferences: "" });
    expect(text).not.toMatch(/aura|safety check|prove|attest/i);
  });
});

describe("userPreferences", () => {
  test("blank rules add nothing", () => {
    expect(userPreferences("   ")).toBe("");
    expect(userPreferences(null)).toBe("");
  });
});

describe("gitChatFor", () => {
  test("Create PR sends the short ask with the instructions attached", () => {
    const chat = gitChatFor({ action: "create-pr", ...base });
    expect(chat.label).toBe("Create a PR");
    expect(chat.failure).toBe("Failed to create PR");
    expect(chat.text.startsWith(`File: ${PR_INSTRUCTIONS_FILE}\n\`\`\`\nThe user likes`)).toBe(true);
    expect(chat.text.endsWith("```\n\nCreate a PR")).toBe(true);
  });

  test("a draft PR's tab says draft; its message is the same ask", () => {
    const chat = gitChatFor({ action: "create-pr", ...base, draft: true });
    expect(chat.label).toBe("Create a draft PR");
    expect(chat.text.endsWith("Create a PR")).toBe(true);
    expect(chat.text).toContain("The user requested a draft PR.");
  });

  test("Commit and push", () => {
    expect(gitChatFor({ action: "commit-push" })).toEqual({
      label: "Commit and push all changes",
      text: "Commit and push all changes",
      failure: "Failed to commit and push",
    });
  });

  test("Commit and push for a separate repository inside the project", () => {
    expect(gitChatFor({ action: "commit-push", folder: "cloud" })).toEqual({
      label: "Commit and push cloud",
      text: "Commit and push all changes in the separate git repository in the `cloud/` folder, not the project around it. Run every git command from inside `cloud/`.",
      failure: "Failed to commit and push",
    });
  });

  test("conflicts with the target merge it in", () => {
    const chat = gitChatFor({ action: "resolve-conflicts", target: "main" });
    expect(chat.text).toBe(
      "Merge the remote branch (main) into your branch and resolve conflicts. Then, commit and push your changes.",
    );
    expect(chat.failure).toBe("Failed to resolve merge conflicts");
  });

  test("incompatible with the remote", () => {
    expect(gitChatFor({ action: "resolve-incompatible" }).text).toBe(
      "Resolve branch incompatibility with remote",
    );
  });

  test("pull latest names the target ref", () => {
    expect(
      gitChatFor({ action: "pull-latest", remote: "origin", target: "main", hasUncommittedChanges: true }).text,
    ).toBe("Commit uncommitted changes, then merge origin/main into this branch. Then push.");
    expect(
      gitChatFor({ action: "pull-latest", remote: "origin", target: "main", hasUncommittedChanges: false }).text,
    ).toBe("Merge origin/main into this branch. Then push.");
  });

  test("Fix errors attaches each failing check, then its instructions", () => {
    const check: PrCheck = {
      name: "build / test",
      bucket: "failure",
      raw: "FAILURE",
      url: "https://github.com/o/r/actions/runs/12/job/345",
      workflow: "CI",
      description: "Process completed with exit code 1.",
      failure_reason: "",
    };
    const chat = gitChatFor({ action: "fix-errors", failing: [check] });
    expect(chat.failure).toBe("Failed to fix checks");
    expect(chat.text).toContain("File: build___test_345_status.txt");
    expect(chat.text).toContain("Failing Job Name: build / test\nGitHub Job ID: 345");
    expect(chat.text).toContain("File: Fix errors instructions.md");
    expect(chat.text.endsWith("Fix the failing CI actions. I've attached the failure logs.")).toBe(true);
  });

  test("a check that never started carries GitHub's reason", () => {
    const f = failingCheckFile({
      name: "lint",
      bucket: "failure",
      raw: "STARTUP_FAILURE",
      url: "https://github.com/o/r/actions/runs/77",
      workflow: "CI",
      description: "",
      failure_reason: "No runner matches the label.",
    });
    expect(f.name).toBe("lint_77_status.txt");
    expect(f.body).toContain("=== GITHUB ANNOTATION ===\nNo runner matches the label.");
  });

  test("comments go to the chat with who and where", () => {
    const c = { id: 1, author: "sam", path: "src/a.ts", line: 4, body: " Rename this. " } as PrComment;
    const one = gitChatFor({ action: "add-comments", pr: { number: 7, title: "Login" }, comments: [c] });
    expect(one.text).toContain("- @sam (src/a.ts:4): Rename this.");
    expect(one.failure).toBe("Failed to add comment to chat");
    const two = gitChatFor({ action: "add-comments", pr: { number: 7, title: "Login" }, comments: [c, c] });
    expect(two.failure).toBe("Failed to add comments to chat");
  });

  test("attachedFile is the composer's format", () => {
    expect(attachedFile("a.md", "x")).toBe("File: a.md\n```\nx\n```");
  });
});

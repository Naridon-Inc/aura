import { describe, expect, test } from "bun:test";

import { createRefusal, prWorkflow, type CloudPullRequest, type CloudPullRequestRead } from "./cloudPullRequest";

const read = (over: Partial<CloudPullRequestRead> = {}): CloudPullRequestRead => ({
  branch: "feat/x",
  base: "main",
  repo: "o/r",
  reason: null,
  detail: null,
  compare_url: "https://github.com/o/r/compare/main...feat/x?expand=1",
  merge_method: "squash",
  pr: null,
  ...over,
});
const pr = (over: Partial<CloudPullRequest> = {}): CloudPullRequest => ({
  number: 12,
  title: "Fix it",
  url: "https://github.com/o/r/pull/12",
  state: "open",
  draft: false,
  merge_state: "clean",
  review: null,
  checks: null,
  base: "main",
  head_sha: "abc",
  ...over,
});

describe("prWorkflow", () => {
  test("the first read is loading, a failed one says so with a retry", () => {
    expect(prWorkflow(null).state).toBe("loading");
    const failed = prWorkflow(null, { failed: "Sign in" });
    expect(failed.label).toBe("PR status unavailable");
    expect(failed.issue?.action).toBe("retry");
  });

  test("no pull request offers Create PR against the base", () => {
    const w = prWorkflow(read());
    expect(w.state).toBe("no-pr");
    expect(w.targetBranch).toBe("main");
    expect(w.issue).toBeUndefined();
  });

  test("a reason becomes an issue, with no create button under it", () => {
    const w = prWorkflow(read({ reason: "no_github_app" }));
    expect(w.label).toBe("GitHub not connected");
    expect(w.issue?.title).toContain("connected GitHub account");
    expect(w.issue?.description).toContain("Connected GitHub");
    expect(prWorkflow(read({ reason: "no_github" })).issue?.action).toBeUndefined();
  });

  test("unpushed work comes before the pull request", () => {
    expect(prWorkflow(read(), { standing: { ahead: 0, pushed: false } }).label).toBe("Not pushed");
    const ahead = prWorkflow(read({ pr: pr() }), { standing: { ahead: 2, pushed: true } });
    expect(ahead.state).toBe("ahead");
    expect(ahead.ahead).toBe(2);
    expect(ahead.prNumber).toBe(12);
    expect(prWorkflow(read({ pr: pr() }), { standing: { ahead: 0, pushed: true } }).state).toBe("ready");
  });

  test("an open pull request reads its state in GitHub's order", () => {
    expect(prWorkflow(read({ pr: pr({ draft: true }) })).state).toBe("draft");
    expect(prWorkflow(read({ pr: pr({ merge_state: "dirty" }) })).state).toBe("conflicts");
    const failing = prWorkflow(read({ pr: pr({ checks: { total: 4, failing: 1, pending: 1 } }) }));
    expect(failing.state).toBe("checks-failing");
    expect(failing.failedChecks).toBe(1);
    expect(prWorkflow(read({ pr: pr({ checks: { total: 2, failing: 0, pending: 1 } }) })).state).toBe(
      "checks-pending",
    );
    expect(prWorkflow(read({ pr: pr({ review: "changes_requested" }) })).state).toBe("changes-requested");
    expect(prWorkflow(read({ pr: pr({ merge_state: "blocked", review: "review_required" }) })).state).toBe(
      "review-required",
    );
    expect(prWorkflow(read({ pr: pr({ merge_state: "behind" }) })).label).toBe("Out of date with main");
    const ready = prWorkflow(read({ pr: pr() }));
    expect(ready.state).toBe("ready");
    expect(ready.mergeTooltip).toBe("Squash and merge on GitHub");
  });

  test("finished pull requests are merged or closed", () => {
    expect(prWorkflow(read({ pr: pr({ state: "merged" }) })).state).toBe("merged");
    expect(prWorkflow(read({ pr: pr({ state: "closed" }) })).state).toBe("closed");
  });

  test("a busy toolbar shows the work in progress", () => {
    expect(prWorkflow(read(), { busy: "creating-pr" }).state).toBe("creating-pr");
  });
});

describe("createRefusal", () => {
  test("names GitHub's refusals in plain words", () => {
    expect(createRefusal("not_pushed", null)).toContain("Push it");
    expect(createRefusal("no_commits", null)).toContain("no commits");
    expect(createRefusal("github_refused", "rate limited")).toBe("rate limited");
  });
});

describe("pull requests opened as the member", () => {
  test("not connected sends the member to Your GitHub", () => {
    const w = prWorkflow(read({ reason: "github_not_connected", detail: null }));
    expect(w.label).toBe("Connect your GitHub");
    expect(w.issue?.action).toBe("open-settings");
    expect(w.issue?.description).toContain("Settings → Git → Your GitHub");
  });

  test("a repository their GitHub can't open says who to ask, and can be tried again", () => {
    const said = "Your GitHub account can't open o/r. Ask whoever manages it on GitHub to add you, then try again.";
    const w = prWorkflow(read({ reason: "github_cannot_open", detail: said }));
    expect(w.issue?.description).toBe(said);
    expect(w.issue?.action).toBe("retry");
  });

  test("a failed create says the server's sentence for them", () => {
    expect(createRefusal("github_not_connected", "Connect it first.")).toBe("Connect it first.");
    expect(createRefusal("github_cannot_open", null)).toContain("Ask whoever manages it");
    expect(createRefusal("no_pr_permission", null)).toContain("your account");
  });
});

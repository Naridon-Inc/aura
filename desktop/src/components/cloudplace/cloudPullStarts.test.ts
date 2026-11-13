import { describe, expect, test } from "bun:test";

import type { CloudOpenPull } from "../../lib/cloudWorkspacesApi";
import { forkReason, pullListProblem, pullStartIntent, pullStarts, readPullStarts } from "./cloudPullStarts";

function pull(over: Partial<CloudOpenPull> = {}): CloudOpenPull {
  return {
    number: 42,
    title: "Keyboard shortcuts",
    url: "https://github.com/acme/app/pull/42",
    head: "feat/shortcuts",
    base: "main",
    author: "lumi",
    draft: false,
    updated_at: "2026-11-12T08:00:00Z",
    head_repo: "acme/app",
    from_fork: false,
    ...over,
  };
}

describe("pullStarts", () => {
  test("a pull request in the project starts on its own branch", () => {
    expect(pullStarts([pull({ draft: true })])).toEqual([
      { number: 42, title: "Keyboard shortcuts", branch: "feat/shortcuts", draft: true, unavailable: null },
    ]);
  });

  test("a fork is listed with the reason it can't start in the cloud", () => {
    const [row] = pullStarts([pull({ from_fork: true, head_repo: "stranger/app", head: "patch-1" })]);
    expect(row.unavailable).toBe(
      "#42 comes from stranger’s copy of the project, so a cloud workspace can’t push to its branch. Start it from your laptop instead.",
    );
  });

  test("a fork whose copy was deleted still says why", () => {
    expect(forkReason({ number: 7, head_repo: null })).toContain("a copy of the project that was deleted");
  });

  test("the cloud's order is kept", () => {
    expect(pullStarts([pull({ number: 9 }), pull({ number: 3 })]).map((p) => p.number)).toEqual([9, 3]);
  });
});

describe("pullListProblem", () => {
  test("the cloud's own sentence is shown as it is", () => {
    const e = new Error(`HTTP 424 Failed Dependency: {"message":"The GitHub App can't see acme/app."}`);
    expect(pullListProblem(e)).toBe("The GitHub App can't see acme/app.");
  });

  test("a cloud that predates the list says so", () => {
    expect(pullListProblem(new Error("HTTP 404 Not Found: "))).toBe("This cloud can’t list pull requests yet.");
  });

  test("a body that isn't the cloud's JSON falls back to the general wording", () => {
    expect(pullListProblem(new Error("HTTP 403 Forbidden: <html>"))).toBe(
      "Your account can’t do this in this organization.",
    );
  });
});

describe("readPullStarts", () => {
  test("reads the list for the repository asked", async () => {
    const asked: string[] = [];
    const rows = await readPullStarts("acme/app", async (repo) => {
      asked.push(repo);
      return { pulls: [pull()] };
    });
    expect(asked).toEqual(["acme/app"]);
    expect(rows.map((r) => r.branch)).toEqual(["feat/shortcuts"]);
  });

  test("a missing list is no rows, and a failure is a sentence", async () => {
    expect(await readPullStarts("acme/app", async () => ({ pulls: null }))).toEqual([]);
    await expect(
      readPullStarts("acme/app", async () => {
        throw new Error(`HTTP 403 Forbidden: {"message":"You don't have access to acme/app on Aura."}`);
      }),
    ).rejects.toThrow("You don't have access to acme/app on Aura.");
  });
});

test("the workspace records which pull request it started from", () => {
  expect(pullStartIntent({ number: 42, branch: "feat/shortcuts" })).toBe(
    "Starts from pull request #42 on feat/shortcuts",
  );
});

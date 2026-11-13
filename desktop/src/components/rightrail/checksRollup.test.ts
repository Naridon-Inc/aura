import { describe, expect, test } from "bun:test";

import type { PrCheck, VercelDeployment } from "../../lib/api";
import { checkHint, countLine, deployLine, fixableInBranch, rollUpChecks } from "./checksRollup";

const check = (name: string, bucket: string, extra: Partial<PrCheck> = {}): PrCheck => ({
  name,
  bucket,
  raw: bucket.toUpperCase(),
  url: `https://ci.example/${name}`,
  workflow: "",
  description: "",
  failure_reason: "",
  ...extra,
});

const deploy = (extra: Partial<VercelDeployment>): VercelDeployment =>
  ({ uid: "dpl_1", state: "READY", url: null, inspector_url: null, target: null, ...extra }) as VercelDeployment;

describe("rollUpChecks", () => {
  test("splits failed, running and passed, keeping order within each", () => {
    const r = rollUpChecks([
      check("lint", "success"),
      check("build", "failure"),
      check("e2e", "pending"),
      check("unit", "failure"),
      check("types", "success"),
    ]);
    expect(r.failed.map((c) => c.name)).toEqual(["build", "unit"]);
    expect(r.running.map((c) => c.name)).toEqual(["e2e"]);
    expect(r.passed.map((c) => c.name)).toEqual(["lint", "types"]);
  });

  test("an unknown bucket counts as still running", () => {
    expect(rollUpChecks([check("queued", "skipping")]).running).toHaveLength(1);
  });

  test("nothing read is nothing in any group", () => {
    expect(rollUpChecks([])).toEqual({ failed: [], running: [], passed: [] });
  });
});

describe("countLine", () => {
  test("says one or many", () => {
    expect(countLine(1, "check", "running")).toBe("1 check running");
    expect(countLine(4, "check", "passed")).toBe("4 checks passed");
    expect(countLine(3, "comment")).toBe("3 comments");
  });
});

describe("checkHint and fixableInBranch", () => {
  test("a check that never started leads with why, and is not the branch's to fix", () => {
    const c = check("deploy", "failure", { failure_reason: "No runner labelled gpu" });
    expect(checkHint(c)).toBe("Didn't start. No runner labelled gpu\nGitHub status: FAILURE");
    expect(fixableInBranch(c)).toBe(false);
  });

  test("an ordinary failure names its workflow and is fixable", () => {
    const c = check("unit", "failure", { workflow: "CI", description: "2 tests failed" });
    expect(checkHint(c)).toBe("CI · 2 tests failed\nGitHub status: FAILURE");
    expect(fixableInBranch(c)).toBe(true);
  });
});

describe("deployLine", () => {
  test("a ready preview opens its page", () => {
    expect(deployLine(deploy({ url: "app-abc.vercel.app" }))).toEqual({
      title: "Preview deployed",
      status: "passed",
      action: { label: "Open", url: "https://app-abc.vercel.app" },
    });
  });

  test("a failed production deploy points at its build", () => {
    const line = deployLine(deploy({ state: "ERROR", target: "production", inspector_url: "https://v/b" }));
    expect(line.title).toBe("Production deploy failed");
    expect(line.status).toBe("failed");
    expect(line.action).toEqual({ label: "Build", url: "https://v/b" });
  });

  test("an unknown state is a quiet row with nothing to press", () => {
    expect(deployLine(deploy({ state: "UNKNOWN" }))).toEqual({
      title: "Preview deploy",
      status: "pending",
      action: null,
    });
  });
});

// What this pins: the Checks tab is one workspace's pull request, and the
// repository's full list lives on the Dashboard. One workspace is one branch
// is one pull request, so the tab drawing the whole list again would put the
// same pull requests in two places.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "..", "src", "components");
const read = (p: string) => readFileSync(join(src, p), "utf8");

describe("one pull request per workspace", () => {
  test("Checks carries this workspace's pull request, not the repository's list", () => {
    const panel = read("rightrail/ChecksPanel.tsx");
    expect(panel).not.toContain("PullRequestList");
    expect(panel).toContain("<PrTitle");
    expect(panel).toContain("<PrCreate");
    expect(existsSync(join(src, "rightrail", "PrRailPanel.tsx"))).toBe(false);
  });

  test("the tab reads top to bottom: title, facts, description, then one Git status list", () => {
    const panel = read("rightrail/ChecksPanel.tsx");
    const at = (tag: string) => panel.indexOf(tag);
    for (const tag of ["<PrTitle", "<ChecksPrFacts", "<PrDescription", "<GitStatusRows"]) {
      expect(at(tag)).toBeGreaterThan(-1);
    }
    expect(at("<PrTitle")).toBeLessThan(at("<ChecksPrFacts"));
    expect(at("<ChecksPrFacts")).toBeLessThan(at("<PrDescription"));
    expect(at("<PrDescription")).toBeLessThan(at("<GitStatusRows"));
    // The checks, review and comments are rows in that one list, not blocks of their own.
    expect(panel).toContain("prStatusRows(");
    expect(panel).not.toContain("<CiChecks");
    expect(existsSync(join(src, "rightrail", "ChecksComments.tsx"))).toBe(false);
    expect(read("rightrail/ChecksStatus.tsx")).toContain("<DetailsCheckList flat>");
  });

  test("the Dashboard lists every pull request and can open one as a workspace", () => {
    const dash = read("dashboard/WorkspacesDashboard.tsx");
    expect(dash).toContain("<PullRequestList");
    // Opening one starts the workspace from it, on its own branch when it is
    // from this repository (lib/prStartPoint's prStartSelection).
    expect(dash).toContain("prStartSelection(pr)");
    const start = readFileSync(join(src, "..", "lib", "prStartPoint.ts"), "utf8");
    expect(start).toContain('kind: "pr"');
    expect(start).toContain("ref: prStartPoint(pr)");
  });
});

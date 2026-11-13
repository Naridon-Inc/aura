// "0 changes", from a git diff that hadn't run.
//
//   bun test
//
// The window's counts (changes, items to review, conflicts) are the app's
// most-read numbers — they are on screen
// in every window, all the time. Every one of them came from a 4-second poll
// whose failures were spent as answers:
//
//   const [stats, impacts, conflicts, astConflicts, ...] = await Promise.all([
//     api.gitDiffStats(root, sinceBase).catch(() => null),
//     api.auraReadImpacts(root).catch(() => []),        // <- a zero
//     api.auraListConflicts(root).catch(() => []),      // <- a zero
//     api.auraCountAuditUnacked(root).catch(() => 0),   // <- a zero
//   ]);
//   setImpactsCount(impacts.length);
//
// So one failed tick took a paused risky action off the footer and left the
// user looking at a bar that said there was nothing to check. And `diffStats`
// was seeded `{changed_files: 0, added: 0, removed: 0}` — which is not a
// placeholder, it is the answer "this tree is clean" — so every window opened
// reading "0 changes", hover "No changes yet", before `git diff` had run.
//
// Two rules, held below by source pins because neither surface can be
// imported into a test (App.tsx pulls the Tauri bridge
// and Monaco through its import graph):
//
//   1. A read that failed leaves the last known number alone.
//   2. A number nobody has read yet is not zero, and doesn't get a sentence.

import { describe, expect, test } from "bun:test";
import { readSrc, stripComments } from "./support/code";

/** The body of the badge poll in App.tsx, and nothing else. A `catch(() =>
 *  [])` is perfectly fine elsewhere; what matters is the handful of calls
 *  whose results are published straight into a chip.
 *
 *  The delay is matched as a number rather than pinned to one: how often the
 *  footer polls is a tuning decision that belongs to whoever is watching the
 *  main thread's load, and this file has an opinion about what the poll
 *  *does*, not how often it does it. Pinning the literal meant a cadence
 *  change turned two unrelated assertions red. */
async function tickBody(): Promise<string> {
  const src = stripComments(await readSrc("App.tsx"));
  const i = src.indexOf("async function tick()");
  expect(i).toBeGreaterThan(-1);
  const scheduled = /window\.setInterval\(tick,\s*[\d_]+\)/.exec(src.slice(i));
  expect(scheduled, "the poll must still be scheduled on an interval").not.toBeNull();
  return src.slice(i, i + scheduled!.index);
}

describe("a badge count is a number somebody read", () => {
  test("the diff stats start unread, not clean", async () => {
    const src = stripComments(await readSrc("App.tsx"));
    expect(src).toContain("useState<DiffStats | null>(null)");
    expect(src).not.toMatch(/useState<DiffStats>\s*\(\s*\{/);
  });

  test("no read in the poll resolves to an empty answer", async () => {
    const body = await tickBody();
    const flat = body.replace(/\s+/g, "");
    // The three shapes that turned a failure into a number.
    expect(flat).not.toContain("catch(()=>[])");
    expect(flat).not.toContain("catch(()=>0)");
    expect(flat).not.toContain("catch(()=>({}))");
  });

  test("every setter in the poll is guarded", async () => {
    const body = await tickBody();
    // Each of these publishes into a chip; each must be behind a check that
    // the read came back.
    for (const [guard, setter] of [
      ["if (stats)", "setDiffStats(stats)"],
      ["if (impacts)", "setImpactsCount(impacts.length)"],
      ["if (conflicts)", "setConflictsCount(conflicts.length)"],
      ["if (astConflicts)", "setAstConflictsOpen("],
      ["if (intentCount !== null)", "setIntentsToday(intentCount)"],
      ["if (auditCount !== null)", "setAuditUnacked(auditCount)"],
    ] as const) {
      expect(body).toContain(guard);
      expect(body).toContain(setter);
      // …and the guard is the line before the setter, not somewhere else in
      // the function.
      const at = body.indexOf(setter);
      expect(body.slice(Math.max(0, at - 120), at)).toContain(guard);
    }
  });
});

describe("the changes count", () => {
  test("the rail passes the unread state through instead of flattening it", async () => {
    // The tab counts the Changes list itself (tests/changesBadgeCount.test.ts).
    // `undefined` until git has answered for the project — the tab draws
    // nothing for it.
    const hook = stripComments(await readSrc("components/rightrail/useChangeList.ts"));
    expect(hook).toContain("return changes.loading ? undefined : count;");
    const rail = stripComments(await readSrc("components/rightrail/RightRail.tsx"));
    expect(rail).toContain("const changesCount = useChangedFileCount(");
    expect(rail).not.toMatch(/useChangedFileCount\([^)]*\)\s*\?\?\s*0/);
  });

  test("the Changes tab draws a count only for a read, positive number", async () => {
    const src = stripComments(await readSrc("components/ui/details-panel.tsx"));
    const flat = src.replace(/\s+/g, "");
    // A count nobody has read yet, and a clean tree, both draw no number —
    // neither one gets to say "0".
    expect(flat).toContain("tab.count!=null&&tab.count>0");
  });

  test("an unread count doesn't mark the branch as having changes", async () => {
    const src = stripComments(await readSrc("App.tsx"));
    expect(src).toContain("dirty={(diffStats?.changed_files ?? 0) > 0}");
  });
});

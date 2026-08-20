// "0 changes", from a git diff that hadn't run.
//
//   bun test
//
// The status bar's chips are the app's most-read numbers — they are on screen
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
// imported into a test (App.tsx and StatusBar.tsx both pull the Tauri bridge
// and Monaco through their import graph):
//
//   1. A read that failed leaves the last known number alone.
//   2. A number nobody has read yet is not zero, and doesn't get a sentence.

import { describe, expect, test } from "bun:test";
import { readSrc, stripComments } from "./support/code";

/** The body of the 4s badge poll in App.tsx, and nothing else. A `catch(() =>
 *  [])` is perfectly fine elsewhere; what matters is the handful of calls
 *  whose results are published straight into a chip. */
async function tickBody(): Promise<string> {
  const src = stripComments(await readSrc("App.tsx"));
  const i = src.indexOf("async function tick()");
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf("window.setInterval(tick, 4000)", i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
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

describe("the changes chip", () => {
  test("it takes a count that can be unread", async () => {
    const src = stripComments(await readSrc("components/StatusBar.tsx"));
    expect(src).toContain("changedFiles: number | null");
  });

  test("'No changes yet' is only said once we've looked", async () => {
    const src = stripComments(await readSrc("components/StatusBar.tsx"));
    const at = src.indexOf('"No changes yet"');
    expect(at).toBeGreaterThan(-1);
    // The null arm has to come first — a bare `changedFiles > 0 ? … : "No
    // changes yet"` sends every unread render down the sentence.
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toContain("changedFiles === null");
    expect(before).toContain("hasn’t read this workspace’s changes yet");
  });

  test("an unread count draws a dash and doesn't navigate", async () => {
    const src = stripComments(await readSrc("components/StatusBar.tsx"));
    const flat = src.replace(/\s+/g, "");
    expect(flat).toContain('changedFiles===null?"—"');
    // Clicking opens the review surface. There is nothing to review from a
    // read that hasn't happened.
    expect(flat).toContain("changedFiles!==null&&changedFiles>0?onClickDiff:undefined");
  });

  test("the App passes the unread state through instead of flattening it", async () => {
    const src = stripComments(await readSrc("App.tsx"));
    expect(src).toContain("changedFiles={diffStats?.changed_files ?? null}");
    // The rail's tab badge hides itself on a nullish count, so `undefined` is
    // the honest thing to hand it.
    expect(src).toContain("changesCount={diffStats?.changed_files}");
  });
});

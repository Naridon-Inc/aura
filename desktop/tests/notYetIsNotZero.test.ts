// Two readouts that answered before they had asked.
//
//   bun test
//
// Same shape in both: state starts null, an async read fills it, and the
// render collapsed null into a neutral value. Null means two different things
// there — "the read hasn't come back" and "the read failed" — and neither is
// "the answer is zero".
//
// ChangesSummaryPane is the Changes tab before you pick a file. Its whole job
// is to say how much you've changed. `stats?.changed_files ?? 0` sent the
// zero branch, so the first frame of every visit read:
//
//     Nothing is changed right now — your working copy matches the last
//     saved version.
//
// The catch on the git call was `() => {}`, so a read that threw left that
// sentence up permanently. Somebody with unsaved work was told, calmly, that
// they had none.
//
// MemoryBadge exists to be *proof* that memory is loaded — its own header
// comment says the user "has no way to *see* that memory is loaded. This
// indicator is the proof." It rendered "○ Memory · 0" and "No memory entries
// yet" from the same null.

import { describe, expect, test } from "bun:test";

import { summaryLine } from "../src/components/git/ChangesSummaryPane";
import { memoryPill } from "../src/components/manager/MemoryBadge";
import type { DiffStats, MemorySection, MemoryView } from "../src/lib/api";
import { stripComments as code } from "./support/code";

function stats(changed_files: number): DiffStats {
  return { changed_files, added: changed_files * 3, removed: changed_files };
}

function view(counts: number[]): MemoryView {
  const sections: MemorySection[] = counts.map((n, i) => ({
    name: `section${i}`,
    entries: Array.from({ length: n }, () => ({}) as never),
  }));
  return { identity: "aura", stack: [], sections, last_updated: 0 };
}

describe("the Changes tab waits before saying nothing changed", () => {
  test("before git answers, it doesn't answer either", () => {
    const { text, tone } = summaryLine(null, false);
    expect(tone).toBe("waiting");
    expect(text).not.toContain("matches the last saved version");
    expect(text).not.toContain("Nothing is changed");
    expect(text).toContain("Counting up");
  });

  test("a failed read is its own state, not a clean tree", () => {
    // The old catch was `() => {}`, so this state lasted until the tab was
    // reopened — with the all-clear sentence on screen the whole time.
    const { text, tone } = summaryLine(null, true);
    expect(tone).toBe("waiting");
    expect(text).not.toContain("matches the last saved version");
    expect(text).toContain("couldn't read");
    // Say it's the reading that failed, not the work.
    expect(text).toContain("Nothing is wrong with your work");
  });

  test("a real clean tree still gets the reassuring line", () => {
    const { text, tone } = summaryLine(stats(0), false);
    expect(tone).toBe("known");
    expect(text).toBe(
      "Nothing is changed right now. Your working copy matches the last saved version.",
    );
  });

  test("real changes are counted and pluralised", () => {
    expect(summaryLine(stats(1), false).text).toContain("changed 1 file since");
    expect(summaryLine(stats(4), false).text).toContain("changed 4 files since");
  });

  test("a stale failure flag never outranks real numbers", () => {
    // Reads retry on `aura:git-changed`. If one fails and the next succeeds,
    // the numbers have to win — a sticky error would be its own false state.
    const { text, tone } = summaryLine(stats(2), false);
    expect(tone).toBe("known");
    expect(text).toContain("2 files");
  });

  test("only a loaded, genuinely-empty tree may claim to be clean", () => {
    const claims = ([
      [null, false],
      [null, true],
      [stats(0), false],
      [stats(3), false],
    ] as const).map(
      ([s, f]) => summaryLine(s, f).text.includes("matches the last saved version"),
    );
    expect(claims).toEqual([false, false, true, false]);
  });
});

describe("the memory pill doesn't prove absence from never looking", () => {
  test("before the read completes there is no count", () => {
    const p = memoryPill(null, false);
    expect(p.count).toBeNull();
    expect(p.title).not.toContain("No memory entries yet");
    expect(p.glyph).not.toBe("○");
    // Name the state, don't just avoid the wrong one: drop the not-yet arm
    // and this falls through to the failed-read arm, which satisfies every
    // assertion above while telling the user a read failed that never ran.
    expect(p.title).toContain("Checking");
    expect(p.title).not.toContain("couldn't read");
  });

  test("a failed read says so rather than reporting none", () => {
    const p = memoryPill(null, true);
    expect(p.count).toBeNull();
    expect(p.title).toContain("couldn't read");
    expect(p.title).not.toContain("No memory entries yet");
  });

  test("the two empty-handed states are not the same state", () => {
    expect(memoryPill(null, false).title).not.toBe(memoryPill(null, true).title);
  });

  test("a real empty memory bank still reads as empty", () => {
    const p = memoryPill(view([0, 0]), true);
    expect(p.count).toBe(0);
    expect(p.glyph).toBe("○");
    expect(p.title).toBe("No memory entries yet. Click to add one");
  });

  test("entries are summed across every section", () => {
    const p = memoryPill(view([2, 0, 5]), true);
    expect(p.count).toBe(7);
    expect(p.glyph).toBe("✓");
    expect(p.title).toContain("7 memory entries loaded");
  });

  test("the tick is only earned by a completed read that found something", () => {
    const cases: Array<[MemoryView | null, boolean]> = [
      [null, false],
      [null, true],
      [view([0]), true],
      [view([1]), true],
    ];
    expect(cases.map(([v, c]) => memoryPill(v, c).glyph === "✓")).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("the components render the state their readouts computed", () => {
  test("neither file rebuilds the claim beside the function that owns it", async () => {
    const changes = code(
      await Bun.file(
        `${import.meta.dir}/../src/components/git/ChangesSummaryPane.tsx`,
      ).text(),
    );
    // The sentence must exist exactly once — inside summaryLine. A second
    // copy in the JSX is how this defect comes back.
    const occurrences = changes.split("matches the last saved version").length - 1;
    expect(occurrences).toBe(1);
    // …and the render must go through the function, not around it.
    expect(changes).toContain("summaryLine(stats, statsFailed)");
    // The numbers block was gated on a count that null made zero; it now
    // requires the stats object itself.
    expect(changes).toContain("stats && changed > 0");

    const badge = code(
      await Bun.file(
        `${import.meta.dir}/../src/components/manager/MemoryBadge.tsx`,
      ).text(),
    );
    expect(badge).toContain("memoryPill(view, checked)");
    expect(badge).toContain("pill.count ?? \"—\"");
    // `checked` has to be set on both arms or a failed read looks like a
    // pending one forever — `finally` is what guarantees that.
    expect(badge).toContain("setChecked(true)");
  });

  test("the failure path is no longer swallowed silently", async () => {
    const changes = code(
      await Bun.file(
        `${import.meta.dir}/../src/components/git/ChangesSummaryPane.tsx`,
      ).text(),
    );
    // Scope to this one promise chain — the ahead/behind read beside it keeps
    // an empty catch on purpose (its whole block is hidden when absent, which
    // asserts nothing), and a byte window would wrongly flag it.
    // Both reads now go through gitStateCache, so the anchor is the cache's
    // reader rather than the raw command — the property under test is the same
    // one either way: this chain has a failure branch and doesn't swallow it.
    const i = changes.indexOf("fetchDiffStats(repoRoot)");
    expect(i).toBeGreaterThan(-1);
    const end = changes.indexOf("fetchAheadBehind", i);
    expect(end).toBeGreaterThan(i);
    const chain = changes.slice(i, end);
    expect(chain).toContain("setStatsFailed(true)");
    expect(chain).not.toContain(".catch(() => {})");
  });
});

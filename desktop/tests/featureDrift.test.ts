// The Drift gate's numbers — held to the set they actually counted.
//
//   bun test
//
// Drift folds Aura's per-commit intent-vs-actual score across a feature's
// commits. Only some of those commits can be scored: one with no recorded
// intent has nothing to check against, and one whose only "reason" Aura wrote
// from that same diff scores against itself. Both are set aside.
//
// So what the gate weighs is a *sample*, and a sample stated as a total is a
// lie with a number in it. "Across all 2 commits, the code that changed is
// what was asked for" was true of the sample and read as a verdict on the
// whole feature — ten unmeasured commits behind it, a full green bar in front.
//
// Two invariants here:
//   1. every count names which set it counted, and a feature with unchecked
//      commits always says how many;
//   2. a sample too thin to mean anything reports its coverage instead of a
//      verdict, and never hands the surface back to the heuristic — that one
//      measures proof regressions, a different question wearing this label.

import { describe, expect, test } from "bun:test";

import { driftFromAlignments } from "../src/lib/useFeatureDrift";
import type { IntentBanner } from "../src/lib/useIntentMatch";
import type { IntentBasis } from "../src/lib/intentBasis";
import { stripComments } from "./support/code";

type A = { banner: IntentBanner; score: number; basis?: IntentBasis };

const ok = (score = 1): A => ({ banner: "aligned", score, basis: "stated" });
const drifted = (score = 0.4): A => ({ banner: "drift", score, basis: "stated" });
const gone = (score = 0.1): A => ({ banner: "diverged", score, basis: "stated" });
/** Scored, but against a line Aura wrote from this same diff — set aside. */
const selfMatched = (): A => ({ banner: "aligned", score: 1, basis: "inferred" });
/** Never scored at all. */
const unscored = (): A => ({ banner: "unknown", score: 0, basis: "none" });

function many(n: number, make: () => A): A[] {
  return Array.from({ length: n }, make);
}

describe("a count in the rationale names the set it counted", () => {
  test("a fully-checked clean feature says all of them, and means it", () => {
    const g = driftFromAlignments(many(4, () => ok()))!;
    expect(g.value).toBe("Held");
    expect(g.band).toBe("strong");
    expect(g.pct).toBe(100);
    expect(g.rationale).toContain("all 4 commits");
    // nothing was set aside, so nothing to disclose
    expect(g.rationale).not.toContain("recorded no reason");
  });

  test("a partly-checked clean feature never says 'all'", () => {
    // 3 scoreable, 2 not: the old sentence read "across all 3 commits" over a
    // five-commit feature.
    const g = driftFromAlignments([...many(3, () => ok()), unscored(), selfMatched()])!;
    expect(g.value).toBe("Held");
    expect(g.rationale).not.toContain("all 3");
    expect(g.rationale).toContain("the 3 commits Aura could check");
    expect(g.rationale).toContain("The other 2 commits recorded no reason");
  });

  test("the drift branch discloses the gap too", () => {
    const g = driftFromAlignments([ok(), ok(), drifted(), unscored()])!;
    expect(g.value).toBe("Slipped");
    expect(g.band).toBe("fair");
    expect(g.rationale).toContain("1 of the 3 commits Aura could check");
    expect(g.rationale).toContain("The other 1 commit recorded no reason");
  });

  test("whenever anything is set aside, the count of it appears. Every mix", () => {
    // The invariant, not one example: a reader must be able to tell a clean
    // feature from a mostly-unrecorded one without leaving the sentence.
    for (const checked of [2, 3, 4, 6]) {
      for (const aside of [0, 1, 2]) {
        for (const bad of [() => ok(), () => drifted(), () => gone()]) {
          const rows = [...many(checked - 1, () => ok()), bad(), ...many(aside, unscored)];
          const g = driftFromAlignments(rows)!;
          expect(g).not.toBeNull();
          if (aside === 0) continue;
          expect(g.rationale).toContain(`The other ${aside} commit`);
        }
      }
    }
  });

  test("singular and plural both read as English", () => {
    const one = driftFromAlignments([ok(), ok(), unscored()])!;
    expect(one.rationale).toContain("The other 1 commit recorded");
    expect(one.rationale).not.toContain("1 commits");

    const solo = driftFromAlignments([ok()])!;
    expect(solo.rationale).toContain("all 1 commit,");
    expect(solo.rationale).not.toContain("1 commits");
  });
});

describe("a sample too thin to mean anything doesn't get to be a verdict", () => {
  test("under half scoreable reports coverage instead", () => {
    const g = driftFromAlignments([ok(), ...many(9, unscored)])!;
    expect(g.value).toBe("—");
    expect(g.band).toBe("unknown");
    expect(g.pct).toBe(0);
    expect(g.rationale).toContain("Only 1 of 10 commits");
    // and it must not smuggle a verdict into the sentence
    expect(g.rationale).not.toContain("Held");
    expect(g.rationale).not.toContain("drifted from");
  });

  test("exactly half still counts", () => {
    // The cut is "fewer than half", not "not most" — two of four is a real
    // sample and the sentence already discloses the other two.
    const g = driftFromAlignments([ok(), ok(), unscored(), unscored()])!;
    expect(g.value).toBe("Held");
    expect(g.rationale).toContain("The other 2 commits");
  });

  test("a self-matched reason is not coverage", () => {
    // Every commit scored "aligned", every score a 1 — but each was measured
    // against a line Aura wrote from that same diff. A green "Held" here is
    // the exact defect lib/intentBasis exists to stop.
    const g = driftFromAlignments(many(6, selfMatched))!;
    expect(g.value).toBe("—");
    expect(g.band).toBe("unknown");
    expect(g.rationale).toContain("None of the 6 commits");
  });
});

describe("an absence of evidence is not a loading state", () => {
  test("nothing scoreable still answers. It does not fall through to the heuristic", () => {
    // null means "no answer yet, keep showing the placeholder". The placeholder
    // is the proof-regression heuristic, which can print a green "Held steady"
    // under the Drift label having never looked at the ask. A feature whose
    // commits can never be scored must not sit under that forever.
    const g = driftFromAlignments(many(3, unscored));
    expect(g).not.toBeNull();
    expect(g!.value).toBe("—");
    expect(g!.rationale).toContain("nothing to measure drift from");
  });

  test("no commits at all is the one honest null", () => {
    expect(driftFromAlignments([])).toBeNull();
  });

  test("a missing basis is read as stated, not as an excuse to skip", () => {
    // The chip cache predates the basis field. Rows without one are the
    // ordinary case and must still be weighed, or every feature reads "—".
    const g = driftFromAlignments([
      { banner: "aligned", score: 1 },
      { banner: "aligned", score: 1 },
    ])!;
    expect(g.value).toBe("Held");
    expect(g.band).toBe("strong");
  });
});

describe("the gate the surfaces render is the one computed here", () => {
  test("no surface folds banners into a drift verdict of its own", async () => {
    // Four components show this gate. If one starts counting `aligned` itself
    // the disclosure above stops travelling with the number.
    const SRC = `${import.meta.dir}/../src`;
    const offenders: string[] = [];
    for await (const rel of new Bun.Glob("components/**/*.tsx").scan({ cwd: SRC })) {
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      if (/key:\s*"drift"/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the drift override still reaches the card", async () => {
    const gates = await Bun.file(
      `${import.meta.dir}/../src/components/goals/FeatureGates.tsx`,
    ).text();
    expect(gates).toContain("driftOverride ?? signals.drift");
  });
});

// The Checks header — every step has to land somewhere.
//
//   bun test
//
// `CiStatus` is one of four things: pass, fail, skip, timeout. The header's
// fold counted the first, folded fail and timeout into "needs a look", and
// dropped `skip` on the floor. A skipped check then existed nowhere on the
// surface — not in the counts line, not in the headline.
//
// So a run where two checks passed and six were skipped rendered:
//
//     Your checks ran — all 2 passed. Ready to ship.
//     2 passed · 4m ago
//
// "All" meant all of the ones that ran. "Ready to ship" is the most
// consequential sentence in the panel, and it was reachable over a run that
// mostly hadn't happened.
//
// The invariant: passed + needsLook + skipped covers every step, and the
// all-clear is only reachable when nothing was skipped.

import { describe, expect, test } from "bun:test";

import { summarize } from "../src/components/workpanes/ChecksPane";
import type { CiPipelineRun, CiStatus, CiStepResult } from "../src/lib/api";
import { readSrc } from "./support/code";

const ALL_STATUSES: CiStatus[] = ["pass", "fail", "skip", "timeout"];

function step(status: CiStatus, name = status): CiStepResult {
  return {
    name,
    kind: "gate:no-stubs",
    status,
    blocking: true,
    summary: `${name} summary`,
    duration_ms: 12,
  };
}

function run(steps: CiStepResult[], over: Partial<CiPipelineRun> = {}): CiPipelineRun {
  return {
    pipeline: "pre-commit",
    trigger: "pre-commit",
    steps,
    status: "pass",
    blocked: false,
    headline: "engine headline",
    duration_ms: 40,
    ...over,
  };
}

/** Two runs, so the engine's own single-run headline doesn't short-circuit. */
function two(steps: CiStepResult[]): CiPipelineRun[] {
  return [run(steps), run([], { pipeline: "pre-push" })];
}

describe("every step lands in a count", () => {
  test("the three counts add up to the steps, for every status", () => {
    // The real invariant: add a fifth status to CiStatus and this fails here
    // rather than silently vanishing from the header.
    for (const s of ALL_STATUSES) {
      const { passed, needsLook, skipped } = summarize(two([step(s), step(s), step(s)]));
      expect(passed + needsLook + skipped).toBe(3);
    }
  });

  test("skip is counted as skipped, not as nothing", () => {
    const { passed, needsLook, skipped } = summarize(
      two([step("pass"), step("skip"), step("skip")]),
    );
    expect(passed).toBe(1);
    expect(needsLook).toBe(0);
    expect(skipped).toBe(2);
  });

  test("timeout still reads as needing a look", () => {
    const { needsLook } = summarize(two([step("timeout"), step("fail")]));
    expect(needsLook).toBe(2);
  });
});

describe("the all-clear is only reachable when everything ran", () => {
  test("a clean run keeps its all-clear", () => {
    const { headline } = summarize(two([step("pass"), step("pass")]));
    expect(headline).toBe("Your checks ran. All 2 passed. Ready to ship.");
  });

  test("skipped checks cost the all-clear", () => {
    const { headline } = summarize(two([step("pass"), step("pass"), step("skip")]));
    expect(headline).not.toContain("Ready to ship");
    expect(headline).not.toContain("all 2 passed");
    expect(headline).toContain("2 passed, 1 skipped");
    expect(headline).toContain("Nothing failed, but not everything ran");
  });

  test("a run where nothing ran at all doesn't read as a pass", () => {
    // The old fold made this "all 0 passed. Ready to ship."
    const { headline } = summarize(two([step("skip"), step("skip")]));
    expect(headline).not.toContain("Ready to ship");
    expect(headline).toContain("0 passed, 2 skipped");
  });

  test("a failure still leads, and the skips still show", () => {
    const { headline } = summarize(two([step("pass"), step("fail"), step("skip")]));
    expect(headline).toContain("1 passed");
    expect(headline).toContain("1 needs a look");
    expect(headline).toContain("1 skipped");
  });

  test("no skips means no skip clause", () => {
    const { headline } = summarize(two([step("pass"), step("fail")]));
    expect(headline).toBe("Your checks ran. 1 passed, 1 needs a look.");
  });

  test("one pipeline still defers to the engine's own headline", () => {
    const { headline, skipped } = summarize([run([step("pass"), step("skip")])]);
    expect(headline).toBe("engine headline");
    // …but the count still travels, so the skip isn't invisible on that path.
    expect(skipped).toBe(1);
  });
});

describe("the counts line shows what the counts hold", () => {
  test("the header renders the skipped count it is handed", async () => {
    const src = await readSrc("components/workpanes/ChecksPane.tsx");
    // Counting it and then not drawing it is the same defect wearing a
    // different mask, so pin the render as well as the fold.
    expect(src).toContain("skipped > 0 &&");
    expect(src).toContain("skipped} skipped");
    expect(src).toContain("skipped={skipped}");
  });
});

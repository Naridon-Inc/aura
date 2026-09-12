// The still-open list is on the page, and the checkboxes are real.
//
//   bun test ./tests/stillOpenIsWired.test.ts
//
// The logic for both is tested next door on plain data. What that cannot catch
// is the version of this ticket where all of it exists and none of it is
// reachable — which is the state the feature was already in: `goal.acceptance`
// had been written by the planner, stored on the record and rendered for
// months, as squares that took no click. Working code nothing calls is the
// failure mode this file exists to pin.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

describe("what a run still owes is on the run's own page", () => {
  it("renders above the evidence ledger, not somewhere else in the app", async () => {
    const src = await readSrc("components/workpanes/SessionSummary.tsx");

    expect(src).toContain("<SessionOutstanding");
    expect(src.indexOf("<SessionOutstanding")).toBeLessThan(src.indexOf("<SessionEvidence"));
  });

  it("is given the run's own key, version and time, so its results age", async () => {
    const src = await readSrc("components/workpanes/SessionSummary.tsx");
    const section = src.slice(
      src.indexOf("<SessionOutstanding"),
      src.indexOf("<SessionEvidence"),
    );

    expect(section).toContain("runKey={runKeyForIntent(row)}");
    // The version comes in as part of the run's scope — the same value both
    // this list and the ledger below age their results against.
    expect(section).toContain("scope={scope}");
    expect(section).toContain("codeChangedAt={row.timestamp * 1000}");
  });

  it("offers the comparison tab only when the run actually has one", async () => {
    const src = await readSrc("components/workpanes/SessionDetailPane.tsx");

    expect(src).toContain('onOpenMatch={showAlignment ? () => setTab("alignment") : undefined}');
  });
});

describe("the verify plan takes an answer", () => {
  it("no longer draws a square that does nothing", async () => {
    const src = await readSrc("components/goals/GoalProbe.tsx");

    // The decorative checkbox: a bordered 10px box with no input behind it.
    expect(src).not.toContain("h-[10px] w-[10px] shrink-0 rounded-[2px]");
    expect(src).toContain("<AcceptanceChecklist");
  });

  it("records each answer against the version it was tried on", async () => {
    const src = await readSrc("components/goals/GoalProbe.tsx");
    const section = src.slice(src.indexOf("<AcceptanceChecklist"));

    expect(section).toContain("revision={atCommit ?? null}");
    expect(section).toContain("underReview={underReview}");
  });

  it("asks for an outcome, never for an acknowledgement", async () => {
    const src = await readSrc("components/goals/ManualOutcome.tsx");

    expect(src).toContain("It worked");
    expect(src).toContain("It didn&apos;t");
    // Nothing that records a look without a result.
    expect(src.toLowerCase()).not.toContain(">done<");
    expect(src.toLowerCase()).not.toContain(">checked<");
  });
});

describe("running the checks again", () => {
  it("goes through the one shared record, so no two surfaces disagree", async () => {
    const evidence = await readSrc("components/workpanes/SessionEvidence.tsx");
    const outstanding = await readSrc("components/workpanes/SessionOutstanding.tsx");

    expect(evidence).toContain("runChecksNow(repoRoot)");
    expect(outstanding).toContain("runChecksNow(repoRoot)");
    // Neither keeps its own copy of the cache any more.
    expect(evidence).not.toContain("loadCachedChecks");
    expect(outstanding).not.toContain("loadCachedChecks");
  });

  it("treats a run that produced nothing as a failure, not an all-clear", async () => {
    const src = await readSrc("lib/checksEvidence.ts");
    const runner = src.slice(src.indexOf("export async function runChecksNow"));

    expect(runner).toContain("runs.length === 0");
    expect(runner).toContain("couldn't run your checks");
    // The failing branch must not stamp a fresh timestamp over the old result.
    const failing = runner.slice(runner.indexOf("runs.length === 0"), runner.indexOf("const value"));
    expect(failing).not.toContain("Date.now()");
  });
});

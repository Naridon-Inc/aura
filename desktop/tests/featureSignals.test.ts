// The feature card — held to what it actually looked at.
//
//   bun test
//
// A live `aura prove` outcome carries per-part detail. A recorded run carries
// counts. Open a goal from its history and the card renders from counts alone
// — and twice it read the missing detail as a finding.
//
// Risk weighs three danger signals: placeholders that look finished but do
// nothing, steps nothing calls, and parts that used to pass and stopped. Only
// the third survives without an outcome. The scan loop ran over nothing,
// counted zero, and the gate went green "Low" with "Nothing looks
// done-but-empty, and nothing that was working has broken." The first half of
// that sentence was about the thing it had not examined — and the module's own
// doc comment already said Risk "can't see placeholders/dead-ends" without an
// outcome. Written down, contradicted eight lines away.
//
// Confidence and the headline read per-part existence the same way: `built ??
// 0` turned "nobody looked" into "none of it is there", so a goal with nothing
// passing yet was told "Not started in the code yet" — the card's top line —
// over work that may be fully written and simply not wired.
//
// Zero findings from a scan that didn't run is not a clean bill of health, and
// an unknown count is not a zero.

import { describe, expect, test } from "bun:test";

import { computeFeatureSignals } from "../src/lib/featureSignals";
import { reachedSummary } from "../src/lib/goalStore";
import type { GoalRecord, GoalRun } from "../src/lib/goalStore";
import type { ProveCheck, ProveOutcome } from "../src/lib/prove";
import { readSrc } from "./support/code";

function run(over: Partial<GoalRun> = {}): GoalRun {
  return {
    runKey: "adhoc",
    verdict: "verified",
    ok: 3,
    total: 3,
    at: 1_700_000_000_000,
    ...over,
  };
}

function goal(runs: GoalRun[]): GoalRecord {
  return { id: "g1", text: "User can pay with a saved card", runs };
}

function check(over: Partial<ProveCheck> = {}): ProveCheck {
  return {
    node_name: "chargeCard",
    node_type: "function",
    must_call: null,
    exists: true,
    is_stub: false,
    wired: true,
    passed: true,
    reason: "in place",
    ...over,
  };
}

function outcome(checks: ProveCheck[]): ProveOutcome {
  return {
    goal: "User can pay with a saved card",
    checks,
    passed: checks.filter((c) => c.passed).length,
    total: checks.length,
    verdict: "verified",
    error: null,
  };
}

describe("Risk doesn't report a scan that never ran", () => {
  test("a goal opened from its history says what it could not see", () => {
    // The first-paint path: recorded runs, no live outcome yet. This used to
    // be green "Low" at 100%.
    const { risk } = computeFeatureSignals(goal([run(), run({ at: 1 })]), null);
    expect(risk.value).toBe("—");
    expect(risk.band).toBe("unknown");
    expect(risk.pct).toBe(0);
    expect(risk.rationale).not.toContain("done-but-empty");
    expect(risk.rationale).toContain("Run one to look inside the parts");
  });

  test("with a real scan and nothing found, Low is earned", () => {
    const { risk } = computeFeatureSignals(
      goal([run()]),
      outcome([check(), check({ node_name: "saveCard" })]),
    );
    expect(risk.value).toBe("Low");
    expect(risk.band).toBe("strong");
    expect(risk.pct).toBe(100);
    expect(risk.rationale).toContain("Nothing looks done-but-empty");
  });

  test("an outcome carrying no checks scanned nothing either", () => {
    const { risk } = computeFeatureSignals(goal([run()]), outcome([]));
    expect(risk.value).toBe("—");
    expect(risk.band).toBe("unknown");
  });

  test("a placeholder is still found, and named", () => {
    const { risk } = computeFeatureSignals(
      goal([run()]),
      outcome([check(), check({ node_name: "refund", is_stub: true, passed: false })]),
    );
    expect(risk.value).toBe("Watch");
    expect(risk.rationale).toContain("1 placeholder that looks finished");
    // it did scan, so no "there may be more"
    expect(risk.rationale).not.toContain("whether there's more");
  });

  test("a regression found without a scan says the scan is still owed", () => {
    // Real finding, partial view: the count is honest, the picture isn't
    // complete, and the card has to say which.
    const { risk } = computeFeatureSignals(
      goal([run({ ok: 1, total: 3, at: 2 }), run({ ok: 3, total: 3, at: 1 })]),
      null,
    );
    expect(risk.value).toBe("Watch");
    expect(risk.rationale).toContain("stopped passing");
    expect(risk.rationale).toContain("Run a check to see whether there's more");
  });

  test("nothing checked at all is still its own state", () => {
    const { risk } = computeFeatureSignals(goal([]), null);
    expect(risk.value).toBe("—");
    expect(risk.rationale).toBe("Not checked yet. Nothing to weigh.");
  });
});

describe("an unknown part count is not a zero", () => {
  const nothingPassing = goal([run({ verdict: "not_wired", ok: 0, total: 4 })]);

  test("the headline stops saying the work was never started", () => {
    const { headline, confidence } = computeFeatureSignals(nothingPassing, null);
    // The old top line: "Not started in the code yet — none of the 4 parts are
    // built." All Aura knew was that none of them pass.
    expect(headline).not.toContain("Not started in the code yet");
    expect(headline).toContain("Nothing passes yet. 4 parts to go");
    expect(headline).toContain("Run a check to see what's built");
    expect(confidence.rationale).not.toContain("this needs are built yet");
    expect(confidence.rationale).toContain("which are built and which aren't there at all");
  });

  test("with a real scan, a genuine zero still reads as one", () => {
    // Every part checked, none of them exist. That IS "not started", and the
    // card has to keep being able to say so.
    const none = outcome([
      check({ exists: false, passed: false }),
      check({ node_name: "saveCard", exists: false, passed: false }),
    ]);
    const { headline, confidence } = computeFeatureSignals(nothingPassing, none);
    expect(headline).toContain("Not started in the code yet");
    expect(confidence.rationale).toContain("None of the 2 parts this needs are built yet");
  });

  test("built-but-not-wired still reads as built", () => {
    const wiredNone = outcome([
      check({ passed: false, wired: false }),
      check({ node_name: "saveCard", passed: false, wired: false }),
    ]);
    const { headline, confidence } = computeFeatureSignals(nothingPassing, wiredNone);
    expect(headline).toContain("Every part is built");
    expect(confidence.rationale).toContain("All 2 parts are built");
  });

  test("a partial scan reports the part it counted", () => {
    const some = outcome([
      check({ passed: false }),
      check({ node_name: "saveCard", exists: false, passed: false }),
      check({ node_name: "refund", exists: false, passed: false }),
    ]);
    const { headline } = computeFeatureSignals(nothingPassing, some);
    expect(headline).toContain("1 of 3 parts are built");
  });

  test("the two sentences agree about what is known", () => {
    // The headline and the Confidence rationale read the same field. They must
    // never disagree about whether existence was checked.
    for (const o of [null, outcome([check({ exists: false, passed: false })])]) {
      const { headline, confidence } = computeFeatureSignals(nothingPassing, o);
      const headlineKnows = !headline.includes("Run a check to see what's built");
      const gateKnows = !confidence.rationale.includes("which aren't there at all");
      expect(headlineKnows).toBe(gateKnows);
    }
  });
});

describe("the reason line under the verdict reads the same field the same way", () => {
  const nothingPassing = goal([run({ verdict: "not_wired", ok: 0, total: 4 })]);

  test("without a scan it doesn't claim nothing was written", () => {
    // Third site of the same collapse. Its own doc comment says the outcome
    // "carries which parts actually exist in code, so a 'built but not wired'
    // state reads honestly instead of claiming nothing was built" — and then
    // defaulted to 0 whenever the outcome wasn't passed.
    const text = reachedSummary(nothingPassing, null)!;
    expect(text).not.toContain("None of the 4 parts this needs are built yet");
    expect(text).toContain("None of the 4 parts are passing yet");
    expect(text).toContain("which are built and which aren't there at all");
  });

  test("with a scan, a genuine zero still reads as one", () => {
    const none = outcome([
      check({ exists: false, passed: false }),
      check({ node_name: "saveCard", exists: false, passed: false }),
    ]);
    expect(reachedSummary(nothingPassing, none)).toContain(
      "None of the 4 parts this needs are built yet",
    );
  });

  test("built-but-not-wired survives", () => {
    const built = outcome([check({ passed: false, wired: false })]);
    expect(reachedSummary(nothingPassing, built)).toContain("1 of 4 parts are built");
  });

  test("it agrees with the headline about whether existence was checked", () => {
    for (const o of [null, outcome([check({ exists: false, passed: false })])]) {
      const line = reachedSummary(nothingPassing, o)!;
      const { headline } = computeFeatureSignals(nothingPassing, o);
      const lineKnows = !line.includes("which aren't there at all");
      const headlineKnows = !headline.includes("Run a check to see what's built");
      expect(lineKnows).toBe(headlineKnows);
    }
  });
});

describe("the claim and the loop that backs it stay together", () => {
  test("the done-but-empty sentence is only reachable behind the scan flag", async () => {
    const src = await readSrc("lib/featureSignals.ts");
    const m = src.match(/Nothing looks done-but-empty/);
    expect(m).not.toBeNull();
    // Scope to the enclosing function, not a byte window — the guard has to
    // run before the sentence however long the arms get.
    const head = src.lastIndexOf("function riskGate", m!.index);
    expect(head).toBeGreaterThan(-1);
    expect(src.slice(head, m!.index)).toContain("scanned");
  });

  test("the stub and dead-end counters are the only thing the outcome feeds", () => {
    // If a future signal is counted from `outcome` it must join `scanned` too,
    // or the same false-absence returns under a different word. This asserts
    // the shape the guard was written against.
    const withStub = computeFeatureSignals(
      goal([run()]),
      outcome([check({ is_stub: true })]),
    ).risk;
    const withDead = computeFeatureSignals(
      goal([run()]),
      outcome([check({ must_call: "chargeCard", wired: false })]),
    ).risk;
    expect(withStub.value).toBe("Watch");
    expect(withDead.rationale).toContain("1 step nothing calls");
  });
});

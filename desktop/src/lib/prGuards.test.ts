import { describe, expect, test } from "bun:test";

import type { ReviewReport } from "./api";
import type { GoalRecord } from "./goalStore";
import type { ProveOutcome } from "./prove";
import { runPrGuards, type PrGuardDeps } from "./prGuards";

const PR = { branch: "feat/x", target: "main" };

function report(over: Partial<ReviewReport> = {}): ReviewReport {
  return {
    base_branch: "main",
    total_changes: 3,
    unverified_nodes: {},
    invariant_violations: [],
    blast_radius: [],
    cross_branch_conflicts: [],
    taste_findings: [],
    risk_score: 10,
    risk_label: "LOW",
    summary: "",
    findings: [],
    changes: [],
    ...over,
  };
}

function goal(id: string, updatedAt: number, over: Partial<GoalRecord> = {}): GoalRecord {
  return { id, text: `goal ${id}`, runs: [], createdAt: 0, updatedAt, ...over };
}

function outcome(verdict: ProveOutcome["verdict"]): ProveOutcome {
  return { goal: "g", checks: [], passed: 0, total: 0, verdict, error: null };
}

function deps(over: Partial<PrGuardDeps> = {}) {
  const calls: string[] = [];
  const d: PrGuardDeps = {
    review: async (_r, base) => {
      calls.push(`review:${base}`);
      return report();
    },
    goals: async () => [],
    prove: async (_r, text) => {
      calls.push(`prove:${text}`);
      return outcome("verified");
    },
    sign: async (_r, text) => {
      calls.push(`sign:${text}`);
      return { stdout: '{"signed_block_id":"b1","key_id":"k1"}\n', stderr: "", status: 0 };
    },
    ...over,
  };
  return { d, calls };
}

describe("the checks underneath Create PR", () => {
  test("a pass says nothing", async () => {
    const { d, calls } = deps();
    expect(await runPrGuards("/r1", PR, d)).toBeNull();
    expect(calls).toContain("review:main");
    expect(calls).toContain("sign:Opened a pull request for feat/x onto main");
  });

  test("a risky change or a broken rule is the safety line", async () => {
    for (const r of [report({ risk_label: "CRITICAL" }), report({ invariant_violations: ["layer"] })]) {
      const { d } = deps({ review: async () => r });
      expect((await runPrGuards("/r2", PR, d))?.kind).toBe("safety");
    }
  });

  test("nothing to review is not a failure", async () => {
    const { d } = deps({ review: async () => report({ status: "no_changes", risk_label: "CRITICAL" }) });
    expect(await runPrGuards("/r3", PR, d)).toBeNull();
  });

  test("a safety check that can't run says so", async () => {
    const { d } = deps({ review: async () => Promise.reject(new Error("no engine")) });
    expect((await runPrGuards("/r4", PR, d))?.line).toBe("The safety check couldn't run on this pull request.");
  });

  test("the three most recently touched goals are proved; hidden ones are not", async () => {
    const { d, calls } = deps({
      goals: async () => [
        goal("a", 1),
        goal("b", 5),
        goal("c", 4, { dismissed: true }),
        goal("d", 3),
        goal("e", 2),
      ],
    });
    await runPrGuards("/r5", PR, d);
    expect(calls.filter((c) => c.startsWith("prove:"))).toEqual(["prove:goal b", "prove:goal d", "prove:goal e"]);
  });

  test("a goal that isn't wired end to end is the goals line", async () => {
    const { d } = deps({
      goals: async () => [goal("a", 2), goal("b", 1)],
      prove: async () => outcome("not_wired"),
    });
    expect((await runPrGuards("/r6", PR, d))?.line).toBe("2 goals aren't working end to end yet.");
  });

  test("a partly wired goal or no goals at all is quiet", async () => {
    const partial = deps({ goals: async () => [goal("a", 1)], prove: async () => outcome("partial") });
    expect(await runPrGuards("/r7", PR, partial.d)).toBeNull();
    const none = deps({ goals: async () => [] });
    expect(await runPrGuards("/r7", PR, none.d)).toBeNull();
  });

  test("no signed block, or a failed signer, is the record line", async () => {
    for (const res of [
      { stdout: "{}\n", stderr: "", status: 0 },
      { stdout: "", stderr: "boom", status: 1 },
    ]) {
      const { d } = deps({ sign: async () => res });
      expect((await runPrGuards("/r8", PR, d))?.kind).toBe("record");
    }
  });

  test("with several failures the safety one is the line", async () => {
    const { d } = deps({
      review: async () => report({ risk_label: "CRITICAL" }),
      goals: async () => [goal("a", 1)],
      prove: async () => outcome("not_wired"),
      sign: async () => ({ stdout: "{}", stderr: "", status: 0 }),
    });
    expect((await runPrGuards("/r9", PR, d))?.kind).toBe("safety");
  });

  test("the lines name no tool or command", async () => {
    const lines: string[] = [];
    for (const over of [
      { review: async () => report({ risk_label: "CRITICAL" }) },
      { review: async () => Promise.reject(new Error("x")) },
      { goals: async () => [goal("a", 1)], prove: async () => outcome("not_wired") },
      { sign: async () => ({ stdout: "{}", stderr: "", status: 0 }) },
    ] satisfies Partial<PrGuardDeps>[]) {
      const f = await runPrGuards("/r10", PR, deps(over).d);
      if (f) lines.push(f.line);
    }
    expect(lines.length).toBe(4);
    for (const l of lines) expect(l).not.toMatch(/aura|pr-review|prove\b|attest|ledger|invariant|block/i);
  });
});

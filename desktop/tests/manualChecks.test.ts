// The steps only a person can do, and the record of what happened when they did.
//
//   bun test ./tests/manualChecks.test.ts
//
// A goal's verify plan carries lines Aura cannot run — "check the callback
// lands on a real handset". They rendered as empty squares that took no input
// and held no state, so when the agent stopped, the handset test stopped
// existing. These tests hold the record to three things: a step is awaiting a
// person from the moment the plan names it, nothing but a recorded human
// outcome moves it, and an outcome remembers which version of the code it was
// about.

import { beforeEach, describe, expect, it } from "bun:test";

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const store = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = store;

const {
  manualCheckId,
  manualChecksForRun,
  mergeManualChecks,
  readManualChecks,
  recordManualOutcome,
  reopenManualCheck,
  forgetManualCheck,
} = await import("../src/lib/manualChecks");

const REPO = "/Users/me/.aura/worktrees/antigua";
const RUN = "block_9f2";
const HANDSET = "Call the number and check the callback arrives on a real handset";

describe("a step only a person can carry out", () => {
  beforeEach(() => {
    store.clear();
  });

  it("exists as soon as the plan names it, with nobody having answered", () => {
    const merged = mergeManualChecks([], RUN, [HANDSET]);

    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe("awaiting");
    expect(merged[0].text).toBe(HANDSET);
    expect(merged[0].at).toBeNull();
  });

  it("keeps its identity across re-reads of the same plan on the same run", () => {
    const first = mergeManualChecks([], RUN, [HANDSET]);
    const again = mergeManualChecks([], RUN, [`  ${HANDSET.toUpperCase()}  `]);

    // Same step, differently typed. One outstanding item, not two.
    expect(again[0].id).toBe(first[0].id);
  });

  it("is a different step on a different run, because it is a different build", () => {
    expect(manualCheckId(RUN, HANDSET)).not.toBe(manualCheckId("block_aa1", HANDSET));
  });

  it("stays awaiting until a person records an outcome — nothing else moves it", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);

    // The run ends, the process exits, time passes. Re-read the plan.
    const later = mergeManualChecks(manualChecksForRun(REPO, RUN), RUN, [HANDSET]);

    expect(later[0].id).toBe(check.id);
    expect(later[0].state).toBe("awaiting");
  });

  it("records what the person saw, and the version they saw it on", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);

    const saved = recordManualOutcome(REPO, check, {
      state: "passed",
      note: "Rang through on the second try",
      revision: "a1b2c3d4e5",
      by: "Ashiq",
    });

    expect(saved.state).toBe("passed");
    expect(saved.revision).toBe("a1b2c3d4e5");
    expect(saved.by).toBe("Ashiq");
    expect(saved.at).toBeGreaterThan(0);

    const merged = mergeManualChecks(manualChecksForRun(REPO, RUN), RUN, [HANDSET]);
    expect(merged[0].state).toBe("passed");
    expect(merged[0].note).toBe("Rang through on the second try");
  });

  it("keeps a failure's symptom, which is the part the next person needs", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);
    recordManualOutcome(REPO, check, { state: "failed", note: "Silent — no callback in 5 min" });

    const merged = mergeManualChecks(manualChecksForRun(REPO, RUN), RUN, [HANDSET]);
    expect(merged[0].state).toBe("failed");
    expect(merged[0].note).toBe("Silent — no callback in 5 min");
  });

  it("records no version when the tester was on uncommitted work, rather than guessing one", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);
    const saved = recordManualOutcome(REPO, check, { state: "passed", revision: "  " });

    expect(saved.revision).toBeNull();
  });

  it("does not lose an answered step when the plan is edited underneath it", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);
    recordManualOutcome(REPO, check, { state: "failed", note: "no callback" });

    // The plan is rewritten and no longer carries that line. Somebody still did
    // that work and said what happened; the record is the only trace of it.
    const merged = mergeManualChecks(manualChecksForRun(REPO, RUN), RUN, [
      "Check it on a tablet",
    ]);

    expect(merged.map((c) => c.text)).toContain(HANDSET);
    expect(merged.find((c) => c.text === HANDSET)?.state).toBe("failed");
  });

  it("drops an unanswered step the plan no longer asks for", () => {
    const merged = mergeManualChecks([], RUN, ["Check it on a tablet"]);

    expect(merged.map((c) => c.text)).not.toContain(HANDSET);
  });

  it("reopening keeps the step and drops the claim", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);
    recordManualOutcome(REPO, check, { state: "passed", revision: "a1b2c3d", by: "Ashiq" });

    reopenManualCheck(REPO, check.id);

    const [after] = mergeManualChecks(manualChecksForRun(REPO, RUN), RUN, [HANDSET]);
    expect(after.state).toBe("awaiting");
    expect(after.at).toBeNull();
    expect(after.revision).toBeNull();
    expect(after.by).toBe("");
  });

  it("forgetting a step removes it outright — for a line that shouldn't have been asked", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);
    recordManualOutcome(REPO, check, { state: "passed" });

    forgetManualCheck(REPO, check.id);

    expect(manualChecksForRun(REPO, RUN)).toHaveLength(0);
  });

  it("keeps one repo's records out of another's", () => {
    const [check] = mergeManualChecks([], RUN, [HANDSET]);
    recordManualOutcome(REPO, check, { state: "passed" });

    expect(readManualChecks("/Users/me/other-project")).toHaveLength(0);
  });

  it("survives a corrupt or half-written store rather than taking the surface down", () => {
    store.setItem(`aura.manualChecks.${REPO}`, "{not json");

    expect(readManualChecks(REPO)).toEqual([]);
  });

  it("ignores rows that aren't steps at all", () => {
    store.setItem(`aura.manualChecks.${REPO}`, JSON.stringify([{ nonsense: true }, null]));

    expect(readManualChecks(REPO)).toEqual([]);
  });
});

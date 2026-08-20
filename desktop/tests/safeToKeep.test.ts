// Two safety verdicts that were computed from part of the evidence and
// stated as if they covered all of it.
//
//   bun test
//
// The PR rail's Safety check card draws FOUR counters — broken rules, ripple
// effects, unproven, branch clashes. The line that fires after a run counted
// the first and the third, so a review holding nine ripple effects and three
// branch clashes announced "Safety check done · all clear" while the grid
// directly underneath drew nine and three. The same line read its numbers off
// a payload typed `AuraReviewPayload | null`, and a null one made every count
// zero — the case where we know nothing produced the most confident sentence
// in the app. It goes to the OS as a toast, so it is read with the card out of
// view, by somebody deciding whether to merge.
//
// The Safety check dialog's lead said "Safe to keep — Nothing here looks risky
// — you're good to keep these changes" whenever two of its channels were zero,
// ignoring the engine's own risk_label. A change the engine called CRITICAL
// got "Safe to keep", and the CRITICAL tag beside it was painted green,
// because the tag took its colour from the verdict rather than the label.
//
// Neither surface grants permission now. Both report what was found, and both
// name what they could not reach.

import { describe, expect, test } from "bun:test";

import {
  REVIEW_CHANNELS,
  reviewFlash,
  verdictCopy,
} from "../src/lib/reviewVerdict";
import { stripComments as code } from "./support/code";
import type { AuraReviewPayload } from "../src/lib/api";

const EMPTY: AuraReviewPayload = {
  ts: 1_700_000_000,
  base_branch: "main",
  risk_score: 4,
  risk_label: "Low risk",
  total_changes: 3,
  invariant_violations: [],
  blast_radius: [],
  cross_branch_conflicts: [],
  omni_graph_impact: [],
  unverified_nodes: [],
};

const R = (over: Partial<AuraReviewPayload> = {}): AuraReviewPayload => ({
  ...EMPTY,
  ...over,
});

describe("the safety-check summary counts every channel the card draws", () => {
  test("a payload that never arrived is not an all-clear", () => {
    const s = reviewFlash(null);
    expect(s).toContain("Safety check ran");
    expect(s).toContain("Open this PR");
    // The two sentences the old code produced for this exact state.
    expect(s).not.toContain("all clear");
    expect(s).not.toContain("nothing flagged");
  });

  test("ripple effects and branch clashes reach the summary", () => {
    // The precise defect: zero broken rules, zero unproven, nine and three of
    // the two channels the summary never looked at.
    const s = reviewFlash(
      R({
        blast_radius: Array(9).fill("mod::fn"),
        cross_branch_conflicts: Array(3).fill("feat/x touches the same node"),
      }),
    );
    expect(s).toContain("9 ripple effects");
    expect(s).toContain("3 branch clashes");
    expect(s).not.toContain("nothing flagged");
  });

  test("each channel on its own is named, and named singularly at one", () => {
    const each = [
      [{ invariant_violations: ["x"] }, "1 broken rule"],
      [{ blast_radius: ["x"] }, "1 ripple effect"],
      [{ unverified_nodes: ["x"] }, "1 unproven"],
      [{ cross_branch_conflicts: ["x"] }, "1 branch clash"],
    ] as const;
    for (const [over, phrase] of each) {
      const s = reviewFlash(R(over));
      expect(s).toContain(phrase);
      expect(s).not.toContain("nothing flagged");
      // No accidental plural at one.
      expect(s).not.toContain(`${phrase}s`);
    }
  });

  test("a review that found nothing says so without calling it clear", () => {
    const s = reviewFlash(R());
    expect(s).toContain("nothing flagged");
    // "all clear" is a promise about the change; "nothing flagged" is a
    // statement about the check. Only one of those is ours to make.
    expect(s).not.toContain("all clear");
  });

  test("the risk score rides along, because the pill is not on screen", () => {
    // This string is also dispatched as an OS toast — the card that normally
    // states the risk can be out of view when it lands.
    expect(reviewFlash(R({ risk_score: 71 }))).toContain("risk 71/100");
    expect(reviewFlash(R({ risk_score: 0 }))).toContain("risk 0/100");
  });

  test("every channel the card can draw is a channel the summary can name", () => {
    // The invariant, stated positively: this is a fold over a union, and the
    // way it broke was naming a subset. Adding a fifth counter without a
    // fifth entry here is the same defect again.
    expect(REVIEW_CHANNELS.length).toBe(4);
    const keys = REVIEW_CHANNELS.map((c) => c.key);
    expect(new Set(keys).size).toBe(4);
    for (const ch of REVIEW_CHANNELS) {
      const s = reviewFlash(R({ [ch.key === "violations"
        ? "invariant_violations"
        : ch.key === "blast"
          ? "blast_radius"
          : ch.key === "unverified"
            ? "unverified_nodes"
            : "cross_branch_conflicts"]: ["a", "b"] } as Partial<AuraReviewPayload>));
      expect(s).toContain(`2 ${ch.many}`);
    }
  });

  test("a payload missing a field is not a payload with none of it", () => {
    // Older review JSONs predate fields. `items()` coerces, so a missing
    // array reads as empty rather than throwing — but it must not be counted.
    const partial = { ...R(), blast_radius: undefined } as unknown as AuraReviewPayload;
    expect(() => reviewFlash(partial)).not.toThrow();
    expect(reviewFlash(partial)).toContain("nothing flagged");
  });
});

describe("the safety-check dialog reports rather than grants permission", () => {
  const V = (over: Partial<Parameters<typeof verdictCopy>[0]> = {}) =>
    verdictCopy({ problems: 0, totalChanges: 3, risk: "LOW", unverified: 0, ...over });

  test("nothing found and nothing rated says exactly that", () => {
    const v = V();
    expect(v.headline).toBe("Nothing broken");
    expect(v.sub).toContain("found nothing wrong");
    expect(v.tone).toBe("good");
    expect(v.glyph).toBe("✓");
  });

  test("the app never tells you you're cleared to keep something", () => {
    const all = [
      V(),
      V({ risk: "MODERATE" }),
      V({ risk: "CRITICAL" }),
      V({ problems: 2 }),
      V({ unverified: 5 }),
      V({ problems: 1, risk: "CRITICAL", unverified: 9 }),
    ];
    for (const v of all) {
      const text = `${v.headline} ${v.sub}`;
      expect(text).not.toContain("Safe to keep");
      expect(text).not.toContain("you're good to keep");
      expect(text).not.toContain("Nothing here looks risky");
      // …and the old sub-line's other overclaim.
      expect(text).not.toContain("checked everything that changed");
    }
  });

  test("a CRITICAL rating outranks two empty counters", () => {
    const v = V({ risk: "CRITICAL" });
    expect(v.headline).toBe("Nothing broken, but it's a big change");
    expect(v.sub).toContain("critical");
    expect(v.tone).toBe("bad");
    expect(v.glyph).toBe("⚠");
  });

  test("MODERATE is said too, in its own tone", () => {
    const v = V({ risk: "MODERATE" });
    expect(v.headline).toBe("Nothing broken, but it's a big change");
    expect(v.sub).toContain("moderate");
    expect(v.tone).toBe("warn");
  });

  test("things Aura couldn't check are named in every state", () => {
    for (const over of [
      {},
      { risk: "MODERATE" as const },
      { risk: "CRITICAL" as const },
      { problems: 3 },
    ]) {
      const v = verdictCopy({
        problems: 0,
        totalChanges: 3,
        risk: "LOW",
        unverified: 4,
        ...over,
      });
      expect(v.sub).toContain("4 pieces it couldn’t check");
    }
    // One is singular, and zero says nothing at all.
    expect(V({ unverified: 1 }).sub).toContain("1 piece it couldn’t check");
    expect(V({ unverified: 0 }).sub).not.toContain("couldn’t check");
  });

  test("a clean check with unproven pieces is not a green tick", () => {
    // Green says "done, nothing to think about". Something it couldn't reach
    // is exactly something to think about.
    expect(V({ unverified: 0 }).tone).toBe("good");
    expect(V({ unverified: 2 }).tone).toBe("warn");
  });

  test("problems still lead, and still carry the count", () => {
    expect(V({ problems: 1 }).headline).toBe("1 thing worth a look");
    expect(V({ problems: 4 }).headline).toBe("4 things worth a look");
    expect(V({ problems: 4 }).glyph).toBe("⚠");
  });

  test("the four headlines are four different headlines", () => {
    const seen = new Set([
      V().headline,
      V({ risk: "CRITICAL" }).headline,
      V({ problems: 1 }).headline,
      V({ problems: 2 }).headline,
    ]);
    expect(seen.size).toBe(4);
  });
});

async function read(rel: string): Promise<string> {
  return code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());
}

describe("both surfaces render the verdicts their functions computed", () => {
  test("the PR rail's grid and its summary come from one list", async () => {
    const src = await read("components/pr/PrRightRail.tsx");
    // One Counter element, driven by the map. Four hand-written ones is how
    // the grid and the summary drifted apart in the first place.
    expect(src.split("<Counter").length - 1).toBe(1);
    expect(src).toContain("REVIEW_CHANNELS.map((ch)");
    expect(src).toContain("count={ch.items(review).length}");
    // The summary is the function, fed the payload that may be null.
    expect(src).toContain("reviewFlash(refreshed.aura_review)");
    // And the sentence it used to print exists nowhere.
    expect(src).not.toContain("all clear");
    // FindingList reads the same list rather than re-enumerating the four.
    expect(src).toContain("REVIEW_CHANNELS.find((c) => c.key === section)");
  });

  test("the dialog's lead is the function, fed the unproven count", async () => {
    const src = await read("components/dialogs/ReviewDialog.tsx");
    expect(src).toContain("verdictCopy({");
    // Pin the ARGUMENTS. A correct verdict fed `unverified: 0` is a dead
    // verdict — the whole caveat disappears with every test above green.
    expect(src).toContain("unverified={unverifiedTotal}");
    expect(src).toContain("unverified,");
    expect(src).toContain("risk: report.risk_label");
    // The risk tag takes its colour from the label, not from the verdict.
    // This is what painted a CRITICAL green.
    expect(src).toContain("style={{ color: riskTone(report.risk_label) }}");
    // Exactly one place decides the headline.
    expect(src.split("Safe to keep").length - 1).toBe(0);
  });
});

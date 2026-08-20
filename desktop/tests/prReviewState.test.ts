// "No semantic findings — clean review." — over findings sitting in the file.
//
//   bun test
//
// Three separate ways the PR Findings panel could say nothing was wrong
// without having looked:
//
//   1. The bridge struct `AuraReviewPayload` (cmd_prs.rs) didn't name
//      `taste_findings`. The engine writes that stream, the panel groups it
//      under "Taste", and serde dropped it in between. `risk_score` counts
//      those findings — so the header could show an elevated risk beside the
//      words "clean review".
//
//   2. `latest_aura_review` was `.ok()?` / `continue` all the way down: an
//      unreadable `.aura/reviews` directory, an unreadable file, and a review
//      written by a different build of the CLI all came back as `None`, and
//      `None` printed "No Aura review on disk for base X — run `aura
//      pr-review`". The advice was to re-run the command that produced the
//      file we'd just refused to read.
//
//   3. Every field of that struct is `#[serde(default)]`, so ANY JSON object
//      deserializes into a review with nothing in it — and a review with
//      nothing in it reads exactly like a clean one.
//
// The fold under test is the one place that decides what this panel is
// allowed to say. "Clean" has to be earned by a read that came back, from a
// payload we can identify, with every stream empty.

import { describe, expect, test } from "bun:test";

import {
  RAW_FINDING_STREAMS,
  countRawFindings,
  findingsByPath,
  rawFindingTexts,
  unverifiedTexts,
  countUnverified,
  hasHumanizedSurface,
  noFindingsLine,
  prReviewState,
  prReviewTotal,
} from "../src/lib/prReviewState";
import { stripComments as code } from "./support/code";
import type { AuraReviewPayload } from "../src/lib/api";

/** A review that ran and found nothing. */
const REVIEW = (over: Partial<AuraReviewPayload> = {}): AuraReviewPayload => ({
  ts: 1_700_000_000,
  base_branch: "main",
  risk_score: 4,
  risk_label: "LOW",
  total_changes: 2,
  invariant_violations: [],
  blast_radius: [],
  cross_branch_conflicts: [],
  omni_graph_impact: [],
  taste_findings: [],
  unverified_nodes: [],
  ...over,
});

const on = (over: Partial<AuraReviewPayload> = {}, err?: string) =>
  prReviewState({ review: REVIEW(over), reviewError: err, base: "main" });

describe("a read that failed is not a clean review", () => {
  test("the reviews directory being unreadable is said out loud", () => {
    const s = prReviewState({
      review: null,
      reviewError: "/r/.aura/reviews couldn't be read: permission denied",
      base: "main",
    });
    expect(s.kind).toBe("failed");
    if (s.kind !== "failed") throw new Error("unreachable");
    expect(s.message).toContain("permission denied");
    expect(s.title).not.toContain("clean");
  });

  test("a review this build can't parse is not an absent review", () => {
    // The reader skipped the file and reported why; the panel must not then
    // tell you to run the command that wrote it.
    const s = prReviewState({
      review: null,
      reviewError:
        "1 review file in /r/.aura/reviews couldn't be read by this build — the app and the aura CLI may be different versions. pr-1.json: unexpected shape",
      base: "main",
    });
    expect(s.kind).toBe("failed");
    if (s.kind !== "failed") throw new Error("unreachable");
    expect(s.message).toContain("different versions");
  });

  test("a payload with no base branch is a file we couldn't read", () => {
    // Every bridge field is `#[serde(default)]`: `{}` parses into a review.
    // An all-defaults payload is indistinguishable from a clean one, so the
    // one field a real review always carries has to be present.
    const s = prReviewState({
      review: REVIEW({ base_branch: "" }),
      base: "main",
    });
    expect(s.kind).toBe("unreadable");
    if (s.kind !== "unreadable") throw new Error("unreachable");
    expect(s.title).toContain("different version");
  });

  test("nothing on disk at all still gets the honest, useful answer", () => {
    const s = prReviewState({ review: null, reviewError: null, base: "dev" });
    expect(s.kind).toBe("absent");
    if (s.kind !== "absent") throw new Error("unreachable");
    expect(s.body).toContain("dev");
    // Plain language — this panel is read by people who didn't write the code.
    for (const jargon of ["AST", "JSON", ".aura", "--json", "serde"]) {
      expect(`${jargon}: ${(s.title + s.body).includes(jargon)}`).toBe(
        `${jargon}: false`,
      );
    }
  });

  test("no failed or unidentifiable read ever reaches a verdict", () => {
    const bad = [
      prReviewState({ review: null, reviewError: "boom", base: "main" }),
      prReviewState({ review: REVIEW({ base_branch: "" }), base: "main" }),
    ];
    for (const s of bad) {
      expect(s.kind).not.toBe("clean");
      expect(s.kind).not.toBe("humanized");
      expect(s.kind).not.toBe("raw");
      expect(prReviewTotal(s)).toBe(0);
    }
  });
});

describe("every stream the engine can fill is counted", () => {
  test("each raw stream on its own is enough to stop the all-clear", () => {
    for (const stream of RAW_FINDING_STREAMS) {
      const s = on({ [stream]: ["something the engine found"] });
      expect(`${stream}: ${s.kind}`).toBe(`${stream}: raw`);
      expect(`${stream}: ${prReviewTotal(s)}`).toBe(`${stream}: 1`);
    }
  });

  test("the taste stream is one of them", () => {
    // The whole defect: this stream existed, the panel grouped it, and the
    // Tauri bridge dropped it. If it ever leaves the list again, this fails.
    expect(RAW_FINDING_STREAMS).toContain("taste_findings");
    expect(countRawFindings(REVIEW({ taste_findings: ["a", "b"] }))).toBe(2);
  });

  test("blank entries aren't findings", () => {
    expect(countRawFindings(REVIEW({ blast_radius: ["", "  ", "real"] }))).toBe(1);
  });

  test("streams a stale payload omits entirely don't throw", () => {
    const partial = { base_branch: "main" } as unknown as AuraReviewPayload;
    expect(countRawFindings(partial)).toBe(0);
    expect(prReviewState({ review: partial, base: "main" }).kind).toBe("clean");
  });
});

describe("unverified work is not the same as clean work", () => {
  test("pieces the engine couldn't trace are said, not swallowed", () => {
    // `unverified_nodes` adds 20 to the risk score and no panel has ever
    // rendered it. Zero findings plus unverified nodes is not an all-clear.
    const s = on({ unverified_nodes: ["a::b", "c::d"] });
    expect(s.kind).toBe("clean");
    if (s.kind !== "clean") throw new Error("unreachable");
    expect(s.title).not.toBe("Nothing needs attention");
    expect(s.body).toContain("2 changed pieces");
  });

  test("the same sentence is used wherever the question is asked", () => {
    const one = noFindingsLine(1);
    expect(one.clean).toBe(false);
    expect(one.body).toContain("1 changed piece of code");
    const none = noFindingsLine(0);
    expect(none.clean).toBe(true);
    expect(none.body).toBeNull();
  });

  test("the count survives every shape the engine emits it in", () => {
    expect(countUnverified(["a", "b", "c"])).toBe(3);
    expect(countUnverified([{ path: "a.ts", node: "f" }])).toBe(1);
    expect(countUnverified({ "a.ts": 1, "b.ts": 2 })).toBe(2);
    expect(countUnverified(null)).toBe(0);
    expect(countUnverified(undefined)).toBe(0);
    expect(countUnverified("nonsense")).toBe(0);
  });

  test("a humanized review with no cards still carries the caveat", () => {
    const s = on({
      summary: "Two files changed; nothing risky stood out.",
      findings: [],
      unverified_nodes: ["x"],
    });
    expect(s.kind).toBe("humanized");
    if (s.kind !== "humanized") throw new Error("unreachable");
    expect(s.total).toBe(0);
    expect(s.unverified).toBe(1);
  });
});

describe("a review that genuinely ran clean is allowed to say so", () => {
  test("nothing found, nothing unverified", () => {
    const s = on();
    expect(s.kind).toBe("clean");
    if (s.kind !== "clean") throw new Error("unreachable");
    expect(s.title).toBe("Nothing needs attention");
    expect(s.body).toBeNull();
  });

  test("humanized cards win over the raw streams", () => {
    const s = on({
      summary: "One rule break.",
      findings: [
        {
          severity: "critical",
          category: "Invariant",
          title: "t",
          detail: "d",
          count: 3,
        },
      ],
      invariant_violations: ["raw copy of the same thing"],
    });
    expect(s.kind).toBe("humanized");
    expect(prReviewTotal(s)).toBe(3);
  });

  test("a per-file why counts as a humanized surface", () => {
    expect(
      hasHumanizedSurface(
        REVIEW({
          changes: [{ file: "a.ts", what: "changed", symbols: [], why: "because" }],
        }),
      ),
    ).toBe(true);
    expect(
      hasHumanizedSurface(
        REVIEW({ changes: [{ file: "a.ts", what: "changed", symbols: [] }] }),
      ),
    ).toBe(false);
  });
});

describe("the panel draws the verdict the fold computed", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  test("the findings panel is the fold, in the app's own primitives", async () => {
    const src = await read("components/workpanes/PRDetailPane.tsx");
    expect(src).toContain("prReviewState({");
    expect(src).toContain("reviewError: detail.aura_review_error");
    expect(src).toContain("prReviewTotal(state)");
    expect(src).toContain("<ErrorState");
    expect(src).toContain("<EmptyState");
    // Not one hand-written verdict left behind.
    expect(src).not.toContain("No semantic findings — clean review.");
    expect(src).not.toContain("Nothing needs attention — clean review.");
    expect(src).not.toContain("No Aura review on disk");
  });

  test("the risk chip can't sit beside a list we didn't draw", async () => {
    // `risk_score` counts findings — including the stream the bridge dropped.
    // A score next to an empty panel was the visible half of the bug.
    const src = (await read("components/workpanes/PRDetailPane.tsx")).replace(
      /\s+/g,
      "",
    );
    expect(src).toContain(
      'review&&(state.kind==="humanized"||state.kind==="raw")&&(',
    );
  });

  test("the empty-findings line has exactly one implementation", async () => {
    const src = await read("components/workpanes/PRDetailPane.tsx");
    expect(src).toContain("noFindingsLine(unverified)");
    expect((src.match(/function NoFindingsLine/g) ?? []).length).toBe(1);
    expect(src).toContain("unverified={state.unverified}");
  });
});

describe("the bridge carries every field the panel reads", () => {
  const rust = async () =>
    code(
      await Bun.file(
        `${import.meta.dir}/../src-tauri/src/cmd_prs.rs`,
      ).text(),
    );

  test("every raw stream is named in the Rust payload struct", async () => {
    // Crude on purpose. A field the frontend reads and the bridge doesn't
    // name is dropped silently by serde, and the panel calls the result
    // clean. That is exactly how this shipped.
    const src = await rust();
    const i = src.indexOf("pub struct AuraReviewPayload");
    const struct = src.slice(i, src.indexOf("}", i));
    for (const stream of RAW_FINDING_STREAMS) {
      expect(`${stream}: ${struct.includes(stream)}`).toBe(`${stream}: true`);
    }
    expect(struct).toContain("unverified_nodes");
  });

  test("the reader reports why it came back empty", async () => {
    const src = await rust();
    expect(src).toContain("pub aura_review_error: Option<String>");
    expect(src).toContain("fn parse_review(");
    // A missing directory is the one silent case — Aura has never run here.
    expect(src).toContain("ErrorKind::NotFound => return (None, None)");
    // …everything else travels.
    expect(src).toContain("skipped.push(");
    expect(src.replace(/\s+/g, "")).toContain(
      "let(aura,aura_review_error)=latest_aura_review(",
    );
  });

  test("an unidentifiable file is not filed as a review", async () => {
    const src = await rust();
    expect(src).toContain('value.get("base_branch")');
    // Both scan paths go through the same parse.
    expect((src.match(/parse_review\(&body\)/g) ?? []).length).toBe(2);
  });
});

describe("the badge on a file row", () => {
  // The file rows carry a small amber chip whose hover reads "Safety check: N
  // things worth a look in this file". It was folded from three of the five
  // streams — `invariant_violations`, `blast_radius`,
  // `cross_branch_conflicts` — so a file whose findings were all taste ones,
  // or all omni-graph ones, drew no chip while the panel above it counted
  // them. A row with no badge is not a row saying nothing was checked; it
  // reads as a clean file.
  const FILES = ["src/lib/api.ts", "src/lib/quiet.ts"];

  test("every stream the engine can fill reaches the badge", () => {
    for (const stream of RAW_FINDING_STREAMS) {
      const hits = findingsByPath(
        REVIEW({ [stream]: ["src/lib/api.ts: something to look at"] }),
        FILES,
      );
      expect(hits.get("src/lib/api.ts") ?? 0).toBe(1);
    }
  });

  test("the unnamed file gets no badge", () => {
    const hits = findingsByPath(
      REVIEW({ taste_findings: ["src/lib/api.ts: 4-space indent"] }),
      FILES,
    );
    expect(hits.has("src/lib/quiet.ts")).toBe(false);
  });

  test("findings in different streams add up on one file", () => {
    const hits = findingsByPath(
      REVIEW({
        invariant_violations: ["src/lib/api.ts breaks a layer rule"],
        taste_findings: ["src/lib/api.ts: 4-space indent"],
        omni_graph_impact: ["src/lib/api.ts is depended on by 3 crates"],
      }),
      FILES,
    );
    expect(hits.get("src/lib/api.ts")).toBe(3);
  });

  test("the unproven list still counts, in both shapes it comes in", () => {
    expect(unverifiedTexts(["src/lib/api.ts"])).toEqual(["src/lib/api.ts"]);
    expect(
      unverifiedTexts([{ path: "src/lib/api.ts", node: "sendIt" }]),
    ).toEqual(["src/lib/api.ts", "sendIt"]);
    // Not an array, or full of nothing — no invented hits.
    expect(unverifiedTexts({ a: 1 })).toEqual([]);
    expect(unverifiedTexts([" ", { path: "" }, 7])).toEqual([]);
  });

  test("no review means no badges, not zero findings", () => {
    expect(findingsByPath(null, FILES).size).toBe(0);
    expect(findingsByPath(undefined, FILES).size).toBe(0);
  });

  test("the count beside 'Findings' folds the same list", () => {
    // `countRawFindings` and the badge must not be able to disagree about
    // what a finding is — one of them reading three streams is how this
    // started.
    const r = REVIEW({
      invariant_violations: ["a"],
      cross_branch_conflicts: ["b"],
      blast_radius: ["c"],
      omni_graph_impact: ["d"],
      taste_findings: ["e"],
    });
    expect(rawFindingTexts(r)).toEqual(["a", "b", "c", "d", "e"]);
    expect(countRawFindings(r)).toBe(5);
    // Blank lines are not findings, in either.
    const blank = REVIEW({ invariant_violations: ["", "   "] });
    expect(rawFindingTexts(blank)).toEqual([]);
    expect(countRawFindings(blank)).toBe(0);
  });

  test("the PR surface holds no second copy of this fold", async () => {
    const src = code(
      await Bun.file("src/components/pr/PrFilesSection.tsx").text(),
    );
    expect(src).not.toContain("function deriveAuraByPath");
    expect(src).toContain("findingsByPath(");
    // The streams may only be named in one place.
    for (const stream of RAW_FINDING_STREAMS) {
      expect(src).not.toContain(`review.${stream}`);
    }
  });
});

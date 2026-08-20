// "Nothing here looks risky — no unfinished code, no deletions, no secrets."
//
//   bun test
//
// The safety line on a session's Alignment card, read by someone who did not
// write the code and cannot check it themselves. It was:
//
//     const nodes = deriveNodes(report);
//     const secrets = nodes.filter((n) => n.contains_secret).length;
//     const stubs   = nodes.filter((n) => n.is_stub).length;
//
// `deriveNodes` synthesises node records from the flat `modified_nodes` /
// `added_nodes` / `deleted_nodes` string arrays whenever `report.nodes` is
// absent. Those records have no `contains_secret` and no `is_stub` — so both
// filters returned nothing, and the card told a non-engineer there were no
// secrets in a run it had never looked inside.
//
// The CLI emits the flat arrays unconditionally and the structured nodes only
// for symbols it could resolve back to a parsed AST node, dropping the list
// entirely when none resolved (`intent_vs_actual.rs`). So the scan can be
// missing outright, or cover a strict subset while the card reports on all of
// it. Every claim here now travels with its coverage.

import { describe, expect, test } from "bun:test";

import {
  changeCounts,
  changeSummary,
  coverageCaveat,
  safetyLine,
  type SafetyReportLike,
} from "../src/lib/changeSafety";
import { stripComments as code } from "./support/code";

/** A run that changed three symbols across two files. */
const R = (over: Partial<SafetyReportLike> = {}): SafetyReportLike => ({
  modified_nodes: ["parseToken", "refresh"],
  added_nodes: ["signIn"],
  deleted_nodes: [],
  changed_files: ["src/auth.ts", "src/api.ts"],
  ...over,
});

/** The scan resolved all three and found nothing. */
const SCANNED = [
  { change: "modified", is_stub: false, contains_secret: false },
  { change: "modified", is_stub: false, contains_secret: false },
  { change: "added", is_stub: false, contains_secret: false },
];

describe("a scan that never ran is not a scan that found nothing", () => {
  test("no structured nodes at all means no all-clear", () => {
    // The exact shipped shape: flat arrays populated, `nodes` absent.
    const line = safetyLine(changeCounts(R()));
    expect(line.kind).toBe("unscanned");
    if (line.kind === "none") throw new Error("unreachable");
    expect(line.text).not.toContain("no secrets");
    expect(line.text).toContain("can’t tell you");
  });

  test("an empty node list is the same as no node list", () => {
    // The CLI drops `nodes` when the vec comes out empty; some producers send
    // `[]`. Both mean nothing was inspected.
    expect(safetyLine(changeCounts(R({ nodes: [] }))).kind).toBe("unscanned");
  });

  test("a partial scan says how partial", () => {
    const c = changeCounts(R({ nodes: SCANNED.slice(0, 2) }));
    expect(c.scanned).toBe(2);
    expect(c.total).toBe(3);
    const line = safetyLine(c);
    expect(line.kind).toBe("partial");
    if (line.kind === "none") throw new Error("unreachable");
    expect(line.text).toContain("2 of the 3");
    expect(line.text).not.toContain("no secrets");
  });

  test("a full scan that found nothing is allowed to say so", () => {
    const line = safetyLine(changeCounts(R({ nodes: SCANNED })));
    expect(line.kind).toBe("clean");
    if (line.kind === "none") throw new Error("unreachable");
    expect(line.text).toBe(
      "Nothing here looks risky. No unfinished code, no deletions, no secrets.",
    );
  });

  test("coverage is stated for every incomplete scan and no complete one", () => {
    expect(coverageCaveat(changeCounts(R({ nodes: SCANNED })))).toBeNull();
    expect(coverageCaveat(changeCounts(R()))).not.toBeNull();
    expect(coverageCaveat(changeCounts(R({ nodes: SCANNED.slice(0, 1) })))).not
      .toBeNull();
    // Nothing changed → nothing to be uncovered about.
    expect(
      coverageCaveat(
        changeCounts({
          modified_nodes: [],
          added_nodes: [],
          deleted_nodes: [],
          changed_files: [],
        }),
      ),
    ).toBeNull();
  });
});

describe("what the scan did find still leads", () => {
  test("a secret outranks everything, including the caveat", () => {
    const line = safetyLine(
      changeCounts(
        R({ nodes: [{ change: "modified", contains_secret: true }] }),
      ),
    );
    expect(line.kind).toBe("secrets");
    if (line.kind === "none") throw new Error("unreachable");
    expect(line.text).toContain("password or key");
    // …and it still admits it only looked at one of the three.
    expect(line.text).toContain("1 of the 3");
  });

  test("unfinished code and deletions are worth a look", () => {
    const line = safetyLine(
      changeCounts(
        R({
          deleted_nodes: ["oldHandler"],
          nodes: [
            { change: "modified", is_stub: true },
            { change: "modified" },
            { change: "added" },
            { change: "deleted" },
          ],
        }),
      ),
    );
    expect(line.kind).toBe("worth");
    if (line.kind === "none") throw new Error("unreachable");
    expect(line.text).toContain("1 unfinished bit");
    expect(line.text).toContain("1 deletion");
  });

  test("the second claim only appears when the scan covered everything", () => {
    // "Nothing else here looks risky." is itself a claim about the symbols it
    // didn't name — it may not be made over an incomplete scan.
    const full = safetyLine(
      changeCounts(
        R({
          deleted_nodes: ["gone"],
          nodes: [
            { change: "modified", is_stub: false, contains_secret: false },
            { change: "modified", is_stub: false, contains_secret: false },
            { change: "added", is_stub: false, contains_secret: false },
            { change: "deleted", is_stub: false, contains_secret: false },
          ],
        }),
      ),
    );
    if (full.kind === "none") throw new Error("unreachable");
    expect(full.text).toContain("Nothing else here looks risky.");

    const partial = safetyLine(
      changeCounts(R({ deleted_nodes: ["gone"], nodes: [{ change: "deleted" }] })),
    );
    if (partial.kind === "none") throw new Error("unreachable");
    expect(partial.text).not.toContain("Nothing else here looks risky.");
  });

  test("deletions survive a missing scan. They come from the flat array", () => {
    // The one signal of the three that never needed the structured nodes.
    const c = changeCounts(R({ deleted_nodes: ["dropTable"] }));
    expect(c.deletions).toBe(1);
    expect(safetyLine(c).kind).toBe("worth");
  });

  test("an undefined flag is never read as a false one", () => {
    const c = changeCounts(
      R({ nodes: [{ change: "modified" }, { change: "modified" }, { change: "added" }] }),
    );
    // Three nodes, none carrying a verdict either way. That is a scan result
    // of "unknown", not of "clean" — the counts say zero, and the coverage
    // check is what stops the all-clear.
    expect(c.secrets).toBe(0);
    expect(c.stubs).toBe(0);
    expect(c.scanned).toBe(3);
  });
});

describe("how much changed is counted from the authoritative set", () => {
  test("a partial scan doesn't shrink the change count", () => {
    // The card read `nodes.length`, so an incomplete scan also under-reported
    // how much the AI had changed.
    const c = changeCounts(R({ nodes: SCANNED.slice(0, 1) }));
    expect(c.total).toBe(3);
    expect(changeSummary(c)).toBe("The AI changed 3 things across 2 files.");
  });

  test("files with no symbols still get a sentence", () => {
    const c = changeCounts({
      modified_nodes: [],
      added_nodes: [],
      deleted_nodes: [],
      changed_files: ["README.md"],
    });
    expect(changeSummary(c)).toContain("touched 1 file");
    expect(safetyLine(c).kind).toBe("none");
  });

  test("a run with nothing recorded says exactly that", () => {
    const c = changeCounts({
      modified_nodes: [],
      added_nodes: [],
      deleted_nodes: [],
      changed_files: [],
    });
    expect(changeSummary(c)).toBe("No file changes were recorded for this run.");
    expect(safetyLine(c).kind).toBe("none");
  });

  test("singulars and plurals both read as English", () => {
    expect(
      changeSummary(
        changeCounts({
          modified_nodes: ["one"],
          added_nodes: [],
          deleted_nodes: [],
          changed_files: ["a.ts"],
        }),
      ),
    ).toBe("The AI changed 1 thing across 1 file.");
  });
});

describe("the card draws the line the fold computed", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  /** The overview card's own body, not the whole file. `ChangedSection` below
   *  it reads `n.contains_secret` and `n.is_stub` legitimately — it draws a
   *  per-symbol badge from a node that carries the flag. Scoping to the
   *  function is the difference between a guard and a nuisance. */
  const overview = async () => {
    const src = await read("components/workpanes/SessionAlignment.tsx");
    const i = src.indexOf("function ChangeOverview");
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf("\nfunction ", i + 1);
    return src.slice(i, j === -1 ? undefined : j);
  };

  test("the overview is the fold, not its own arithmetic", async () => {
    const body = await overview();
    expect(body).toContain("changeCounts(report)");
    expect(body).toContain("safetyLine(counts)");
    expect(body).toContain("changeSummary(counts)");
    // Not one hand-rolled verdict left behind.
    expect(body).not.toContain("Nothing here looks risky");
    expect(body).not.toContain("no unfinished code, no deletions, no secrets");
    // The two filters that answered without looking.
    expect(body).not.toContain("contains_secret");
    expect(body).not.toContain("is_stub");
    // …and the card no longer derives nodes at all, so it can't count the
    // scanned subset and print it as what changed.
    expect(body).not.toContain("deriveNodes");
    // The old sentence-builder went with them.
    expect(await read("components/workpanes/SessionAlignment.tsx")).not.toContain(
      "function joinWorth",
    );
  });

  test("every tone the fold can return can be painted", async () => {
    const body = await overview();
    for (const tone of ["risk", "attention", "calm"]) {
      expect(`${tone}: ${body.includes(tone + ":")}`).toBe(`${tone}: true`);
    }
    expect(body).toContain("TONE_COLOR[line.tone]");
    // Every branch of the union has a tone, so an unhandled one is a compile
    // error rather than an unpainted line — but the card must still not draw
    // an empty paragraph for `none`.
    expect(body.replace(/\s+/g, "")).toContain('line.kind!=="none"&&(');
  });

  test("no engineering vocabulary reaches the card's copy", async () => {
    // This surface is explicitly written for people who didn't write the code.
    const src = await read("lib/changeSafety.ts");
    const strings = src.match(/"[^"]{20,}"|`[^`]{20,}`/g) ?? [];
    for (const s of strings) {
      for (const jargon of ["AST", "Merkle", "serde", "NodeRef", "identifier"]) {
        expect(`${jargon} in ${s.slice(0, 40)}: ${s.includes(jargon)}`).toBe(
          `${jargon} in ${s.slice(0, 40)}: false`,
        );
      }
    }
  });
});

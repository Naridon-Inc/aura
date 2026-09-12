// The card is the desktop app's; the fold it draws is shared with the web
// console. So this scan lives here, beside the component it pins, while the
// arithmetic it calls is tested next to itself in `aura-shared/`.
//
//   bun test tests/changeSafetyCard.test.ts

import { describe, expect, test } from "bun:test";

import { stripComments as code } from "./support/code";

describe("the card draws the line the fold computed", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  /** The fold itself, which is no longer part of this app. */
  const readShared = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../../aura-shared/${rel}`).text());

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
    const src = await readShared("changeSafety.ts");
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

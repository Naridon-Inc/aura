// The page states which work it describes, and every button states its target.
//
//   bun test ./tests/whichWorkThisDescribes.test.ts
//
// The words are tested next door on plain data. What that cannot catch is the
// version where the sentences exist and the page still builds them from the
// wrong place — from the checkout in front of the reader rather than from the
// record being read. That substitution is the whole failure this pins.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

describe("the record says where it came from", () => {
  it("builds its scope from the record, never from the current checkout", async () => {
    const src = await readSrc("components/workpanes/SessionSummary.tsx");
    const from = src.indexOf("const scope: ReviewScope");
    const scope = src.slice(from, src.indexOf("return (", from));

    expect(scope).toContain("branch: row.branch ?? null");
    expect(scope).toContain("worktree: row.worktree ?? null");
    expect(scope).toContain("revision: atCommit ?? null");
  });

  it("shows where and which version, in the details a reader can check", async () => {
    const src = await readSrc("components/workpanes/SessionSummary.tsx");

    expect(src).toContain('<MetaRow label="Where">');
    expect(src).toContain('<MetaRow label="Version">');
    expect(src).toContain("whereItHappened(scope)");
  });
});

describe("an action says what it will touch", () => {
  it("tells the reader the checks run on the checkout, on both surfaces", async () => {
    const evidence = await readSrc("components/workpanes/SessionEvidence.tsx");
    const outstanding = await readSrc("components/workpanes/SessionOutstanding.tsx");

    expect(evidence).toContain('actionTarget("checks", scope, working)');
    expect(outstanding).toContain("actionTarget(targetKind(item)!, scope, working)");
  });

  it("reads the working tree through the shared reader that refuses to guess", async () => {
    const src = await readSrc("lib/useWorkingTarget.ts");

    expect(src).toContain("fetchAheadBehind");
    expect(src).toContain("fetchDiffStats");
    // A failed git read must leave the page silent about the checkout, not
    // describe it as a clean tree on no branch.
    const failure = src.slice(src.indexOf("} catch {"));
    expect(failure).toContain("setTarget(UNKNOWN)");
    expect(src).toContain("known: false");
  });
});

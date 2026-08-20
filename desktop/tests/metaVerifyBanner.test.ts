// "Verified on this clone" — over proofs whose own verdict said not_wired.
//
//   bun test
//
// The strongest claim in the app, in green, under a shield. It was gated on
// `report.ok && report.proven > 0`, and the engine counted `proven` for any
// proof note that parsed:
//
//     let proof = note_body(repo, PROOF_REF, oid).and_then(parse_proof_note);
//     match &proof { Some(p) => { proven += 1; … } }
//
// A proof note records a verdict — "verified", "partial", "not_wired" or
// "unknown". A commit whose goals were never wired up carries a note saying
// so, and it counted as proven. The struct's own doc comment claimed the
// field meant "commits whose stated goals were proven"; the CLI test beside
// it asserted `v.proven == 1` with the comment "a proof note is still
// present". Two different meanings, one number, and the app rendered the
// generous one.
//
// Two more in the same fold: a note this build can't parse folded into the
// same `None` as "no proof recorded", so an unreadable file kept the report
// ok; and the 200-commit walk cap made `commits` read as the size of the
// repo.

import { describe, expect, test } from "bun:test";

import {
  gradesVerdicts,
  verifyBanner,
  type VerifyReportLike,
} from "../src/lib/metaVerifyBanner";
import { stripComments as code } from "./support/code";

/** A report from a current engine: 10 commits, all graded, nothing wrong. */
const R = (over: Partial<VerifyReportLike> = {}): VerifyReportLike => ({
  commits: 10,
  intent_covered: 10,
  proofs: 0,
  proven: 0,
  partial: 0,
  issues: [],
  ok: true,
  truncated: false,
  ...over,
});

describe("green is earned by a verdict, not by a file existing", () => {
  test("proofs that all say not_wired never reach the green state", () => {
    // The exact shipped shape: three proof notes on disk, every one of them
    // reporting that the work isn't wired up.
    const b = verifyBanner(R({ proofs: 3, proven: 0, partial: 0 }));
    expect(b.tone).not.toBe("ok");
    expect(b.title).not.toContain("Verified");
    // …and it says what it actually found, rather than going quiet.
    expect(b.detail).toContain("3 of 10 changes");
    expect(b.detail).toContain("none of them found the work finished");
  });

  test("a verified verdict does earn it", () => {
    const b = verifyBanner(R({ proofs: 4, proven: 4 }));
    expect(b.tone).toBe("ok");
    expect(b.title).toBe("Verified on this copy");
    expect(b.detail).toBe("4 of 10 changes proven");
  });

  test("partial proofs are neither hidden nor promoted", () => {
    const green = verifyBanner(R({ proofs: 4, proven: 3, partial: 1 }));
    expect(green.tone).toBe("ok");
    expect(green.detail).toBe("3 of 10 changes proven, 1 partly");

    const amberless = verifyBanner(R({ proofs: 2, proven: 0, partial: 2 }));
    expect(amberless.tone).toBe("calm");
    expect(amberless.title).toBe("Partly proven");
    expect(amberless.detail).toContain("none all of it");
  });

  test("no proofs at all is a different sentence from failed proofs", () => {
    const none = verifyBanner(R({ proofs: 0, intent_covered: 7 }));
    expect(none.title).toBe("Nothing needs a look");
    expect(none.detail).toBe("7 of 10 changes carry a reason");

    const failed = verifyBanner(R({ proofs: 7 }));
    expect(failed.title).not.toBe(none.title);
  });
});

describe("an older engine can't be read as good news", () => {
  test("a report with no verdict counts is detected, not defaulted", () => {
    // `aura` on PATH can be older than the app. Its `proven` means "a proof
    // note is here" — the very number that caused this bug.
    const old: VerifyReportLike = {
      commits: 10,
      intent_covered: 10,
      proven: 6,
      issues: [],
      ok: true,
    };
    expect(gradesVerdicts(old)).toBe(false);
    const b = verifyBanner(old);
    expect(b.tone).not.toBe("ok");
    expect(b.title).not.toContain("Verified");
    expect(b.detail).toContain("can’t read the verdict");
    expect(b.detail).toContain("Update Aura");
  });

  test("an older engine with nothing recorded still reads calmly", () => {
    const b = verifyBanner({
      commits: 4,
      intent_covered: 4,
      proven: 0,
      issues: [],
      ok: true,
    });
    expect(b.tone).toBe("calm");
    expect(b.title).toBe("Nothing needs a look");
  });

  test("a zero is not the same as a missing field", () => {
    expect(gradesVerdicts(R({ proofs: 0 }))).toBe(true);
    expect(gradesVerdicts({ ...R(), proofs: undefined })).toBe(false);
  });
});

describe("what needs a look wins, and how much was looked at is stated", () => {
  test("issues outrank every other state", () => {
    const b = verifyBanner(
      R({
        proofs: 9,
        proven: 9,
        ok: false,
        issues: ["abc1234: proof note binds to 000… but is attached to abc…"],
      }),
    );
    expect(b.tone).toBe("warn");
    expect(b.title).toBe("1 thing needs a look");
    expect(b.detail).toContain("binds to");
  });

  test("a capped walk says so instead of reading as the whole history", () => {
    // The engine stops at 200 commits. "12 of 200 proven" beside "Verified on
    // this copy" is a claim about a repo that may have 5,000 commits in it.
    const b = verifyBanner(R({ commits: 200, proofs: 12, proven: 12, truncated: true }));
    expect(b.tone).toBe("ok");
    expect(b.scope).toContain("most recent 200 changes");
    expect(b.scope).toContain("more history before that");
  });

  test("a complete walk claims no scope it doesn't need", () => {
    expect(verifyBanner(R({ proofs: 1, proven: 1 })).scope).toBeNull();
  });

  test("singulars read as English", () => {
    const b = verifyBanner(R({ commits: 1, proofs: 1, proven: 1 }));
    expect(b.detail).toBe("1 of 1 change proven");
    const w = verifyBanner(R({ ok: false, issues: ["one"] }));
    expect(w.title).toBe("1 thing needs a look");
    const w2 = verifyBanner(R({ ok: false, issues: ["one", "two"] }));
    expect(w2.title).toBe("2 things need a look");
  });
});

describe("the panel draws the state the fold computed", () => {
  const read = async (rel: string) =>
    code(await Bun.file(`${import.meta.dir}/../src/${rel}`).text());

  test("the banner is the fold, with no verdict of its own", async () => {
    const src = await read("components/commons/MeaningPlanePanel.tsx");
    expect(src).toContain("verifyBanner(report)");
    // Every hand-written claim is gone.
    expect(src).not.toContain("Verified on this clone");
    expect(src).not.toContain("report.ok && report.proven > 0");
    expect(src).not.toContain("report.intent_covered} of {report.commits}");
  });

  test("the scope note has somewhere to render", async () => {
    const src = (await read("components/commons/MeaningPlanePanel.tsx")).replace(
      /\s+/g,
      "",
    );
    expect(src).toContain("banner.scope&&(");
  });
});

describe("the engine counts what the panel prints", () => {
  const rust = async () =>
    code(
      await Bun.file(
        `${import.meta.dir}/../../aura-cli/src/meta_refs_notes.rs`,
      ).text(),
    );

  test("proven is incremented only on a verified verdict", async () => {
    const src = (await rust()).replace(/\s+/g, "");
    expect(src).toContain('"verified"=>proven+=1');
    expect(src).toContain('"partial"=>partial+=1');
    // The old unconditional increment must not come back.
    expect(src).not.toContain("Some(p)=>{proven+=1;");
  });

  test("the report carries every field the banner reads", async () => {
    const src = await rust();
    const i = src.indexOf("pub struct VerifyReport");
    const struct = src.slice(i, src.indexOf("\n}", i));
    for (const field of ["proofs", "proven", "partial", "truncated", "issues"]) {
      expect(`${field}: ${struct.includes(field)}`).toBe(`${field}: true`);
    }
  });

  test("an unreadable proof note is reported, not folded into 'none'", async () => {
    const src = await rust();
    expect(src).toContain("can't read it");
    expect(src.replace(/\s+/g, "")).toContain("truncated=true;");
  });
});

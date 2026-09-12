// Run with: bun test src/components/workpanes/bringBack.test.ts
//
// AURA-1367. The "Bring this back" button reported a recovery that had not
// happened, could rewrite a piece nobody chose, and showed nothing of what it
// was about to do. Each test below is one of those.

import { describe, expect, test } from "bun:test";

import {
  applyArgs,
  previewArgs,
  readApply,
  readPreview,
  type CliRun,
} from "./bringBack";

const run = (over: Partial<CliRun>): CliRun => ({
  stdout: "",
  stderr: "",
  status: 0,
  ...over,
});

describe("what we ask the engine", () => {
  test("a preview is asked for as a preview, and undo is a different question", () => {
    expect(previewArgs("total", "src/bill.rs")).toEqual([
      "rewind",
      "total",
      "src/bill.rs",
      "--preview",
      "--json",
    ]);
    expect(previewArgs("total", "src/bill.rs", true)).toContain("--undo");
    expect(applyArgs("total", "src/bill.rs")).not.toContain("--preview");
    expect(applyArgs("total", "src/bill.rs", true)).toEqual([
      "rewind",
      "total",
      "src/bill.rs",
      "--json",
      "--undo",
    ]);
  });
});

describe("reading a preview", () => {
  test("both versions come back, described in words a person can approve", () => {
    const res = run({
      stdout: JSON.stringify({
        ok: true,
        applied: false,
        identifier: "total",
        file: "src/bill.rs",
        deleted: false,
        origin: "commit HEAD~2 (abc12345)",
        origin_plain: "2 moments back",
        current: "fn total() { 0 }",
        restored: "fn total() { sum() }",
        no_change: false,
        undo: false,
      }),
    });
    const out = readPreview(res, "total", "src/bill.rs");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.current).toBe("fn total() { 0 }");
    expect(out.plan.restored).toBe("fn total() { sum() }");
    // The engineer's phrasing is available but not the one we show.
    expect(out.plan.origin).toBe("2 moments back");
  });

  test("a name that means two things is a refusal, not a guess", () => {
    const message =
      "'Job' names 2 different things in src/job.rs, so Aura can't tell which one you mean:\n  line 1: struct Job {\n  line 5: impl Job {\nNothing was changed.";
    const res = run({
      status: 1,
      stdout: JSON.stringify({ ok: false, reason: "ambiguous", message }),
    });
    const out = readPreview(res, "Job", "src/job.rs");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The engine already listed the candidates and their lines; we show that
    // rather than inventing a shorter, vaguer version of it.
    expect(out.message).toContain("line 1: struct Job {");
    expect(out.message).toContain("Nothing was changed");
  });

  test("a recovery that would change nothing is not offered as one", () => {
    const res = run({
      stdout: JSON.stringify({
        ok: true,
        applied: false,
        identifier: "total",
        file: "src/bill.rs",
        current: "fn total() { 0 }",
        restored: "fn total() { 0 }",
        no_change: true,
      }),
    });
    const out = readPreview(res, "total", "src/bill.rs");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain("nothing to bring back");
  });

  test("an engine too old to preview says so, instead of reading as a failed recovery", () => {
    const res = run({
      status: 2,
      stderr: "error: unexpected argument '--preview' found\n\nUsage: aura rewind ...",
    });
    const out = readPreview(res, "total", "src/bill.rs");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain("newer version of the Aura engine");
  });
});

describe("reading the run that writes", () => {
  test("exit 0 is not proof — the engine has to say it applied something", () => {
    // Exactly the shape the old engine produced: it printed that it had
    // aborted and then exited 0, and the banner painted green over it.
    const res = run({
      status: 0,
      stdout: JSON.stringify({
        ok: false,
        reason: "apply_failed",
        message:
          "Rewind aborted: none of the 3 saved version(s) of 'total' could be put back — nothing was written.",
      }),
    });
    const out = readApply(res, "total");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain("nothing was written");
  });

  test("ok without applied is still not a recovery", () => {
    const res = run({ stdout: JSON.stringify({ ok: true, applied: false }) });
    expect(readApply(res, "total").ok).toBe(false);
  });

  test("a real recovery reports where the version came from", () => {
    const res = run({
      stdout: JSON.stringify({
        ok: true,
        applied: true,
        origin: "snapshot from 1789045284657 (trigger: pre_rewind)",
        origin_plain: "the copy Aura kept just before it last brought this back",
        safety_snapshot: "src__bill.rs__1789045284657.json",
      }),
    });
    const out = readApply(res, "total");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.origin).toBe("the copy Aura kept just before it last brought this back");
    expect(out.origin).not.toContain("1789045284657");
  });

  test("no output at all is a failure with the engine's own words", () => {
    const res = run({ status: 1, stderr: "Couldn't open src/bill.rs to bring it back: No such file" });
    const out = readApply(res, "total");

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain("Couldn't open");
  });
});

// The undo list only offers to undo what it can actually undo.
//
// Two sets have to agree and they live in different languages. The engine
// WRITES eight kinds (the `record_op` call sites in cmd_aura.rs,
// cmd_conflicts.rs and agent_mutation_guard.rs) and REVERSES six (the match in
// `apply_undo`, op_log.rs:147-155) — and the six are not a subset of the eight:
// `zone_claim` has an inverse nobody records, while conflict_open,
// conflict_resolve and guard_revert get recorded with no inverse at all.
//
// The dialog didn't know any of that. It armed its button with the newest
// un-undone row whatever its kind, so settling a merge conflict left a lit
// "Undo: conflict_resolve" button that answered the press with the engine's
// own "no inverse implemented for op kind 'conflict_resolve'".
//
// src/lib/opKinds.ts is the frontend's copy of both facts, which makes it a
// fork, which is why this file exists: it reads the Rust and checks the copy
// still matches. Add an arm to `apply_undo` and the button starts offering it
// only once someone lists it here; add a `record_op` kind and the suite says it
// has no plain-language name yet.

import { expect, test, describe } from "bun:test";
import { OP_KIND_LABEL, UNDOABLE_OP_KINDS } from "../src/lib/opKinds";
import { stripComments } from "./support/code";

const ROOT = `${import.meta.dir}/..`;
const RUST = `${ROOT}/src-tauri/src`;

/** The kinds `apply_undo` implements an inverse for. */
async function rustUndoableKinds(): Promise<string[]> {
  const src = await Bun.file(`${RUST}/op_log.rs`).text();
  const body = src.slice(src.indexOf("pub fn apply_undo"));
  const match = body.slice(
    body.indexOf("match entry.kind.as_str()"),
    body.indexOf("other =>"),
  );
  return [...match.matchAll(/"([a-z_]+)"\s*=>/g)].map((m) => m[1]);
}

/** The kinds anything in the app actually writes to the log. */
async function rustRecordedKinds(): Promise<string[]> {
  const kinds = new Set<string>();
  for await (const rel of new Bun.Glob("**/*.rs").scan({ cwd: RUST })) {
    if (rel === "op_log.rs") continue; // the definition, not a call site
    const src = await Bun.file(`${RUST}/${rel}`).text();
    for (const m of src.matchAll(/record_op\(\s*&?repo_root,\s*"([a-z_]+)"/g)) {
      kinds.add(m[1]);
    }
  }
  return [...kinds];
}

describe("the button offers what the engine can reverse", () => {
  test("the undoable list is the Rust match, exactly", async () => {
    const rust = await rustUndoableKinds();
    expect(rust.length).toBeGreaterThan(0); // the parse itself has to work
    expect([...UNDOABLE_OP_KINDS].sort()).toEqual([...rust].sort());
  });

  test("kinds with no inverse are not in it", async () => {
    // Named rather than derived: these three are recorded and cannot be undone,
    // and if that ever changes it should change deliberately.
    for (const kind of ["conflict_open", "conflict_resolve", "guard_revert"]) {
      expect(UNDOABLE_OP_KINDS).not.toContain(kind);
    }
  });
});

describe("every step in the list has a name a person can read", () => {
  test("every recorded kind has one", async () => {
    const recorded = await rustRecordedKinds();
    expect(recorded.length).toBeGreaterThan(0);
    for (const kind of recorded) expect(OP_KIND_LABEL[kind]).toBeString();
  });

  test("every undoable kind has one", () => {
    for (const kind of UNDOABLE_OP_KINDS) {
      expect(OP_KIND_LABEL[kind]).toBeString();
    }
  });

  test("no label is the engine tag with the underscores left in", () => {
    for (const [kind, label] of Object.entries(OP_KIND_LABEL)) {
      expect(label).not.toContain("_");
      expect(label.toLowerCase()).not.toBe(kind);
    }
  });

  test("the dialog renders the label, never the raw kind", async () => {
    const src = await Bun.file(
      `${ROOT}/src/components/dialogs/OpLogDialog.tsx`,
    ).text();
    // `{op.kind}` / `${target.kind}` printed straight into the row and the
    // button is how "intent_attribute" reached the screen in the first place.
    expect(src).not.toMatch(/\{\s*op\.kind\s*\}/);
    expect(src).not.toMatch(/\$\{\s*(?:op|target)\.kind\s*\}/);
  });
});

describe("the list doesn't claim to hold more than it holds", () => {
  test("nothing says every change Aura makes is in here", async () => {
    const src = stripComments(
      await Bun.file(`${ROOT}/src/components/dialogs/OpLogDialog.tsx`).text(),
    );
    const offenders: string[] = [];
    // Not one of the eight kinds is an agent editing your code. The empty state
    // said otherwise, and it's the sentence a frightened person reads first.
    const OVERCLAIM =
      /\b(?:every|all|each|any)\b[^.]{0,30}\bchang\w*\b[^.]{0,40}\b(?:record|logged|saved|here)\b|\beverything (?:Aura|it) (?:does|did)\b/i;
    for (const lit of src.matchAll(
      /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    )) {
      const text = lit[0].slice(1, -1).replace(/\$\{[^}]*\}/g, "…");
      if (text.length < 16 || !/[a-z] [a-z]/.test(text)) continue;
      if (OVERCLAIM.test(text)) offenders.push(text.slice(0, 80));
    }
    expect(offenders).toEqual([]);
  });
});

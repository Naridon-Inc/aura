// Where a row's "why" came from, held to what the guard actually stamps.
//
//   bun test
//
// The guard resolves a reason from three places and records which one it used
// on `changeset.source` (agent_mutation_guard.rs:510-522):
//
//   session_prompt   the user's own words, read out of the live transcript
//   brain_inferred   Aura's model, handed the diff and asked to write the reason
//   guard_auto_stub  nothing available — "<agent> edited N file(s)"
//
// Until now the screen read exactly one of those three: `isAutoStub` tests for
// `guard_auto_stub`. The other two arrived identical — a sentence under the
// heading "Reason", inside a card reading "Aura locked exactly what the AI
// changed and why". So a line a model wrote FROM the diff was presented as the
// reason FOR the diff, and it is the one line in the log that can never fail
// the Intent ↔ AST check, because it was written from the AST.
//
// Two classes of defect are guarded here, and they are different:
//
//   1. the engine stamps a source the UI has never heard of (drift), and
//   2. the UI has heard of it and still calls it a reason (the original bug).
//
// (1) is caught by parsing the Rust. (2) is caught by calling the functions.

import { describe, expect, test } from "bun:test";

import {
  displayedProvenance,
  intentProvenance,
  provenanceLabel,
  provenanceNote,
  provenanceTag,
  sessionDisplayTitle,
  titleProvenance,
  type IntentProvenance,
} from "../src/lib/sessionMeta";
import type { ClaudeSession, IntentRow } from "../src/lib/api";
import { stripComments } from "./support/code";

const SRC = `${import.meta.dir}/../src`;
const GUARD_RS = `${import.meta.dir}/../src-tauri/src/agent_mutation_guard.rs`;


// Fresh regex per call — a shared global one carries `lastIndex` out of an
// `exec` and into the next `matchAll`, which silently skips the front of the
// next input. That is how a scan in this suite once passed with its defect in.
const snakeLiterals = (s: string) => s.matchAll(/"([a-z_]+)"/g);

/** The `stub_source` tags the guard can write, read out of the Rust. */
async function rustSources(): Promise<string[]> {
  const rs = await Bun.file(GUARD_RS).text();
  const open = rs.indexOf("let (stub_intent, stub_source) = match session_prompt");
  expect(open).toBeGreaterThan(-1); // ANCHOR: the guard's source-resolution match
  const close = rs.indexOf("let captured_reason", open);
  expect(close).toBeGreaterThan(open); // ANCHOR: the line just past that match
  // The one non-tag literal in the block is the last-resort `format!`, which is
  // not snake_case and so cannot match. Everything else in here is a tag.
  return [...snakeLiterals(rs.slice(open, close))].map((m) => m[1]);
}

/** The sources `intentProvenance` knows by name, read out of its switch. */
async function tsSources(): Promise<string[]> {
  const ts = stripComments(await Bun.file(`${SRC}/lib/sessionMeta.ts`).text());
  const open = ts.indexOf("export function intentProvenance");
  expect(open).toBeGreaterThan(-1); // ANCHOR: intentProvenance
  const close = ts.indexOf("export function provenanceLabel", open);
  expect(close).toBeGreaterThan(open); // ANCHOR: provenanceLabel follows it
  return [...ts.slice(open, close).matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
}

function row(source: string | null, intent = "Tightened the retry budget"): IntentRow {
  return {
    intent,
    changeset: source === null ? null : ({ source } as IntentRow["changeset"]),
  } as IntentRow;
}

const ALL: IntentProvenance[] = ["stated", "asked", "inferred", "uncaptured"];

describe("the engine and the screen agree on where a why came from", () => {
  test("the UI knows every source the guard can stamp", async () => {
    const rust = await rustSources();
    // If this ever shrinks below three the anchors above have gone stale and
    // the comparison below would pass vacuously.
    expect(rust.length).toBeGreaterThanOrEqual(3);
    expect(new Set(await tsSources())).toEqual(new Set(rust));
  });

  test("every stamped source is spoken somewhere in the app", async () => {
    // `brain_inferred` was stamped on every guard row that reached the model,
    // shipped on the TS type, and named in exactly zero files under src. A tag
    // nothing reads is a tag that renders as whatever the default arm says.
    const rust = await rustSources();
    const seen = new Set<string>();
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      const src = await Bun.file(`${SRC}/${rel}`).text();
      for (const tag of rust) if (src.includes(tag)) seen.add(tag);
    }
    expect([...rust].filter((t) => !seen.has(t))).toEqual([]);
  });
});

describe("only a stated reason is called a reason", () => {
  test("the three stamped sources classify away from 'stated'", () => {
    expect(intentProvenance(row("session_prompt"))).toBe("asked");
    expect(intentProvenance(row("brain_inferred"))).toBe("inferred");
    expect(intentProvenance(row("guard_auto_stub"))).toBe("uncaptured");
  });

  test("a row nobody stamped came through log-intent proper", () => {
    expect(intentProvenance(row(null))).toBe("stated");
    expect(intentProvenance(row("something_new_from_the_future"))).toBe("stated");
  });

  test("the old '[auto] …' text still reads as uncaptured", () => {
    // Pre-`source` rows carry the junk title and no stamp at all.
    expect(intentProvenance(row(null, "[auto] backfill pending"))).toBe("uncaptured");
  });

  test("'Reason' is the heading for exactly one of the four", () => {
    const reasons = ALL.filter((p) => provenanceLabel(p) === "Reason");
    expect(reasons).toEqual(["stated"]);
  });

  test("no heading is an engine tag", () => {
    for (const p of ALL) {
      const label = provenanceLabel(p);
      expect(label).not.toMatch(/_/);
      expect(label.length).toBeGreaterThan(3);
    }
  });
});

describe("the note under the body says who wrote it", () => {
  test("a stated reason gets no note and the other three do", () => {
    expect(provenanceNote("stated")).toBe("");
    for (const p of ALL.filter((x) => x !== "stated")) {
      expect(provenanceNote(p).length).toBeGreaterThan(24);
    }
  });

  test("the inferred note names Aura as the author and warns it isn't the why", () => {
    // The whole point of the pass. If this line ever softens into "Aura's
    // summary of the change" with no caveat, the row goes back to reading like
    // somebody's reason.
    const note = provenanceNote("inferred");
    expect(note).toMatch(/\bAura\b/);
    expect(note).toMatch(/not the reason|summary, not|as a summary/i);
  });

  test("no note is written in engine vocabulary", () => {
    for (const p of ALL) {
      const note = provenanceNote(p);
      expect(note).not.toMatch(/changeset|intent_|_stub|AST|guard/i);
    }
  });
});

describe("a displayed string carries its own provenance, not the row's", () => {
  // An auto-stub row has no reason of its own, so every surface swaps in the
  // correlated session's prompt. What's on screen is then somebody's words —
  // which `intentProvenance(row)` alone would still call "uncaptured".
  const stub = () => row("guard_auto_stub", "[auto] backfill pending");

  test("a borrowed prompt is what you asked for, not a missing reason", () => {
    expect(displayedProvenance(stub(), "add retries to the webhook")).toBe("asked");
    expect(displayedProvenance(stub(), "")).toBe("uncaptured");
    expect(displayedProvenance(stub(), null)).toBe("uncaptured");
  });

  test("a real reason is unaffected by a prompt being in hand", () => {
    expect(displayedProvenance(row(null), "some prompt")).toBe("stated");
    expect(displayedProvenance(row("brain_inferred"), "some prompt")).toBe("inferred");
  });

  test("titleProvenance says 'asked' exactly when the title was borrowed", () => {
    const sessions = [
      { session_id: "s1", first_prompt: "add retries", last_prompt: "" },
    ] as unknown as ClaudeSession[];
    const linked = { ...stub(), claude_session_id: "s1", timestamp: 1000 } as IntentRow;
    const orphan = { ...stub(), timestamp: 1000 } as IntentRow;
    // Asserted flat, not as `title === x ? a : b` — a pairing written that way
    // passes for free the day correlation stops matching, and the whole point
    // of this file is that a test can be written for a defect and still miss
    // it. If this first line ever fails, the fixture is wrong, loudly.
    expect(sessionDisplayTitle(linked, sessions)).toBe("add retries");
    expect(titleProvenance(linked, sessions)).toBe("asked");
    expect(sessionDisplayTitle(orphan, [])).not.toBe("add retries");
    expect(titleProvenance(orphan, [])).toBe("uncaptured");
  });

  test("a model's line keeps its provenance through the title path", () => {
    expect(titleProvenance(row("brain_inferred"), [])).toBe("inferred");
  });
});

describe("the scan-list marker marks one thing", () => {
  test("only a model-written line is tagged", () => {
    expect(ALL.filter((p) => provenanceTag(p) !== "")).toEqual(["inferred"]);
  });

  test("the tag names the author and fits a metadata row", () => {
    const tag = provenanceTag("inferred");
    expect(tag).toMatch(/Aura/);
    expect(tag.length).toBeLessThanOrEqual(16);
  });

  test("every surface that shows a session title works out where it came from", async () => {
    // TeamActivityNow is the one exemption and it is deliberate: its `detail`
    // is "what this agent was last doing" on a live roster, which is what a
    // summary is FOR. It never labels the line a reason. The assertion below
    // pins the exemption list at one so it can't quietly grow.
    const EXEMPT = ["components/workpanes/TeamActivityNow.tsx"];
    expect(EXEMPT.length).toBe(1);
    const missing: string[] = [];
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      if (rel === "lib/sessionMeta.ts" || EXEMPT.includes(rel)) continue;
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      if (!src.includes("sessionDisplayTitle(")) continue;
      if (!/titleProvenance\(|displayedProvenance\(/.test(src)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});

describe("the seal doesn't promise more than it holds", () => {
  test("'Why this happened' is only said over a stated reason", async () => {
    // The strongest claim any label in this app makes. It was printed over all
    // four origins, including "Agent edited 3 files".
    const src = stripComments(
      await Bun.file(`${SRC}/components/workpanes/TimeMachinePane.tsx`).text(),
    );
    expect(src).toContain("Why this happened"); // ANCHOR: the card's label
    // Unquoted. The first version of this test matched `"Why this happened"`
    // with the quotes, so putting the defect back as bare JSX text — which is
    // exactly how it was written before this commit — matched nothing and the
    // loop ran zero times. A green test over an empty loop. Every claim in
    // this app can be written as a literal or as text between tags; a scan
    // that only knows one of those shapes is a scan for one of them.
    for (const m of src.matchAll(/Why this happened/g)) {
      const before = src.slice(Math.max(0, m.index - 80), m.index);
      expect(before).toContain("provenanceLabel(");
    }
  });

  test("the stated label defaults to 'Reason' and an override only moves it", () => {
    expect(provenanceLabel("stated")).toBe("Reason");
    expect(provenanceLabel("stated", "Why this happened")).toBe("Why this happened");
    for (const p of ALL.filter((x) => x !== "stated")) {
      expect(provenanceLabel(p, "Why this happened")).toBe(provenanceLabel(p));
    }
  });


  test("'changed and why' is only ever said for a stated reason", async () => {
    const src = stripComments(
      await Bun.file(`${SRC}/components/workpanes/SessionSummary.tsx`).text(),
    );
    expect(src).toContain("changed and why"); // ANCHOR: the seal sentence
    // Adjacency, not absence: the sentence is correct where it's guarded, and
    // a regex reading the sentence alone can't tell those two cases apart.
    for (const m of src.matchAll(/changed and why/g)) {
      const before = src.slice(Math.max(0, m.index - 220), m.index);
      expect(before).toMatch(/provenance === "stated"/);
    }
  });

  test("the detail pane heads the body from provenance, not a hardcoded word", async () => {
    const src = stripComments(
      await Bun.file(`${SRC}/components/workpanes/SessionDetailPane.tsx`).text(),
    );
    expect(src).toContain("provenanceLabel(");
    // The line this replaced. Everything that wasn't a `[auto]` stub — a
    // prompt, a model's read of the diff, a genuine logged reason — fell into
    // the same word.
    expect(src).not.toMatch(/\?\s*"Prompt"\s*:\s*"Reason"/);
  });
});

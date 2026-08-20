// What the alignment check is checking against — held to what actually
// reaches it.
//
//   bun test
//
// `aura intent-vs-actual` scores a commit's reason text against the AST nodes
// it changed, and the app renders that score as a verdict: a green "Matches
// task", a green dot, a filled coverage meter, a Drift gate.
//
// That is only a check when the two sides are independent. They often aren't.
// When an agent edits without logging intent, the mutation guard writes the
// reason for it — and its middle option, `brain_inferred`, is a line Aura's
// own model produced BY READING THE DIFF. Scoring that line against that diff
// compares the change to a description of itself. It cannot fail. The weakest
// row in the log was producing the most reassuring verdict on the page.
//
// Three defect classes are guarded here, and they are different:
//
//   1. the engine stops emitting `source`, or renames a tag — then every
//      report silently reads "somebody stated it" again (caught by parsing
//      the Rust, both the CLI that emits it and the guard that names it);
//   2. a surface reaches a verdict straight off `report.banner`, bypassing
//      the basis (caught by scanning src);
//   3. the derivation itself calls an unearned pass (caught by calling it).

import { describe, expect, test } from "bun:test";

import {
  basisCanBeChecked,
  intentBasis,
  mixedBasisNote,
  uncheckableLabel,
  uncheckableNote,
  uncheckableShort,
  type IntentBasis,
} from "../src/lib/intentBasis";
import { isAutoStubText } from "../src/lib/sessionMeta";
import {
  bannerTone,
  deriveAskedSaid,
  mergeIntentReports,
  reportBasis,
  verdictGlyph,
  type IntentReport,
  type StatedIntent,
} from "../src/components/workpanes/IntentStory";
import type { ClaudeSession } from "../src/lib/api";
import { stripComments } from "./support/code";

const SRC = `${import.meta.dir}/../src`;
const CLI = `${import.meta.dir}/../../aura-cli/src`;
const GUARD_RS = `${import.meta.dir}/../src-tauri/src/agent_mutation_guard.rs`;


function stated(intent: string, source?: string | null): StatedIntent {
  return { timestamp: 1_700_000_000, agent_id: "claude", intent, source };
}

function report(rows: StatedIntent[], over: Partial<IntentReport> = {}): IntentReport {
  return {
    commit_sha: "abc123def456",
    commit_short: "abc123d",
    commit_message: "",
    commit_time: 1_700_000_000,
    author: "Ashiq",
    stated: rows,
    modified_nodes: ["chargeCard"],
    added_nodes: [],
    deleted_nodes: [],
    aligned_nodes: ["chargeCard"],
    mismatched_nodes: [],
    alignment_score: 1,
    banner: "aligned",
    changed_files: ["src/pay.ts"],
    ...over,
  };
}

// ── 1. the engine ────────────────────────────────────────────────────

describe("the tags this file switches on are the ones the engine writes", () => {
  test("the guard still stamps brain_inferred and guard_auto_stub", async () => {
    const rs = await Bun.file(GUARD_RS).text();
    const open = rs.indexOf("let (stub_intent, stub_source) = match session_prompt");
    expect(open).toBeGreaterThan(-1);
    const close = rs.indexOf("let captured_reason", open);
    expect(close).toBeGreaterThan(open);
    const tags = new Set(
      [...rs.slice(open, close).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
    );

    // Rename either of these in Rust and every inferred row starts reading
    // as a stated one — a green verdict over a machine-written sentence.
    expect(tags.has("brain_inferred")).toBe(true);
    expect(tags.has("guard_auto_stub")).toBe(true);

    const ts = stripComments(await Bun.file(`${SRC}/lib/intentBasis.ts`).text());
    const switched = new Set(
      [...ts.matchAll(/r\.source === "([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect([...switched].sort()).toEqual(["brain_inferred", "guard_auto_stub"]);
  });

  test("the placeholder the guard writes today is one this app recognises", async () => {
    // The text check knew only the legacy "[auto] …" prefix for months after
    // the guard had moved to a sentence — so a stub read as a stated reason
    // wherever the source stamp wasn't in hand. Build the fixture FROM the
    // Rust format string so the next rewording fails here, not on screen.
    const rs = await Bun.file(GUARD_RS).text();
    const m = rs.match(/"([^"]*\{agent_id\}[^"]*\{n\}[^"]*)"/);
    expect(m).not.toBeNull();
    const rendered = m![1].replace("{agent_id}", "claude").replace("{n}", "3");
    expect(rendered).toContain("edited");
    expect(isAutoStubText(rendered)).toBe(true);
    // and it must not swallow a real reason
    expect(isAutoStubText("edited the retry helper so charges retry once")).toBe(false);
  });

  test("the CLI parses the guard's source and carries it into the report", async () => {
    // Without this the frontend reads a field that never arrives, every
    // report looks stated, and the whole check quietly reverts.
    const query = stripComments(await Bun.file(`${CLI}/intent_query.rs`).text());
    expect(query).toContain("pub source: Option<String>");
    expect(/get\("changeset"\)[\s\S]{0,120}get\("source"\)/.test(query)).toBe(true);

    const vs = stripComments(await Bun.file(`${CLI}/intent_vs_actual.rs`).text());
    const open = vs.indexOf("pub struct StatedIntent");
    expect(open).toBeGreaterThan(-1);
    const close = vs.indexOf("}", open);
    expect(vs.slice(open, close)).toContain("pub source: Option<String>");
    // …and populated, not merely declared.
    expect(vs).toContain("source: r.source.clone()");
  });

  test("the CLI still folds the commit message into what it scores", async () => {
    // intentBasis counts a commit message as a stated reason because the CLI
    // scores against it. If that stops being true the count is a fiction.
    const vs = await Bun.file(`${CLI}/intent_vs_actual.rs`).text();
    expect(vs).toContain("+ the commit message");
  });
});

// ── 2. the surfaces ──────────────────────────────────────────────────

describe("no surface reaches a verdict without asking what it's checking", () => {
  test("every file that tests for an aligned banner consults the basis", async () => {
    // Pinned exemptions, each for a reason that is not a verdict:
    //   useIntentMatch — narrows the CLI's string into the union, no rendering
    const EXEMPT = ["lib/useIntentMatch.ts"];
    expect(EXEMPT.length).toBe(1);

    const missing: string[] = [];
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      if (EXEMPT.includes(rel)) continue;
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      if (!/=== "aligned"/.test(src)) continue;
      if (!/basisCanBeChecked\(|reportBasis\(/.test(src)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  test("the words 'Matches task' are only written next to the basis check", async () => {
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      for (const m of src.matchAll(/Matches task/g)) {
        // Scope to the enclosing function rather than a byte window: the
        // guard clause has to run before the label, however long the arms get.
        const head = src.lastIndexOf("export function ", m.index);
        const before = src.slice(head < 0 ? 0 : head, m.index);
        expect(before).toContain("basisCanBeChecked(");
      }
    }
  });

  test("the coverage meter and the percentage are gated on the same fact", async () => {
    // A 100% bar over a self-matching reason is the same lie as the label.
    const src = stripComments(
      await Bun.file(`${SRC}/components/workpanes/IntentStory.tsx`).text(),
    );
    const open = src.indexOf("export function VerdictBeat");
    expect(open).toBeGreaterThan(-1);
    const body = src.slice(open, src.indexOf("export function RecoverBeat", open));
    expect(body).toContain("const checkable = basisCanBeChecked(reportBasis(report))");
    expect(body).toContain("{checkable && (");
    // The glyph must come from the shared helper, never re-derived here —
    // a header and a body that each decide would eventually disagree.
    expect(body).toContain("verdictGlyph(report)");
    expect(/glyph\s*=[\s\S]{0,80}banner === "aligned"/.test(body)).toBe(false);
  });

  test("the per-commit dot goes gray when there is nothing to check", async () => {
    const src = stripComments(
      await Bun.file(`${SRC}/components/IntentMatchChip.tsx`).text(),
    );
    expect(src).toContain("basisCanBeChecked(m.basis)");
    expect(src).toContain('bannerTone(checkable ? m.banner : "unknown")');
  });

  test("the Drift gate sets aside commits it cannot score", async () => {
    const src = stripComments(await Bun.file(`${SRC}/lib/useFeatureDrift.ts`).text());
    expect(src).toContain("basisCanBeChecked(");
    // and the basis is actually threaded from the fetch, not defaulted away
    expect(src).toContain("basis: m.basis");
  });
});

// ── 3. the derivation ────────────────────────────────────────────────

describe("intentBasis", () => {
  test("a typed intent is a stated reason", () => {
    expect(intentBasis([stated("add retries to the payment call")])).toBe("stated");
  });

  test("the session prompt counts as stated — the user typed it, not the diff", () => {
    expect(intentBasis([stated("add retries", "session_prompt")])).toBe("stated");
  });

  test("a model's line read off the diff is not a reason", () => {
    expect(intentBasis([stated("retries added around the charge call", "brain_inferred")])).toBe(
      "inferred",
    );
  });

  test("the guard's placeholder is its own case, not a divergence", () => {
    expect(intentBasis([stated("claude edited 3 file(s) — reason not captured yet", "guard_auto_stub")])).toBe(
      "uncaptured",
    );
  });

  test("placeholder text is caught even with no source stamped", () => {
    // Rows can arrive without `changeset.source` — an older log, or a path
    // that drops it. Both shapes of the guard's placeholder still give it away.
    expect(intentBasis([stated("claude edited 3 file(s) — reason not captured yet")])).toBe(
      "uncaptured",
    );
    expect(intentBasis([stated("[auto] backfill pending")])).toBe("uncaptured");
  });

  test("one real reason among machine-written ones is mixed, not stated", () => {
    const basis = intentBasis([
      stated("add retries to the payment call"),
      stated("charge call rewritten", "brain_inferred"),
    ]);
    expect(basis).toBe("mixed");
  });

  test("a commit message is a stated reason — the CLI scores against it", () => {
    expect(intentBasis([], "fix(pay): retry the charge call")).toBe("stated");
    expect(intentBasis([stated("charge call rewritten", "brain_inferred")], "fix(pay): retry")).toBe(
      "mixed",
    );
  });

  test("a blank message does not count", () => {
    expect(intentBasis([], "   \n ")).toBe("none");
  });

  test("nothing recorded at all is none", () => {
    expect(intentBasis([])).toBe("none");
    expect(intentBasis(null)).toBe("none");
    expect(intentBasis(undefined)).toBe("none");
  });

  test("only two bases can be checked", () => {
    const all: IntentBasis[] = ["stated", "inferred", "mixed", "uncaptured", "none"];
    expect(all.filter(basisCanBeChecked)).toEqual(["stated", "mixed"]);
  });
});

describe("the verdict never claims more than it checked", () => {
  test("a self-matching reason does not produce a green pass", () => {
    const r = report([stated("charge call rewritten", "brain_inferred")]);
    expect(r.banner).toBe("aligned"); // the score really is 100% — that's the trap
    expect(reportBasis(r)).toBe("inferred");

    const tone = bannerTone(r);
    expect(tone.label).toBe("Nothing to check against");
    expect(tone.label).not.toBe("Matches task");
    expect(tone.color).not.toContain("green");
    expect(tone.msg).toContain("written by Aura");
    expect(verdictGlyph(r)).toBe("?");
  });

  test("a placeholder reason does not produce a red failure either", () => {
    const r = report([stated("claude edited 3 file(s) — reason not captured yet", "guard_auto_stub")], {
      banner: "diverged",
      aligned_nodes: [],
      mismatched_nodes: ["chargeCard"],
      alignment_score: 0,
    });
    const tone = bannerTone(r);
    expect(tone.label).toBe("Nothing to check against");
    expect(tone.label).not.toBe("No clear match");
    expect(tone.color).not.toContain("red");
    expect(verdictGlyph(r)).toBe("?");
  });

  test("a stated reason still gets the real verdict", () => {
    const r = report([stated("add retries to the charge call")]);
    expect(reportBasis(r)).toBe("stated");
    expect(bannerTone(r).label).toBe("Matches task");
    expect(bannerTone(r).note).toBe("");
    expect(verdictGlyph(r)).toBe("✓");
  });

  test("a commit message alone is enough to earn a verdict", () => {
    const r = report([], { commit_message: "fix(pay): retry the charge call" });
    expect(reportBasis(r)).toBe("stated");
    expect(bannerTone(r).label).toBe("Matches task");
    expect(verdictGlyph(r)).toBe("✓");
  });

  test("a mixed basis keeps its verdict and discloses what's under it", () => {
    const r = report([
      stated("add retries to the charge call"),
      stated("charge call rewritten", "brain_inferred"),
    ]);
    expect(reportBasis(r)).toBe("mixed");
    expect(bannerTone(r).label).toBe("Matches task");
    expect(bannerTone(r).note).toContain("written by Aura");
    expect(verdictGlyph(r)).toBe("✓");
  });

  test("drift and divergence disclose it too — the note is not a green-only footnote", () => {
    const rows = [
      stated("add retries to the charge call"),
      stated("charge call rewritten", "brain_inferred"),
    ];
    for (const banner of ["drift", "diverged"] as const) {
      expect(bannerTone(report(rows, { banner })).note).toContain("written by Aura");
    }
  });

  test("every arm of bannerTone returns a note field", () => {
    // `note` is rendered unconditionally; an arm that forgets it would throw
    // away the disclosure silently rather than loudly.
    for (const banner of ["aligned", "drift", "diverged"] as const) {
      expect(typeof bannerTone(report([stated("x")], { banner })).note).toBe("string");
    }
  });
});

describe("merging a run's commits doesn't invent a divergence", () => {
  test("commit messages count when the run logged no intent", () => {
    // The CLI scores each commit against its message, so `mismatched` here
    // was already measured against one. Judging the run on intent rows alone
    // put "No clear match" in red over work its own scoring found covered.
    const merged = mergeIntentReports([
      report([], { commit_sha: "a", commit_time: 2, commit_message: "fix(pay): retry the charge" }),
      report([], { commit_sha: "b", commit_time: 1, commit_message: "test(pay): cover the retry" }),
    ]);
    expect(merged?.banner).toBe("aligned");
    expect(bannerTone(merged!).label).toBe("Matches task");
  });

  test("a run with no reason anywhere is still a real hole", () => {
    const merged = mergeIntentReports([
      report([], { commit_sha: "a", commit_time: 2, commit_message: "" }),
      report([], { commit_sha: "b", commit_time: 1, commit_message: "  " }),
    ]);
    expect(merged?.banner).toBe("diverged");
    expect(reportBasis(merged!)).toBe("none");
    expect(bannerTone(merged!).label).toBe("Nothing to check against");
  });

  test("uncovered pieces still show through", () => {
    const merged = mergeIntentReports([
      report([], {
        commit_sha: "a",
        commit_time: 2,
        commit_message: "fix(pay): retry",
        aligned_nodes: [],
        mismatched_nodes: ["chargeCard", "refund"],
      }),
      report([], { commit_sha: "b", commit_time: 1, commit_message: "wip" }),
    ]);
    expect(merged?.banner).not.toBe("aligned");
  });
});

describe("the Asked beat only ever shows something somebody stated", () => {
  const session = (over: Partial<ClaudeSession> = {}): ClaudeSession =>
    ({
      session_id: "s1",
      first_prompt: "add retries to the charge call",
      last_prompt: "ship it",
      mtime: 1_700_000_000,
      ...over,
    }) as ClaudeSession;

  test("a model's line never becomes the ask", () => {
    const r = report([stated("charge call rewritten", "brain_inferred")]);
    const { asked, said } = deriveAskedSaid(r, []);
    // Promoting it here would print the change's own description under the
    // heading "Asked", as the origin of the change it describes.
    expect(asked).toBeNull();
    expect(said.map((s) => s.intent)).toEqual(["charge call rewritten"]);
  });

  test("a stated row is preferred over an inferred one even when later", () => {
    const r = report([
      { ...stated("charge call rewritten", "brain_inferred"), timestamp: 1 },
      { ...stated("add retries to the charge call"), timestamp: 2 },
    ]);
    const { asked, said } = deriveAskedSaid(r, []);
    expect(asked?.text).toBe("add retries to the charge call");
    expect(said.map((s) => s.intent)).toEqual(["charge call rewritten"]);
  });

  test("the guard's placeholder is never an ask and never a said", () => {
    const r = report([
      stated("claude edited 3 file(s) — reason not captured yet", "guard_auto_stub"),
    ]);
    const { asked, said } = deriveAskedSaid(r, []);
    expect(asked).toBeNull();
    expect(said).toEqual([]);
  });

  test("a placeholder whose wording drifted is caught by the stamp alone", () => {
    // The text check and the source stamp are two independent nets. This
    // fixture deliberately slips the first, so removing the second — which
    // reads like a redundant clause — fails here instead of putting
    // "agent touched 3 files" on screen as the reason for a change.
    const r = report([stated("some later placeholder wording", "guard_auto_stub")]);
    expect(isAutoStubText("some later placeholder wording")).toBe(false);
    const { asked, said } = deriveAskedSaid(r, []);
    expect(asked).toBeNull();
    expect(said).toEqual([]);
  });

  test("a codex commit does not wear a nearby Claude session's prompt", () => {
    // correlateClaudeSession gates this borrow row by row; the same gate has
    // to hold here, or the beat renders Claude's badge over Codex's work.
    const r = report([{ ...stated("port the retry helper"), agent_id: "codex" }]);
    const { asked } = deriveAskedSaid(r, [session()]);
    expect(asked?.fromSession).toBe(false);
    expect(asked?.agentId).toBe("codex");
    expect(asked?.text).toBe("port the retry helper");
  });

  test("a claude commit still gets the prompt", () => {
    const r = report([stated("logged as it worked")]);
    const { asked } = deriveAskedSaid(r, [session()]);
    expect(asked?.fromSession).toBe(true);
    expect(asked?.agentId).toBe("claude");
    expect(asked?.text).toBe("add retries to the charge call");
  });

  test("one claude row among others is enough to borrow", () => {
    const r = report([
      { ...stated("port the retry helper"), agent_id: "codex" },
      stated("logged as it worked"),
    ]);
    expect(deriveAskedSaid(r, [session()]).asked?.fromSession).toBe(true);
  });

  test("with no rows at all the prompt is still the best signal", () => {
    expect(deriveAskedSaid(report([]), [session()]).asked?.fromSession).toBe(true);
  });

  test("a far-off session is not borrowed", () => {
    const r = report([]);
    const far = session({ mtime: 1_700_000_000 + 60 * 60 * 24 });
    expect(deriveAskedSaid(r, [far]).asked).toBeNull();
  });

  test("the Said beat marks the lines Aura wrote", async () => {
    const src = stripComments(
      await Bun.file(`${SRC}/components/workpanes/IntentStory.tsx`).text(),
    );
    const open = src.indexOf("export function SaidBeat");
    expect(open).toBeGreaterThan(-1);
    const body = src.slice(open, src.indexOf("export function", open + 10));
    expect(body).toContain('s.source === "brain_inferred"');
    expect(body).toContain("Aura's summary");
  });
});

describe("the copy says which kind of nothing it is", () => {
  test("each uncheckable basis explains itself differently", () => {
    const notes = ["inferred", "uncaptured", "none"].map((b) =>
      uncheckableNote(b as IntentBasis),
    );
    expect(new Set(notes).size).toBe(3);
    for (const n of notes) expect(n.length).toBeGreaterThan(20);
    expect(uncheckableNote("stated")).toBe("");
    expect(uncheckableNote("mixed")).toBe("");
  });

  test("the short form exists wherever the long one does", () => {
    for (const b of ["inferred", "uncaptured", "none"] as IntentBasis[]) {
      expect(uncheckableShort(b).length).toBeGreaterThan(10);
      expect(uncheckableLabel(b)).toBe("Nothing to check against");
    }
    expect(uncheckableShort("stated")).toBe("");
    expect(uncheckableLabel("mixed")).toBe("");
  });

  test("the mixed disclosure only fires for mixed", () => {
    expect(mixedBasisNote("mixed")).not.toBe("");
    for (const b of ["stated", "inferred", "uncaptured", "none"] as IntentBasis[]) {
      expect(mixedBasisNote(b)).toBe("");
    }
  });

  test("none of this copy speaks engine", () => {
    // ADE audience: no AST, no banner, no source tags on screen.
    const all = [
      ...(["inferred", "uncaptured", "none"] as IntentBasis[]).map(uncheckableNote),
      ...(["inferred", "uncaptured", "none"] as IntentBasis[]).map(uncheckableShort),
      mixedBasisNote("mixed"),
      uncheckableLabel("inferred"),
    ];
    for (const s of all) {
      expect(s).not.toMatch(/AST|brain_inferred|guard_auto_stub|session_prompt|banner|alignment_score/);
    }
  });
});

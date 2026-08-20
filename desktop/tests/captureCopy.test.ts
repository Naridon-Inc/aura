// The safety net says when it runs, and the backup count doesn't promise
// coverage it can't have.
//
// Capture is a set of git hooks. `aura enable` writes pre-commit, post-commit
// and pre-push (aura-cli/src/hook.rs:98,127,164) and nothing else — it fires at
// a commit and at no other moment. Four surfaces described it and only one got
// that right:
//
//   Doctor, on      "Every commit gets recorded and checked automatically."   ✓
//   Doctor, off     "…recorded and checked as you work."                      ✗
//   Safety net      "Every change is recorded with its reason — nothing is    ✗
//                    lost."
//   /capture        "Aura will capture your changes as you work."             ✗
//
// The wrong ones are wrong in the direction that costs something: told the
// record is continuous, you stop thinking about the uncommitted hours, which
// are exactly the hours it doesn't cover.
//
// Separately, Doctor read a backup COUNT as a guarantee — "N backups saved —
// Aura can roll any AI edit back." A backup is one saved copy of one file.
// agent_mutation_guard.rs:298 returns "no snapshot found for <path>" for an
// edit that has none, so "any" was never true.
//
// Scope, stated so nobody trusts this further than it goes: it scans string
// literals in src. It cannot tell whether a new sentence about the safety net
// is accurate — only that it isn't one of the shapes below.
//
// The first version of this file did not catch its own headline defect. It
// banned the wrong ANSWERS ("as you work", "continuously", "in real time") and
// "Every change is recorded with its reason — nothing is lost." gives no
// answer at all: it is wrong by omitting the question. Writing the sentence
// back into HooksPane left the suite green. So the rule here is the positive
// one — on the surfaces that describe the safety net, a sentence about Aura
// recording your work has to say WHEN — and the ban on wrong answers stays as
// the global backstop for a fifth surface nobody has thought of yet.

import { expect, test, describe } from "bun:test";
import { stripComments } from "./support/code";

const SRC = `${import.meta.dir}/../src`;


// Fresh regex per call. A shared global one carries `lastIndex` from an `exec`
// into the next `matchAll` and silently skips the front of the next input —
// which is how a source scan in this suite once passed with its defect put back.
const literals = (s: string) =>
  s.matchAll(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g);

async function* userFacingText(): AsyncGenerator<[string, string]> {
  for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
    const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
    for (const lit of literals(src)) {
      // `${…}` prints a value, not a word — strip before reading the prose, or
      // a branch name inside an interpolation reads as vocabulary.
      const text = lit[0].slice(1, -1).replace(/\$\{[^}]*\}/g, "…");
      if (text.length < 16) continue;
      if (!/[a-z] [a-z]/.test(text)) continue; // a sentence, not an identifier
      yield [rel, text];
    }
  }
}

describe("the safety net says when it runs", () => {
  test("nothing describes recording as continuous", async () => {
    const offenders: string[] = [];
    const RECORDS = /\b(?:record(?:s|ed|ing)?|captur(?:e|es|ed|ing)|sav(?:e|es|ed|ing))\b/i;
    const CONTINUOUS =
      /\bas you (?:work|type|go|edit|code)\b|\bcontinuously\b|\bin real ?time\b|\bthe moment you (?:edit|change|save)\b/i;
    for await (const [rel, text] of userFacingText()) {
      // Only sentences about Aura keeping the record — a chat message that
      // happens to say "as you work" is not this bug.
      if (!RECORDS.test(text)) continue;
      if (!/\b(?:chang|edit|commit|work)/i.test(text)) continue;
      if (CONTINUOUS.test(text)) offenders.push(`${rel} · ${text.slice(0, 78)}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every sentence that says Aura records your work says when", async () => {
    // These four surfaces describe the safety net. The check is per SENTENCE,
    // not per file: the file-level version of this test — "the file mentions
    // 'commit' somewhere" — passed while HooksPane carried "Every change is
    // recorded with its reason", because a correct sentence four lines away
    // was enough to satisfy it.
    const files = [
      "components/commons/agentCustomize/HooksPane.tsx",
      "components/commons/AgentCustomizations.tsx",
      "components/dialogs/DoctorDialog.tsx",
      "lib/chatSlashHandler.ts",
    ];
    // Any moment will do, as long as there is one. "commit" is the true answer
    // for capture; "before it was edited" is the true answer for a snapshot;
    // "today" scopes a count. What must never happen is no answer at all.
    const WHEN =
      /\bcommit|\bbefore\b|\bwhen you\b|\bnext\b|\btoday\b|\bfrom now\b/i;
    const RECORDS =
      /\b(?:record(?:s|ed|ing)?|captur(?:e|es|ed|ing)|sav(?:e|es|ed|ing))\b/i;
    const offenders: string[] = [];
    for (const rel of files) {
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      for (const lit of literals(src)) {
        // A markdown field row ("- **Recording your work:** <value>") is a
        // label, and a label makes no claim — its value is its own literal and
        // gets scanned on its own. Drop the label and judge what's left, so
        // "- **Safety:** every change is recorded" is still caught.
        const text = lit[0]
          .slice(1, -1)
          .replace(/\$\{[^}]*\}/g, "…")
          .replace(/^-\s*\*\*[^*]*\*\*:?\s*/, "");
        if (text.length < 16 || !/[a-z] [a-z]/.test(text)) continue;
        if (!RECORDS.test(text)) continue;
        if (!/\b(?:chang|edit|work)/i.test(text)) continue;
        if (!WHEN.test(text)) offenders.push(`${rel} · ${text.slice(0, 78)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("a count of backups is not a guarantee", () => {
  test("nothing promises to roll back any edit", async () => {
    const offenders: string[] = [];
    // "roll any AI edit back", "undo any change", "always … undo" — each reads
    // a stored count as complete coverage.
    const BLANKET =
      /\b(?:roll|undo|revert|restore|put)\b[^.]{0,30}\bany\b[^.]{0,24}\b(?:edit|change|file)\b|\balways\b[^.]{0,24}\bundo\b/i;
    for await (const [rel, text] of userFacingText()) {
      if (BLANKET.test(text)) offenders.push(`${rel} · ${text.slice(0, 78)}`);
    }
    expect(offenders).toEqual([]);
  });

  test("nothing tells you nothing is lost", async () => {
    // The other half of the safety-net sentence: "…with its reason — nothing is
    // lost." Everything Aura holds is scoped to something — a commit, a
    // snapshot of one file, an intent row — so there is no honest way to say
    // this, and it is the single most reassuring thing on the pane.
    const offenders: string[] = [];
    const ABSOLUTE =
      /\bnothing (?:is|gets|ever gets|will be|can be) lost\b|\bnothing's lost\b|\bnever lose\b/i;
    for await (const [rel, text] of userFacingText()) {
      if (ABSOLUTE.test(text)) offenders.push(`${rel} · ${text.slice(0, 78)}`);
    }
    expect(offenders).toEqual([]);
  });
});

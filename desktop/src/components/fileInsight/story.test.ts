// The reading these pin: the block leads with a real account of the change or
// with nothing — never the generic sentence and never a mined line quoting
// variable names — and its rows say what each piece does, not what it's called.

import { describe, expect, test } from "bun:test";

import type { ChangeExplanation, SymbolMeanings } from "../../lib/changeExplain";
import type { InsightNote } from "../../lib/insightNotes";
import { codeRows, headline, isMinedLine, isToolError, storyTally, whyNotes } from "./story";

function exp(over: Partial<ChangeExplanation>): ChangeExplanation {
  return { before: "", what: "", why: "", why_source: "none", source: "cache", diff_hash: "h", ...over };
}

describe("headline", () => {
  test("leads with the model's used-to / now", () => {
    expect(
      headline(exp({ before: "Kept each person's commit count.", what: "Keeps only who is on the team." })),
    ).toEqual({ before: "Kept each person's commit count.", now: "Keeps only who is on the team." });
  });

  test("never the generic sentence, never a mined line", () => {
    expect(headline(exp({ what: "Updates how this part of the project works.", source: "mixed" }))).toBeNull();
    expect(headline(exp({ what: "Now sets 'from' from 'senderFor'.", source: "mixed" }))).toBeNull();
    expect(headline(exp({ what: "Sends mail with retries.", source: "fallback" }))).toBeNull();
    expect(isMinedLine("Previously set 'from' from 'defaultSender'.")).toBe(true);
    expect(isMinedLine("Now retries a failed send three times.")).toBe(false);
  });

  test("drops a mined before line but keeps a real now", () => {
    expect(
      headline(exp({ before: "Previously set 'a' from 'b'.", what: "Retries a failed send.", source: "mixed" })),
    ).toEqual({ before: "", now: "Retries a failed send." });
  });
});

describe("CLI and hook errors", () => {
  // From the user's screen: an older backend cached this as the explanation.
  const blocked = "UserPromptSubmit operation blocked by hook:";

  test("are never the headline, a row or Aura's reading", () => {
    expect(headline(exp({ what: blocked, source: "model" }))).toBeNull();
    expect(headline(exp({ before: "Error: Invalid API key · Please run /login", what: "Keeps the team list." })))
      .toEqual({ before: "", now: "Keeps the team list." });
    const rows = codeRows([{ identifier: "save", kind: "fn", change: "added", start_line: 1 }], {
      now: new Map([["save", blocked]]),
      before: new Map(),
      complete: true,
    });
    expect(rows[0].text).toBe("New function: Save");
    expect(whyNotes(exp({ why: "Usage: claude [options]", why_source: "model" }), [], null)).toEqual([]);
  });

  test("a real line that mentions an error is kept", () => {
    expect(isToolError(blocked)).toBe(true);
    expect(isToolError("- blocked: change-summary narration is disabled")).toBe(true);
    expect(isToolError("Shows an error when the upload fails.")).toBe(false);
    expect(isToolError("Shows a banner when you are not logged in.")).toBe(false);
  });
});

describe("code rows", () => {
  const pieces = [
    { identifier: "scheduleDigest", kind: "fn", change: "added", start_line: 7 },
    { identifier: "sendEmail", kind: "fn", change: "modified", start_line: 3 },
    { identifier: "legacySend", kind: "fn", change: "deleted", start_line: null },
  ];

  test("placeholders name the piece in words while the model writes", () => {
    const none: SymbolMeanings = { now: new Map(), before: new Map(), complete: false };
    const rows = codeRows(pieces, none);
    expect(rows.map((r) => `${r.mark} ${r.text}`)).toEqual([
      "+ New function: Schedule digest",
      "~ Reworked function: Send email",
      "− Removed function: Legacy send",
    ]);
    expect(rows.every((r) => r.pending)).toBe(true);
    expect(rows.map((r) => r.key)).toEqual(["scheduleDigest", "sendEmail", "legacySend"]);
  });

  test("the model's lines replace them, with what a reworked piece used to do", () => {
    const m: SymbolMeanings = {
      now: new Map([
        ["scheduleDigest", "Queues each user's weekly digest."],
        ["sendEmail", "Sends an email and retries it up to three times."],
      ]),
      before: new Map([
        ["sendEmail", "Sent an email once."],
        ["legacySend", "Sent mail the old way."],
      ]),
      complete: true,
    };
    const rows = codeRows(pieces, m);
    expect(rows[0]).toMatchObject({ text: "Queues each user's weekly digest.", pending: false });
    expect(rows[1]).toMatchObject({
      text: "Sends an email and retries it up to three times.",
      was: "Sent an email once.",
      pending: false,
    });
    expect(rows[2]).toMatchObject({ text: "Removed: Sent mail the old way.", pending: false });
    expect(storyTally(rows)).toBe("1 added · 1 removed · 1 changed");
  });
});

describe("why", () => {
  const note = (id: string, text: string, auto = false): InsightNote => ({
    id,
    who: auto ? "Recorded on edit" : "Claude",
    text,
    whenMs: 1_794_252_198_000,
    auto,
  });

  test("the author's recorded reason comes first, with its real time", () => {
    const n = whyNotes(
      exp({ why: "Stop saving per-machine paths.", why_source: "recorded", why_author: "sam", why_stated_at: 1_794_252_000 }),
      [note("a", "Stop saving per-machine paths."), note("b", "Moved the agent to the top.")],
      null,
    );
    expect(n.map((x) => [x.provenance, x.text])).toEqual([
      ["stated", "Stop saving per-machine paths."],
      ["noted", "Moved the agent to the top."],
    ]);
    expect(n[0].whenMs).toBe(1_794_252_000_000);
  });

  test("Aura's reading only when nothing was written down", () => {
    expect(whyNotes(exp({ why: "To keep the file portable.", why_source: "model" }), [], null)).toEqual([
      { id: "reading", who: "Aura's reading", text: "To keep the file portable.", whenMs: null, provenance: "reading" },
    ]);
    expect(whyNotes(exp({}), [], note("s", "Session goal", true))).toEqual([]);
  });
});

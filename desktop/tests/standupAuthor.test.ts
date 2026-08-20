// Settings → Organization → Team → Activity, driven in a real window.
//
//   bun test
//
// The pane read, in full:
//
//     Standup · Last 7 days · what each person worked on
//     2026-08-02   unknown   3 updates
//     2026-08-01   unknown   3 updates
//
// Two faults stacked, and the second hid the first.
//
// The reader: `aura log-intent`, the MCP tool and the CLI's own
// `intent_query.rs` all spell the author field `agent_id`. The shell's
// `IntentEntry` declared `agent`, took the serde default, and handed every
// row up with an empty author — 76 of 76 rows in one repo's log, 442 of 448
// in another. The same silence made `aura_read_intent_log_v2`'s `agent`
// filter unable to match anything at all, and the perf fixture wrote the
// spelling the struct wanted, so nothing caught it.
//
// The naming: with an author to print, this column still had only one
// answer — a roster lookup — and fell through to the raw string. Agent ids
// are most of this log, so the pane would have gone from "unknown" to
// "claude". The literal key "unknown" was also being decided in the
// bucketing, which put it beyond the reach of the roster.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const VIEW = "components/standup/StandupView.tsx";
const ENTRY = "../src-tauri/src/cmd_aura_fs.rs";

describe("the author of an intent is read off the field that is written", () => {
  test("IntentEntry accepts agent_id, the spelling every writer emits", async () => {
    const src = await readSrc(ENTRY);
    expect(src).toContain('#[serde(default, alias = "agent_id")]');
  });

  test("the perf fixture writes the shape a real log is in", async () => {
    const src = await readSrc(ENTRY);
    // Wrote `"agent"` before, so the agent-filter path was benchmarked
    // against a filter that matches nothing in any repo on disk.
    expect(src).toContain('\\"agent_id\\":\\"{agent}\\"');
  });

  test("and there are tests standing on a row copied off disk", async () => {
    const src = await readSrc(ENTRY);
    expect(src).toContain("mod intent_author_tests");
    expect(src).toContain("reads_the_author_off_agent_id");
    expect(src).toContain("the_agent_filter_can_match_a_real_row");
  });
});

describe("standup — an author is named, not printed", () => {
  test("both the screen and the posted digest name through one function", async () => {
    const src = await readSrc(VIEW);
    expect(src).toContain("function authorDisplay(");
    // DaySection and buildDigest had a copy each of the roster lookup; a
    // digest naming people differently from the pane it was built from
    // reads as a second, disagreeing account of the same week.
    expect(src.split("authorDisplay(author,").length - 1).toBe(2);
    expect(src).not.toContain("member?.name || member?.handle || author");
  });

  test("a teammate on the roster still wins", async () => {
    const src = await readSrc(VIEW);
    const fn = src.slice(
      src.indexOf("function authorDisplay("),
      src.indexOf("function DaySection("),
    );
    expect(fn).toContain("m.email === author || m.handle === author");
    expect(fn).toContain("if (member) return member.name || member.handle");
  });

  test("an agent id resolves through the app-wide table", async () => {
    const src = await readSrc(VIEW);
    expect(src).toContain('import { agentName } from "../../lib/agentNames"');
    const fn = src.slice(
      src.indexOf("function authorDisplay("),
      src.indexOf("function DaySection("),
    );
    // `claude` reads "Claude", `cli:gemini` reads "Gemini" — the same
    // answers the launcher, the mission board and usage already give.
    expect(fn).toContain("agentName(author,");
  });

  test("an address off the roster is shown as itself", async () => {
    const src = await readSrc(VIEW);
    const fn = src.slice(
      src.indexOf("function authorDisplay("),
      src.indexOf("function DaySection("),
    );
    // Not reduced to the title-cased local part of it.
    expect(fn).toContain('if (author.includes("@")) return author');
  });

  test("nobody recorded says so, in words", async () => {
    const src = await readSrc(VIEW);
    const fn = src.slice(
      src.indexOf("function authorDisplay("),
      src.indexOf("function DaySection("),
    );
    expect(fn).toContain('empty: "Not recorded"');
    expect(fn).toContain('unknown: "Not recorded"');
  });

  test("the bucket key is the raw id, so the roster can still reach it", async () => {
    const src = await readSrc(VIEW);
    const fn = src.slice(src.indexOf("function bucketByDay("));
    // "unknown" is a word a teammate could plausibly commit under, and as a
    // key it decided what the screen said before any lookup ran.
    expect(fn).not.toContain('e.agent || "unknown"');
    expect(fn).toContain('const author = e.agent || ""');
  });
});

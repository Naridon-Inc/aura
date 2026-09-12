// The undo list reads like a person wrote it.
//
// The rows in this file are copied out of a real `.aura/op_log.jsonl` — the
// exact fifteen the screenshot behind this change was showing:
//
//     Linked files to a reason   Attributed 1 path(s) to intent #1788769912   ×10
//     Wrote down a reason        Logged intent: [Image #1] these screens as…   ×5
//
// Ten of those are one action. Five are one sentence said five times. Not one
// of the fifteen names a file, and every one of them prints a timestamp as if
// it were an identifier. The tests below pin the reading of exactly that data.

import { describe, expect, test } from "bun:test";

import {
  cleanReason,
  describeGroup,
  fileFromPath,
  groupOps,
  outsideCount,
  type OpGroup,
} from "../src/components/dialogs/opLog/describe";
import type { OpEntry } from "../src/lib/api";

const ROOT = "/Users/dev/Documents/work/web-platform";
const SCRATCH = "/private/tmp/claude-501/-Users-dev-Documents-work-web-platform/96fec09e/scratchpad";
const NOTES = "/Users/dev/.claude/projects/-Users-dev-Documents-work-web-platform/memory";

let seq = 0;
function op(over: Partial<OpEntry> = {}): OpEntry {
  seq += 1;
  return {
    op_id: `op-${seq}`,
    ts: 1788769912,
    kind: "log_intent",
    summary: "",
    agent_id: "aura-shell",
    undo_payload: {},
    undone_at: null,
    ...over,
  };
}

function attribute(path: string, intentTs = 1788769912): OpEntry {
  return op({
    kind: "intent_attribute",
    summary: `Attributed 1 path(s) to intent #${intentTs}`,
    undo_payload: { intent_ts: intentTs, file_paths: [path] },
  });
}

function logged(text: string, intentTs: number): OpEntry {
  return op({
    kind: "log_intent",
    summary: `Logged intent: ${text.slice(0, 60)}`,
    undo_payload: { intent_ts: intentTs },
  });
}

const PROMPT = "[Image #1] these screens as well, make it more wdith and blend it";
const NO_REASONS: ReadonlyMap<number, string> = new Map();

/** The ten attribute rows the screenshot showed, in log order. */
const TEN_FILES = [
  `${SCRATCH}/wait_deploy.py`,
  `${NOTES}/mirakash-public-demo-call.md`,
  `${SCRATCH}/commit_msg_r4.txt`,
  `${SCRATCH}/shot_bands.py`,
  `${NOTES}/mirakash-marketing-elevenlabs-restyle.md`,
  `${SCRATCH}/merge_secret.py`,
  `${SCRATCH}/ecs_seed.py`,
  `${NOTES}/MEMORY.md`,
  `${NOTES}/mirakash-public-demo-call.md`,
  `${NOTES}/MEMORY.md`,
];

function only(groups: OpGroup[]): OpGroup {
  expect(groups.length).toBe(1);
  return groups[0];
}

describe("one action is one line", () => {
  test("ten files filed under one reason fold into a single line", () => {
    const groups = groupOps(TEN_FILES.map((p) => attribute(p)));
    const g = only(groups);
    expect(g.ops.length).toBe(10);
    const story = describeGroup(g, ROOT, NO_REASONS);
    // Two paths appear twice in the real log, so ten steps are eight files —
    // and the line counts what a person would count.
    expect(story.files.length).toBe(8);
    expect(story.title).toBe("Linked 8 files to why they changed");
    expect(story.steps).toBe(10);
  });

  test("a different reason starts a new line", () => {
    const groups = groupOps([
      attribute(`${SCRATCH}/a.py`, 1788769912),
      attribute(`${SCRATCH}/b.py`, 1788769912),
      attribute(`${SCRATCH}/c.py`, 1788766677),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0].ops.length).toBe(2);
    expect(groups[1].ops.length).toBe(1);
  });

  test("the same sentence written down five times says so, once", () => {
    const g = only(
      groupOps([
        logged(PROMPT, 1788769258),
        logged(PROMPT, 1788769139),
        logged(PROMPT, 1788768791),
        logged(PROMPT, 1788768777),
        logged(PROMPT, 1788768070),
      ]),
    );
    const story = describeGroup(g, ROOT, NO_REASONS);
    expect(story.title).toBe("Wrote down the same reason 5 times");
    expect(story.steps).toBe(5);
  });

  test("said twice, it says twice — nobody says '2 times'", () => {
    const g = only(groupOps([logged(PROMPT, 1788769258), logged(PROMPT, 1788769139)]));
    expect(describeGroup(g, ROOT, NO_REASONS).title).toBe("Wrote down the same reason twice");
  });

  test("said once, the line doesn't count at all", () => {
    const g = only(groupOps([logged(PROMPT, 1788769258)]));
    expect(describeGroup(g, ROOT, NO_REASONS).title).toBe("Wrote down why");
  });

  test("an undone step never folds into a live one", () => {
    const groups = groupOps([
      attribute(`${SCRATCH}/a.py`),
      { ...attribute(`${SCRATCH}/b.py`), undone_at: 1788770000 },
    ]);
    expect(groups.length).toBe(2);
  });

  test("kinds with nothing in common never fold", () => {
    const groups = groupOps([
      op({ kind: "conflict_open", summary: "Conflict on parseRow in src/rows.ts" }),
      op({ kind: "conflict_open", summary: "Conflict on toDate in src/time.ts" }),
    ]);
    expect(groups.length).toBe(2);
  });

  test("folding never reorders history — the lead is the row it stood on", () => {
    const rows = [attribute(`${SCRATCH}/a.py`), attribute(`${SCRATCH}/b.py`)];
    const g = only(groupOps(rows));
    expect(g.lead.op_id).toBe(rows[0].op_id);
    expect(g.id).toBe(rows[0].op_id);
  });
});

describe("no ids, no engine words", () => {
  test("nothing on an attribute line mentions the intent number or 'path(s)'", () => {
    const story = describeGroup(only(groupOps(TEN_FILES.map((p) => attribute(p)))), ROOT, NO_REASONS);
    const printed = [story.title, story.reason ?? "", story.note ?? ""].join(" ");
    expect(printed).not.toContain("1788769912");
    expect(printed).not.toContain("path(s)");
    expect(printed).not.toContain("intent");
    expect(printed).not.toContain("Attributed");
  });

  test("a logged reason drops the writer's prefix and the chat's placeholder", () => {
    const story = describeGroup(only(groupOps([logged(PROMPT, 1788769258)])), ROOT, NO_REASONS);
    expect(story.reason).not.toContain("Logged intent");
    expect(story.reason).not.toContain("[Image");
    expect(story.reason?.startsWith("these screens")).toBe(true);
  });

  test("a cut sentence ends on a whole word, not mid-syllable", () => {
    // 60 chars of the real prompt land on "...more wdith and ble".
    const story = describeGroup(only(groupOps([logged(PROMPT, 1788769258)])), ROOT, NO_REASONS);
    expect(story.reason?.endsWith("…")).toBe(true);
    expect(story.reason).not.toContain("ble…");
  });

  test("the full sentence wins over the cut one when the intent log has it", () => {
    const reasons = new Map([[1788769258, PROMPT]]);
    const story = describeGroup(only(groupOps([logged(PROMPT, 1788769258)])), ROOT, reasons);
    expect(story.reason).toBe("these screens as well, make it more wdith and blend it");
    expect(story.reason).not.toContain("…");
  });

  test("the reason those files were filed under is shown on the files line too", () => {
    const reasons = new Map([[1788769912, "ship the public demo call page"]]);
    const story = describeGroup(only(groupOps(TEN_FILES.map((p) => attribute(p)))), ROOT, reasons);
    expect(story.reason).toBe("ship the public demo call page");
  });

  test("a message that was only a screenshot quotes nothing rather than a stray bracket", () => {
    const story = describeGroup(only(groupOps([logged("[Image #1]", 1788769258)])), ROOT, NO_REASONS);
    expect(story.reason).toBeNull();
  });
});

describe("files are named, and placed", () => {
  test("a row prints the file's own name and keeps the full path for hover", () => {
    const f = fileFromPath(`${ROOT}/mirakash-marketing/src/app/_nav.tsx`, ROOT);
    expect(f.name).toBe("_nav.tsx");
    expect(f.outside).toBe(false);
    expect(f.path).toContain(ROOT);
  });

  test("scratch and notes files are marked as outside the project", () => {
    expect(fileFromPath(`${SCRATCH}/ecs_seed.py`, ROOT).outside).toBe(true);
    expect(fileFromPath(`${NOTES}/MEMORY.md`, ROOT).outside).toBe(true);
  });

  test("a sibling directory that merely starts with the root is not inside it", () => {
    expect(fileFromPath(`${ROOT}-old/x.ts`, ROOT).outside).toBe(true);
  });

  test("the screenshot's ten steps were all outside the project", () => {
    const story = describeGroup(only(groupOps(TEN_FILES.map((p) => attribute(p)))), ROOT, NO_REASONS);
    expect(outsideCount(story.files)).toBe(story.files.length);
  });

  test("a backup names the file it copied", () => {
    const g = only(groupOps([op({ kind: "snapshot", summary: `Snapshotted ${ROOT}/src/App.tsx` })]));
    const story = describeGroup(g, ROOT, NO_REASONS);
    expect(story.title).toBe("Kept a copy of App.tsx");
    expect(story.files[0].outside).toBe(false);
  });

  test("a burst of backups is one line that counts them", () => {
    const g = only(
      groupOps([
        op({ kind: "snapshot", summary: `Snapshotted ${ROOT}/a.ts` }),
        op({ kind: "snapshot", summary: `Snapshotted ${ROOT}/b.ts` }),
        op({ kind: "snapshot", summary: `Snapshotted ${ROOT}/c.ts` }),
      ]),
    );
    expect(describeGroup(g, ROOT, NO_REASONS).title).toBe("Kept a copy of 3 files");
  });

  test("a guarded revert names the file it put back", () => {
    const g = only(
      groupOps([
        op({
          kind: "guard_revert",
          summary: `Reverted ${ROOT}/src/App.tsx from snapshot`,
          undo_payload: { file: `${ROOT}/src/App.tsx`, snapshot_path: ".aura/snapshots/x.json" },
        }),
      ]),
    );
    expect(describeGroup(g, ROOT, NO_REASONS).title).toBe("Put App.tsx back the way it was");
  });
});

describe("nothing is invented when the data isn't there", () => {
  test("an attribute row with no paths falls back to its plain label, not a guess", () => {
    const g = only(groupOps([op({ kind: "intent_attribute", undo_payload: { intent_ts: 1 } })]));
    const story = describeGroup(g, ROOT, NO_REASONS);
    expect(story.title).toBe("Linked files to a reason");
    expect(story.files).toEqual([]);
    expect(story.reason).toBeNull();
  });

  test("a split with no matching intent row says only what it did", () => {
    const g = only(
      groupOps([
        op({
          kind: "intent_split",
          summary: "Split intent #1788769912 → #1788770004",
          undo_payload: { kept_ts: 1788769912, new_ts: 1788770004 },
        }),
      ]),
    );
    const story = describeGroup(g, ROOT, NO_REASONS);
    expect(story.title).toBe("Split one reason into two");
    expect(story.reason).toBeNull();
    expect(story.note).toBeNull();
  });

  test("the clash kinds keep their own words, which were already English", () => {
    const g = only(
      groupOps([op({ kind: "conflict_open", summary: "Conflict on parseRow in src/lib/rows.ts" })]),
    );
    const story = describeGroup(g, ROOT, NO_REASONS);
    expect(story.title).toBe("Found a clash");
    expect(story.note).toBe("Conflict on parseRow in src/lib/rows.ts");
  });

  test("a kind this file hasn't caught up with still names itself", () => {
    const g = only(groupOps([op({ kind: "future_kind", summary: "did a new thing" })]));
    const story = describeGroup(g, ROOT, NO_REASONS);
    expect(story.title).toBe("future_kind");
    expect(story.note).toBe("did a new thing");
  });

  test("a payload that isn't an object doesn't throw", () => {
    const g = only(groupOps([op({ kind: "intent_attribute", undo_payload: null })]));
    expect(() => describeGroup(g, ROOT, NO_REASONS)).not.toThrow();
  });
});

describe("the window shows no engine internals", () => {
  const DIALOG = `${import.meta.dir}/../src/components/dialogs/OpLogDialog.tsx`;
  const ROW = `${import.meta.dir}/../src/components/dialogs/opLog/OpGroupRow.tsx`;

  test("opening a line no longer prints the undo payload as JSON", async () => {
    // `JSON.stringify(op.undo_payload, null, 2)` in a <pre> was the expanded
    // state. It is the engine's data structure, verbatim, at the exact moment
    // someone clicked because they wanted to understand what happened.
    for (const f of [DIALOG, ROW]) {
      const src = await Bun.file(f).text();
      expect(src).not.toContain("undo_payload, null, 2");
      expect(src).not.toMatch(/JSON\.stringify\(/);
    }
  });

  test("neither file prints the engine's summary string into a row", async () => {
    // `{op.summary}` was the second column. Every id in the screenshot came
    // through it. The clash kinds' summaries are English and are carried
    // deliberately, as `story.note`, from describe.ts — not read off the op here.
    for (const f of [DIALOG, ROW]) {
      const src = await Bun.file(f).text();
      expect(src).not.toMatch(/\{\s*(?:op|lead)\.summary\s*\}/);
    }
  });
});

describe("cleanReason", () => {
  test("collapses the whitespace a stripped placeholder leaves behind", () => {
    expect(cleanReason("[Image #1]   fix   the   header")).toBe("fix the header");
  });

  test("handles the bracket forms the chat actually emits", () => {
    expect(cleanReason("[Image #12] a")).toBe("a");
    expect(cleanReason("[image 3] a")).toBe("a");
    expect(cleanReason("[Image] a")).toBe("a");
  });

  test("a truncation with a single long word keeps the word", () => {
    expect(cleanReason("supercalifragilistic", { truncated: true })).toBe("supercalifragilistic…");
  });
});

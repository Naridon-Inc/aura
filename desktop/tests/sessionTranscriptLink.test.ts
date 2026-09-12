// The link from a logged intent back to the conversation that produced it.
//
//   bun test ./tests/sessionTranscriptLink.test.ts
//
// A session's Transcript tab read "No live conversation recorded" while the
// transcript sat on disk — a 3.5 MB JSONL whose filename was printed in the
// row's own title. The row said which session it belonged to; nothing read it.
//
// Two writers stamp the same fact under two names. The desktop's
// `aura_log_intent` command writes `claude_session_id`; `aura log-intent` (the
// hook and terminal path, which writes almost every row in a real log) writes
// `session_id`. Correlation only ever looked at the first, so on one worktree's
// log — 8290 rows, 6751 of them carrying `session_id`, none carrying
// `claude_session_id` — every row fell through to the ±3h nearest-mtime guess.
// Measured against the 1437 rows whose true transcript was still on disk, that
// guess picked the right file 0 times: 58% showed a *different* session's
// conversation and 41% showed the empty state. mtime is a file's LAST write, so
// a long session's transcript ends hours after the row that came from it, and
// whichever unrelated session happened to stop nearby wins.
//
// So the rules pinned here are: a stated id wins outright, it is honoured under
// either field name, it is only honoured when it names a session we actually
// have, and it never lets a non-Claude agent's id resolve to a Claude
// transcript.

import { describe, expect, test } from "bun:test";

import type { ClaudeSession, IntentRow } from "../src/lib/api";
import {
  correlateClaudeSession,
  sessionKeyOf,
  statedSessionId,
} from "../src/lib/sessionMeta";

// A fixed clock so "an hour later" means an hour, not whenever the suite runs.
const NOW = 1_788_000_000;

function session(id: string, mtime: number): ClaudeSession {
  return {
    session_id: id,
    mtime,
    first_prompt: "",
    last_prompt: "",
    turn_count: 1,
    step_count: 1,
    file_path: `/Users/x/.claude/projects/-repo/${id}.jsonl`,
    cwd_rel: "",
  };
}

function row(over: Partial<IntentRow> = {}): IntentRow {
  return {
    timestamp: NOW,
    agent_id: "Claude",
    intent: "Claude Edit on src/main.rs",
    ...over,
  };
}

// The real shape of the failure: the row's own session ran long and its file
// was last written hours later, while a short unrelated session stopped right
// next to the row's timestamp. Nearest-by-mtime picks the stranger.
const MINE = session("9e7c366c-c903-4da9-898e-91cd85f70274", NOW + 6 * 3600);
const STRANGER = session("11111111-2222-3333-4444-555555555555", NOW + 120);

describe("statedSessionId", () => {
  test("reads the field the hook writes", () => {
    expect(statedSessionId(row({ session_id: MINE.session_id }))).toBe(
      MINE.session_id,
    );
  });

  test("reads the field the desktop writes", () => {
    expect(statedSessionId(row({ claude_session_id: MINE.session_id }))).toBe(
      MINE.session_id,
    );
  });

  test("the desktop's stamp wins when a row somehow carries both", () => {
    const both = row({
      claude_session_id: MINE.session_id,
      session_id: STRANGER.session_id,
    });
    expect(statedSessionId(both)).toBe(MINE.session_id);
  });

  test("a row that states nothing states nothing", () => {
    expect(statedSessionId(row())).toBe("");
    expect(statedSessionId(row({ session_id: "   " }))).toBe("");
  });
});

describe("correlateClaudeSession", () => {
  test("the row's own session wins over the one that merely stopped nearby", () => {
    // Before the fix this returned STRANGER — a different conversation shown
    // under this run's name.
    const got = correlateClaudeSession(
      row({ session_id: MINE.session_id }),
      [STRANGER, MINE],
    );
    expect(got?.session_id).toBe(MINE.session_id);
  });

  test("a stated id is honoured even when nothing is close in time", () => {
    // The 41% case: no session within ±3h, so the guess gave up and the tab
    // said "No live conversation recorded" about a file we had all along.
    const far = session(MINE.session_id, NOW + 40 * 3600);
    const got = correlateClaudeSession(row({ session_id: far.session_id }), [far]);
    expect(got?.session_id).toBe(far.session_id);
  });

  test("the desktop's own field still works", () => {
    const got = correlateClaudeSession(
      row({ claude_session_id: MINE.session_id }),
      [STRANGER, MINE],
    );
    expect(got?.session_id).toBe(MINE.session_id);
  });

  test("a codex session id never resolves to a Claude transcript", () => {
    // `session_id` holds whichever agent CLI's id the environment named, so a
    // Codex row can carry one. It must not match, and the agent gate must still
    // stop it borrowing a nearby Claude conversation instead.
    const got = correlateClaudeSession(
      row({ agent_id: "codex", session_id: "codex-01H8XYZ" }),
      [STRANGER, MINE],
    );
    expect(got).toBeNull();
  });

  test("an id naming a transcript we don't have resolves to nothing, not to a neighbour", () => {
    // Claude Code clears `~/.claude/projects` after a few weeks, so most older
    // rows name a file nobody has. The row still told us WHICH conversation it
    // came from, which makes every other one a known-wrong answer — and the
    // nearest-by-mtime neighbour was a stranger for 3334 of the 5314 such rows
    // in one worktree's log. The tab says the conversation is gone instead.
    const got = correlateClaudeSession(
      row({ session_id: "deleted-weeks-ago" }),
      [STRANGER],
    );
    expect(got).toBeNull();
  });

  test("a row that states nothing still gets the nearest in time", () => {
    const got = correlateClaudeSession(row(), [STRANGER, MINE]);
    expect(got?.session_id).toBe(STRANGER.session_id);
  });
});

describe("sessionKeyOf", () => {
  test("rows of one session group under it, whichever field named it", () => {
    const a = sessionKeyOf(row({ session_id: MINE.session_id }), [STRANGER, MINE]);
    const b = sessionKeyOf(
      row({ timestamp: NOW + 900, claude_session_id: MINE.session_id }),
      [STRANGER, MINE],
    );
    expect(a).toBe(`sid:${MINE.session_id}`);
    expect(b).toBe(a);
  });

  test("two different sessions do not collapse into one", () => {
    const a = sessionKeyOf(row({ session_id: MINE.session_id }), [STRANGER, MINE]);
    const b = sessionKeyOf(
      row({ session_id: STRANGER.session_id }),
      [STRANGER, MINE],
    );
    expect(a).not.toBe(b);
  });
});

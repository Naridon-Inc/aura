// sessionMeta — shared helpers for the Trace "Sessions" surfaces. The
// intent log (`auraIntentRecent`) is the spine of the list, but the guard's
// `[auto] … backfill pending` placeholder rows carry a real changeset under a
// junk title. Rather than drop them (that would erase agent activity that
// never called aura_log_intent), we *relabel* them with the agent's real
// prompt by correlating to the matching Claude Code session
// (`claudeListSessions`, which exposes the actual first/last prompt).

import { type ClaudeSession, type IntentRow } from "./api";

/** The guard's current placeholder, agent_mutation_guard.rs:516 —
 *  `"{agent_id} edited {n} file(s) — reason not captured yet"`. Pinned to the
 *  Rust by a test, because the earlier `[auto] …` shape below is what this
 *  check knew for months after the guard had stopped writing it. */
const GUARD_STUB_TEXT = /\bedited \d+ file\(s\)\s*[—–-]\s*reason not captured yet\b/i;

/** True for a guard auto-stub by its intent *text* alone — either the current
 *  "<agent> edited N file(s) — reason not captured yet" or the legacy
 *  "[auto] … backfill pending". Used where only the prompt string is in hand
 *  (e.g. the per-commit Intent ↔ AST report, whose stated-intent rows carry no
 *  changeset), so it has to know every shape the guard has ever written. */
export function isAutoStubText(intent: string): boolean {
  const text = (intent ?? "").trim();
  return text.startsWith("[auto] ") || GUARD_STUB_TEXT.test(text);
}

/** True for the guard's auto-generated placeholder intents — the
 *  `[auto] … backfill pending` rows written when an agent edited files
 *  without logging intent. Real changeset, junk title. */
export function isAutoStub(row: IntentRow): boolean {
  return row.changeset?.source === "guard_auto_stub" || isAutoStubText(row.intent);
}

// ── Where a row's "why" came from ────────────────────────────────────────────
// The guard resolves a reason from three places, best first, and stamps which
// one it used on `changeset.source` (agent_mutation_guard.rs:504-525):
//
//   session_prompt   your own words, read out of the live session transcript
//   brain_inferred   Aura's model, given the diff and asked to write the reason
//   guard_auto_stub  nothing was available — "<agent> edited N file(s)"
//
// Nothing on screen has ever read that field except `isAutoStub`, so all three
// arrived looking the same: a sentence under the heading "Reason", inside a card
// that says "Aura locked exactly what the AI changed and why."
//
// The middle one is the problem. Its prompt is "A coding agent changed these
// files but didn't say why. Read the diff and write the reason as ONE terse line
// … It becomes the 'why' in an audit trail" (agent_mutation_guard.rs:849). What
// comes back is a description of the change, and it is presented as the reason
// for the change. It also cannot fail the Intent ↔ AST check that is the point
// of this product, because it was written FROM the AST — it agrees with the diff
// by construction. An audit trail whose weakest rows are its most agreeable ones
// is worse than one with holes in it, because you can see a hole.

export type IntentProvenance = "stated" | "asked" | "inferred" | "uncaptured";

/** Where this row's "why" came from — see the note above. A row with no
 *  `source` came through `aura_log_intent` proper: somebody stated it. */
export function intentProvenance(row: IntentRow): IntentProvenance {
  if (isAutoStubText(row.intent)) return "uncaptured";
  switch (row.changeset?.source) {
    case "guard_auto_stub":
      return "uncaptured";
    case "brain_inferred":
      return "inferred";
    case "session_prompt":
      return "asked";
    default:
      return "stated";
  }
}

/** Provenance of a string a surface is about to *show*, which is not always the
 *  provenance of `row.intent`: an auto-stub row has no reason of its own, so
 *  both the list and the detail pane swap in the correlated session's prompt.
 *  Pass that prompt if one was used — the caller knows, this can't.
 *
 *  Both callers used to work this out themselves. They agreed, which is the
 *  only reason it wasn't already a bug. */
export function displayedProvenance(
  row: IntentRow,
  borrowedPrompt: string | null | undefined,
): IntentProvenance {
  if (isAutoStub(row)) return borrowedPrompt ? "asked" : "uncaptured";
  return intentProvenance(row);
}

/** Provenance of exactly what `sessionDisplayTitle` returns for this row, for
 *  the list surfaces that call it. Kept beside that function so the two can't
 *  drift into showing one thing and meaning another. */
export function titleProvenance(
  row: IntentRow,
  sessions: ClaudeSession[],
): IntentProvenance {
  if (!isAutoStub(row)) return intentProvenance(row);
  const s = correlateClaudeSession(row, sessions);
  return displayedProvenance(row, s ? s.last_prompt || s.first_prompt : "");
}

/** The heading over the body text. Not "Reason" unless it is one.
 *  `statedLabel` lets a surface keep its own wording for the ordinary case —
 *  the Time Machine card says "Why this happened", which is right for a stated
 *  reason and a bare falsehood over the other three. */
export function provenanceLabel(p: IntentProvenance, statedLabel = "Reason"): string {
  switch (p) {
    case "asked":
      return "What you asked for";
    case "inferred":
      return "Aura's read of the change";
    case "uncaptured":
      return "No reason was given";
    default:
      return statedLabel;
  }
}

/** A one-or-two-word marker for a scan-list row, where there is no room to
 *  explain and no time to read.
 *
 *  Only the inferred case gets one, and the rule is one bit: *did a machine
 *  write this sentence?* A stated reason and a session prompt are both somebody's
 *  words. An uncaptured row already announces itself — its title is literally
 *  "Agent edited 3 files". Only the model's line arrives looking exactly like a
 *  reason a person gave, so only it needs marking, and a marker on every row
 *  would be a marker nobody reads. */
export function provenanceTag(p: IntentProvenance): string {
  return p === "inferred" ? "Aura's summary" : "";
}

/** One line under the body saying who wrote it, where that isn't obvious.
 *  Empty for a stated reason — that's the ordinary case and needs no note. */
export function provenanceNote(p: IntentProvenance): string {
  switch (p) {
    case "asked":
      return "Taken from what you typed at the start of this session. Nobody wrote a reason for the change itself.";
    case "inferred":
      return "Nobody said why, so Aura read the change and wrote this. It describes what happened. Treat it as a summary, not as the reason.";
    case "uncaptured":
      return "The files changed while an agent was running and no reason was recorded.";
    default:
      return "";
  }
}

// ±15 min around the run timestamp — wide enough to bracket a session that
// kept being written after the edit, tight enough to avoid grabbing an
// unrelated run hours away. Used by the *commit-level* correlation
// (IntentInspector), which has no durable id to lean on.
const CORRELATE_WINDOW_S = 15 * 60;

// Repair window for *row-level* correlation when a row has no stamped session
// id (older / backfilled commits). A Claude session that produced a commit was
// active at the commit time but its file mtime is its *last* write, often an
// hour-plus later as the session kept going. The tight ±15min then misses, so
// the empty-transcript fallback widens to ±3h and still picks the nearest —
// best-effort relabeling, deliberately looser than the exact-id path above it.
const REPAIR_WINDOW_S = 3 * 60 * 60;

/** Nearest Claude session to an arbitrary unix-second timestamp, within the
 *  given window (default ±15min) — or null when nothing is close enough. Pure
 *  time match (no agent gate), for commit-level correlation where the caller
 *  has no agent id. */
export function nearestSessionByTime(
  ts: number,
  sessions: ClaudeSession[],
  windowS: number = CORRELATE_WINDOW_S,
): ClaudeSession | null {
  let best: ClaudeSession | null = null;
  let bestDelta = Infinity;
  for (const s of sessions) {
    const delta = Math.abs(s.mtime - ts);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return best && bestDelta <= windowS ? best : null;
}

/** Resolve the Claude Code session for an intent row.
 *
 *  1. **Durable link** — when the row carries a `claude_session_id` (stamped at
 *     log-intent time), match it exactly. This is authoritative: no time
 *     guessing, no agent gate, immune to a session that ran for hours.
 *  2. **Heuristic repair** — older / backfilled rows have no stamp, so fall back
 *     to the nearest claude session by mtime within the widened repair window.
 *     Gated so a row authored by a *different* agent never borrows a Claude
 *     transcript. Returns null when nothing is plausibly close. */
export function correlateClaudeSession(
  row: IntentRow,
  sessions: ClaudeSession[],
): ClaudeSession | null {
  const sid = (row.claude_session_id ?? "").trim();
  if (sid) {
    const exact = sessions.find((s) => s.session_id === sid);
    if (exact) return exact;
    // Stamped but not in the listed set (file pruned / rotated). Fall through
    // to the time heuristic rather than giving up on a transcript entirely.
  }
  // The only transcripts we have are Claude Code sessions. So correlate every
  // row EXCEPT ones explicitly tagged as a different agent (codex, gemini, …),
  // whose real session is not a Claude jsonl. Crucially, `MCP Agent` is Claude
  // Code itself logging through the aura-vcs MCP server — its transcript *is* a
  // Claude session — and the old `includes("claude")` allowlist wrongly dropped
  // it, leaving the dominant case (almost every logged intent) with an empty
  // transcript. Blank / unknown defaults to allowed.
  if (isNonClaudeAgent(row.agent_id)) return null;
  return nearestSessionByTime(row.timestamp, sessions, REPAIR_WINDOW_S);
}

// Agents that keep their *own* (non-Claude) session logs. A row tagged with one
// of these must never borrow a nearby Claude transcript. Anything else —
// "claude*", "MCP Agent", "user", blank — is treated as Claude-correlatable.
const NON_CLAUDE_AGENTS = [
  "codex",
  "gemini",
  "copilot",
  "cursor",
  "aider",
  "openai",
  "gpt-",
  "qwen",
  "deepseek",
  "grok",
];

export function isNonClaudeAgent(agentId: string | null | undefined): boolean {
  const agent = (agentId ?? "").toLowerCase();
  if (!agent) return false;
  return NON_CLAUDE_AGENTS.some((a) => agent.includes(a));
}

/** The human title for a session row: the agent's real prompt when we can
 *  correlate it, the logged intent for genuine intents, or a clean generic
 *  for an uncorrelated auto-stub. Never surfaces `[auto] … backfill pending`. */
export function sessionDisplayTitle(
  row: IntentRow,
  sessions: ClaudeSession[],
): string {
  if (!isAutoStub(row)) {
    return row.intent || "(no prompt)";
  }
  const s = correlateClaudeSession(row, sessions);
  const prompt = s ? s.last_prompt || s.first_prompt : "";
  if (prompt) return prompt;
  const n = row.changeset?.files?.length ?? 0;
  return n > 0 ? `Agent edited ${n} file${n === 1 ? "" : "s"}` : "Agent session";
}

// ── Collapsing a run's auto-stub spam into one entry per session ──────────────
// Every list that reads the intent log hits the same problem: during a long
// autonomous run the guard writes an `[auto]` stub for every file the agent
// touches without logging a reason, and each stub borrows the session's first
// prompt as its title — so the surface fills with dozens of identically-named
// rows. These helpers fold a session's stubs into a single entry, keeping
// genuine logged intents (real reasoning) as their own rows. Shared so every
// surface collapses identically; never applied where individual intents are
// the point (split/merge, attestations, the contributions scatter).

export type SessionChurn = {
  files: number;
  adds: number;
  dels: number;
  hasChurn: boolean;
};

/** Sum additions/deletions across a row's changeset (null → 0). */
export function churnOf(row: IntentRow): SessionChurn {
  const files = row.changeset?.files ?? [];
  let adds = 0;
  let dels = 0;
  let sawAny = false;
  for (const f of files) {
    if (typeof f.additions === "number") {
      adds += f.additions;
      sawAny = true;
    }
    if (typeof f.deletions === "number") {
      dels += f.deletions;
      sawAny = true;
    }
  }
  return { files: files.length, adds, dels, hasChurn: sawAny };
}

/** A row as a list actually shows it. Genuine logged intents map 1:1
 *  (`editCount` 1). A run's auto-stubs collapse into one entry per session,
 *  with `files`/`adds`/`dels` aggregated across the run and `row` set to the
 *  newest stub so opening it still correlates to the right Claude transcript.
 *  `paths` is the de-duplicated union of every file the collapsed entry
 *  touched — so a feed can still flag "overlaps a file you're editing" across
 *  the whole session, not just the representative stub. */
export type SessionDisplayRow = {
  row: IntentRow;
  editCount: number;
  files: number;
  adds: number;
  dels: number;
  hasChurn: boolean;
  paths: string[];
};

/** The identity an auto-stub row collapses under: the durable Claude session
 *  id, else the correlated session's id, else the resolved title. Keying on
 *  the title as a last resort is deliberate — the visible symptom *is* the
 *  identical name, so two uncorrelated stubs that read the same still merge. */
export function sessionKeyOf(row: IntentRow, sessions: ClaudeSession[]): string {
  const stamped = (row.claude_session_id ?? "").trim();
  if (stamped) return `sid:${stamped}`;
  const corr = correlateClaudeSession(row, sessions);
  if (corr?.session_id) return `sid:${corr.session_id}`;
  return `title:${sessionDisplayTitle(row, sessions)}`;
}

/** Collapse a row list into display rows: genuine intents pass through 1:1; a
 *  session's auto-stubs fold into a single entry placed at their first
 *  occurrence, with files de-duplicated and churn summed across the run. Input
 *  order is preserved (each collapsed session sits at its first-seen stub), so
 *  pass rows in the order you want to display them — typically newest-first. */
export function collapseAutoStubSessions(
  rows: IntentRow[],
  sessions: ClaudeSession[],
): SessionDisplayRow[] {
  const out: SessionDisplayRow[] = [];
  // sessionKey → { index into `out`, set of file paths already counted }.
  const open = new Map<string, { idx: number; files: Set<string> }>();

  for (const row of rows) {
    const churn = churnOf(row);
    const paths = (row.changeset?.files ?? [])
      .map((f) => f.path)
      .filter((p): p is string => typeof p === "string");
    if (!isAutoStub(row)) {
      out.push({
        row,
        editCount: 1,
        files: churn.files,
        adds: churn.adds,
        dels: churn.dels,
        hasChurn: churn.hasChurn,
        paths,
      });
      continue;
    }
    const key = sessionKeyOf(row, sessions);
    const existing = open.get(key);
    if (!existing) {
      const fileSet = new Set<string>(paths);
      out.push({
        row,
        editCount: 1,
        files: fileSet.size || churn.files,
        adds: churn.adds,
        dels: churn.dels,
        hasChurn: churn.hasChurn,
        paths: [...fileSet],
      });
      open.set(key, { idx: out.length - 1, files: fileSet });
      continue;
    }
    const agg = out[existing.idx];
    agg.editCount += 1;
    for (const p of paths) existing.files.add(p);
    agg.files = existing.files.size || agg.files + churn.files;
    agg.adds += churn.adds;
    agg.dels += churn.dels;
    agg.hasChurn = agg.hasChurn || churn.hasChurn;
    agg.paths = [...existing.files];
  }
  return out;
}

/** Count the distinct sessions in a row list (post-collapse) — what an
 *  honest "N sessions" metric should report instead of raw intent-log rows. */
export function countSessions(
  rows: IntentRow[],
  sessions: ClaudeSession[],
): number {
  return collapseAutoStubSessions(rows, sessions).length;
}

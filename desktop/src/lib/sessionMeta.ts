// sessionMeta — shared helpers for the Trace "Sessions" surfaces. The
// intent log (`auraIntentRecent`) is the spine of the list, but the guard's
// `[auto] … backfill pending` placeholder rows carry a real changeset under a
// junk title. Rather than drop them (that would erase agent activity that
// never called aura_log_intent), we *relabel* them with the agent's real
// prompt by correlating to the matching Claude Code session
// (`claudeListSessions`, which exposes the actual first/last prompt).

import {
  isMechanicalHookCapture,
  type ClaudeSession,
  type IntentRow,
} from "./api";

/** The preamble the Stop hook writes ahead of an agent's whole closing message
 *  (`agent_event_listener.rs:723`), so what follows is a page of markdown
 *  rather than a line of prose. The console strips the same thing in
 *  `aura-console-next/src/data/adapt.ts`. */
const TURN_REPORT = /^agent turn complete\s*(?::\s*|$)/i;

/** Is this row the agent's own account of the turn it just finished?
 *
 *  It is not a reason anybody gave for a change, and it is not what the user
 *  asked for. It is the agent saying what it believes it did — useful, and
 *  worth reading, and the one thing a reviewer must not mistake for either of
 *  the other two. */
export function isAgentTurnReport(row: IntentRow): boolean {
  return TURN_REPORT.test((row.intent ?? "").trim());
}

/** One scannable line out of something written as a page.
 *
 *  A closing message is markdown with headings, bullets and bold in it. Left
 *  alone, a list row gets the machine preamble and nothing else, because the
 *  preamble is the whole visible width. Mirrors the console's `oneLine`. */
function firstLine(text: string): string {
  const line = text
    .replace(TURN_REPORT, "")
    .split(/\r?\n/, 1)[0]
    // Emphasis and inline code mean nothing on one unstyled line; the words
    // inside them do. Underscore stays: it is part of an identifier about as
    // often as it is emphasis, and `require_plan` losing its middle is worse
    // than an italic surviving.
    .replace(/[`*#>]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/(?:…|\.\.\.)\s*$/, "")
    .trim();
  return line || text.trim();
}

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

export type IntentProvenance =
  | "stated"
  | "asked"
  | "reported"
  | "inferred"
  | "uncaptured";

/** Where this row's "why" came from — see the note above. A row with no
 *  `source` came through `aura_log_intent` proper: somebody stated it. */
export function intentProvenance(row: IntentRow): IntentProvenance {
  if (isAutoStubText(row.intent)) return "uncaptured";
  // A run whose whole record is tool calls. One of these is kept per session so
  // the run is not silently absent, and the honest thing it can say is that
  // nobody wrote down a request. The commands are still on the row.
  if (isMechanicalHookCapture(row)) return "uncaptured";
  // The agent's closing message. It arrives as prose in the same field a stated
  // reason uses, so without this it reads as one.
  if (isAgentTurnReport(row)) return "reported";
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
    case "reported":
      return "What the agent said it did";
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
 *  The rule is one bit: *did the person whose work this is write this
 *  sentence?* A stated reason and a session prompt are both their words, so
 *  neither is marked. An uncaptured row already announces itself — its title is
 *  literally "Agent edited 3 files". The two that need marking both arrive
 *  looking exactly like a reason a person gave: the line Aura's model wrote
 *  from the diff, and the agent's own closing message. A marker on every row
 *  would be a marker nobody reads. */
export function provenanceTag(p: IntentProvenance): string {
  if (p === "inferred") return "Aura's summary";
  if (p === "reported") return "Agent's account";
  return "";
}

/** One line under the body saying who wrote it, where that isn't obvious.
 *  Empty for a stated reason — that's the ordinary case and needs no note. */
export function provenanceNote(p: IntentProvenance): string {
  switch (p) {
    case "asked":
      return "Taken from what you typed at the start of this session. Nobody wrote a reason for the change itself.";
    case "reported":
      return "The agent's own account of the turn it just finished. It is what the agent says it did, which is not the same as what you asked for or what Aura checked.";
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

// ── Per-list indexes ─────────────────────────────────────────────────────────
// Correlation used to scan the whole session list for every row, and the list
// surfaces call it several times per row — once to collapse, once to title,
// again on every render. With a few hundred rows against a few hundred
// sessions that is six figures of comparisons on each keystroke-sized state
// change, which is exactly the stall people feel when Sessions opens.
//
// So each session array gets an index built once, hung off the array itself in
// a WeakMap: an id lookup, an mtime-sorted view for the nearest-in-time
// search, and memo tables for the two derived values. `claudeListSessions`
// hands back a fresh array whenever the data actually changes, so a new array
// identity is precisely the signal that the index must be rebuilt — no manual
// invalidation, and nothing retained once the array is dropped.

type Timed = { session: ClaudeSession; order: number };

type SessionIndex = {
  /** The array this index was built from — held so helpers that take the raw
   *  list can be reached without minting a new array (which would look like
   *  new data and rebuild the index on every call). */
  all: ClaudeSession[];
  byId: Map<string, ClaudeSession>;
  /** Ascending by mtime; `order` is the position in the original array, kept
   *  so ties resolve exactly as the old linear scan resolved them. */
  byTime: Timed[];
  correlated: WeakMap<IntentRow, ClaudeSession | null>;
  titles: WeakMap<IntentRow, string>;
};

const sessionIndexes = new WeakMap<ClaudeSession[], SessionIndex>();

function indexFor(sessions: ClaudeSession[]): SessionIndex {
  const hit = sessionIndexes.get(sessions);
  if (hit) return hit;
  const byId = new Map<string, ClaudeSession>();
  for (const s of sessions) {
    // First writer wins, matching `find`'s "first match" semantics.
    if (s.session_id && !byId.has(s.session_id)) byId.set(s.session_id, s);
  }
  const byTime = sessions
    .map((session, order) => ({ session, order }))
    .sort((a, b) => a.session.mtime - b.session.mtime || a.order - b.order);
  const built: SessionIndex = {
    all: sessions,
    byId,
    byTime,
    correlated: new WeakMap(),
    titles: new WeakMap(),
  };
  sessionIndexes.set(sessions, built);
  return built;
}

/** Nearest Claude session to an arbitrary unix-second timestamp, within the
 *  given window (default ±15min) — or null when nothing is close enough. Pure
 *  time match (no agent gate), for commit-level correlation where the caller
 *  has no agent id. */
export function nearestSessionByTime(
  ts: number,
  sessions: ClaudeSession[],
  windowS: number = CORRELATE_WINDOW_S,
): ClaudeSession | null {
  const { byTime } = indexFor(sessions);
  if (byTime.length === 0) return null;

  // First entry whose mtime is >= ts. The nearest session is that one or the
  // one before it — |mtime − ts| only grows as you walk away from the seam.
  let lo = 0;
  let hi = byTime.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byTime[mid].session.mtime < ts) lo = mid + 1;
    else hi = mid;
  }

  let best: Timed | null = null;
  let bestDelta = Infinity;
  // Walk outward from the seam while the distance is still tied with the best
  // seen. Repeated mtimes are common (sessions written in the same second), so
  // this is what preserves the old scan's "earliest in the array wins" rule.
  for (let i = lo - 1; i >= 0; i--) {
    const delta = Math.abs(byTime[i].session.mtime - ts);
    if (delta > bestDelta) break;
    if (!best || delta < bestDelta || byTime[i].order < best.order) {
      bestDelta = delta;
      best = byTime[i];
    }
  }
  for (let i = lo; i < byTime.length; i++) {
    const delta = Math.abs(byTime[i].session.mtime - ts);
    if (delta > bestDelta) break;
    if (!best || delta < bestDelta || byTime[i].order < best.order) {
      bestDelta = delta;
      best = byTime[i];
    }
  }
  return best && bestDelta <= windowS ? best.session : null;
}

/** The session id a row states about itself, whichever writer wrote it.
 *
 *  Two capture paths stamp the same fact under two names, and reading only one
 *  of them was why the Transcript tab said "No live conversation recorded"
 *  while a multi-megabyte JSONL sat on disk with that exact stem:
 *
 *  - `claude_session_id` — the desktop `aura_log_intent` command.
 *  - `session_id` — `aura log-intent`, the hook / terminal path, which writes
 *    the overwhelming majority of rows. It holds whatever the agent CLI put in
 *    the environment (`CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`, …), so it
 *    is only a *candidate*: callers confirm it against the listed sessions
 *    before trusting it, which is what keeps a Codex id from ever resolving to
 *    a Claude transcript.
 *
 *  Empty string when the row states nothing. */
export function statedSessionId(row: IntentRow): string {
  const stamped = (row.claude_session_id ?? "").trim();
  if (stamped) return stamped;
  return (row.session_id ?? "").trim();
}

/** Resolve the Claude Code session for an intent row.
 *
 *  1. **Durable link** — when the row states a session id (see
 *     {@link statedSessionId}), match it exactly against the listed sessions.
 *     This is authoritative: no time guessing, no agent gate, immune to a
 *     session that ran for hours.
 *  2. **Heuristic repair** — older / backfilled rows state nothing, so fall back
 *     to the nearest claude session by mtime within the widened repair window.
 *     Gated so a row authored by a *different* agent never borrows a Claude
 *     transcript. Returns null when nothing is plausibly close. */
export function correlateClaudeSession(
  row: IntentRow,
  sessions: ClaudeSession[],
): ClaudeSession | null {
  const index = indexFor(sessions);
  const memo = index.correlated;
  if (memo.has(row)) return memo.get(row) ?? null;
  const answer = correlateUncached(row, index);
  memo.set(row, answer);
  return answer;
}

function correlateUncached(
  row: IntentRow,
  index: SessionIndex,
): ClaudeSession | null {
  const sessions = index.all;
  const sid = statedSessionId(row);
  if (sid) {
    const exact = index.byId.get(sid);
    if (exact) return exact;
    // Stated, and we do not have it. Claude Code clears `~/.claude/projects`
    // after a few weeks, so this is the ordinary fate of an older row. The
    // heuristic below must NOT run here: this row told us which conversation it
    // came from, so any other one is known to be the wrong answer, and the
    // nearest-by-mtime neighbour is a stranger 62% of the time (measured over
    // 5314 such rows in one worktree's log). Losing the transcript is honest;
    // showing somebody else's under this run's name is not.
    return null;
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
 *  for an uncorrelated auto-stub. Never surfaces `[auto] … backfill pending`,
 *  and never a raw command line — see the two guards below. */
export function sessionDisplayTitle(
  row: IntentRow,
  sessions: ClaudeSession[],
): string {
  // A run whose entire record is tool calls. Its text is "running Bash on
  // bash /private/tmp/…", which is a thing that happened, not a thing anybody
  // set out to do — and putting it here is what made Trace list temp-file
  // paths as sessions. The commands stay on the row as evidence; the headline
  // says the true thing instead, which is that nobody wrote the request down.
  if (isMechanicalHookCapture(row)) return "No request was recorded";
  if (!isAutoStub(row)) {
    const text = (row.intent ?? "").trim();
    return text ? firstLine(text) : "(no prompt)";
  }
  // Every row re-derives its title on every render, and the stub path below
  // correlates to get there. Memoized per (session list, row) so a re-render
  // that changed nothing about the data costs a map lookup.
  const memo = indexFor(sessions).titles;
  const cached = memo.get(row);
  if (cached !== undefined) return cached;
  const title = autoStubTitle(row, sessions);
  memo.set(row, title);
  return title;
}

function autoStubTitle(row: IntentRow, sessions: ClaudeSession[]): string {
  const s = correlateClaudeSession(row, sessions);
  const prompt = s ? s.last_prompt || s.first_prompt : "";
  if (prompt) return firstLine(prompt);
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
  const stamped = statedSessionId(row);
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

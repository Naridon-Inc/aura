// sessionMeta — shared helpers for the Trace "Sessions" surfaces. The
// intent log (`auraIntentRecent`) is the spine of the list, but the guard's
// `[auto] … backfill pending` placeholder rows carry a real changeset under a
// junk title. Rather than drop them (that would erase agent activity that
// never called aura_log_intent), we *relabel* them with the agent's real
// prompt by correlating to the matching Claude Code session
// (`claudeListSessions`, which exposes the actual first/last prompt).

import { type ClaudeSession, type IntentRow } from "./api";

/** True for a guard auto-stub by its intent *text* alone (`[auto] …`). Used
 *  where only the prompt string is in hand (e.g. the per-commit Intent ↔ AST
 *  report, whose stated-intent rows carry no changeset). */
export function isAutoStubText(intent: string): boolean {
  return (intent ?? "").trim().startsWith("[auto] ");
}

/** True for the guard's auto-generated placeholder intents — the
 *  `[auto] … backfill pending` rows written when an agent edited files
 *  without logging intent. Real changeset, junk title. */
export function isAutoStub(row: IntentRow): boolean {
  return row.changeset?.source === "guard_auto_stub" || isAutoStubText(row.intent);
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

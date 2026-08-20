// goalStore — goals as durable, associable records, not a transient check.
//
// A goal is a requirement ("users can sign in via Google") plus the
// instances it was assigned-to or aligned-with: the task it belongs under
// AND the run(s) that proved it. One shared GoalRecord is the join — proving
// a goal from a session adds a run verdict to the record, and a task linked
// to that same record sees the verdict surface in its own card. "Reached" is
// just the record's latest run verdict.
//
// Storage is repo-scoped localStorage (`aura.goals.<repoRoot>`), the same
// pattern ProvePane already used for its last goal. It's deliberately a thin
// frontend layer over the unchanged `aura prove` engine; if/when a Rust-side
// goal store lands, this module is the seam to back it with one.

import { useSyncExternalStore } from "react";
import type { ProveOutcome, ProveResult } from "./prove";
import { verdictOf } from "./prove";

export type GoalVerdict = "verified" | "partial" | "not_wired" | "unknown";

/** Where a goal came from. `"ask"` — auto-born from a coding session's opening
 *  prompt (the thing you asked the AI to build). `"manual"` — typed by hand. */
export type GoalSource = "ask" | "manual";

/** The session an auto-born goal was derived from — what you asked, and where.
 *  Lets the goal link back to the run that worked it without a re-scan. */
export type GoalOrigin = {
  /** Claude/agent session id the ask was read from. */
  sessionId: string;
  agentId?: string;
  /** The verbatim ask, before any cleanup, for "you asked: …". */
  askText: string;
  /** Unix millis we first saw this ask. */
  firstSeen: number;
};

export type GoalRun = {
  /** Stable key for the run that proved this goal: a session's
   *  `signed_block_id`, else `claude_session_id`, else `agent:timestamp`;
   *  `"adhoc"` for a repo-wide check run from the Goals workbench;
   *  `"build:<sha>"` for an auto-prove run the post-commit hook recorded. */
  runKey: string;
  /** Human label for the run (intent headline / "Ad-hoc check"). */
  label?: string;
  agentId?: string;
  verdict: GoalVerdict;
  /** Wired / total semantic links at the time of this run. */
  ok: number;
  total: number;
  /** Unix millis. */
  at: number;
  /** Short commit sha this run was checked at — the reverse code↔goal link
   *  (which build delivered this goal). Set by the ledger; absent for legacy
   *  localStorage-only runs. */
  commit?: string | null;
  /** What drove this run: `"manual"`, `"build"` (auto-prove on commit). */
  trigger?: string | null;
  /** The files the proven parts live in — what code delivered the goal. */
  files?: string[];
};

/** One checkable part a goal was broken into (mirrors the ledger's cached
 *  decomposition). `mustCall` names a function the part must reach when set. */
export type GoalRequirement = {
  nodeName: string;
  nodeType: string;
  mustCall: string | null;
};

/** The cached breakdown of a goal into parts — done once, reused on every
 *  re-prove. Surfaced so the detail view can say "what it needs" in advance. */
export type GoalDecomposition = {
  requirements: GoalRequirement[];
  decomposedAt?: number;
};

export type GoalRecord = {
  id: string;
  text: string;
  /** Task this goal was assigned under (task uuid). */
  taskId?: string | null;
  /** `AURA-<n>` sequence for display without a task fetch. */
  taskSeq?: number | null;
  /** Plain-language verify plan — the human-readable "what to test" checks a
   *  planner or human wrote, distinct from the machine `decomposition`. Empty
   *  when none. Rendered as a checklist on the goal + task-detail surfaces. */
  acceptance?: string[];
  /** Newest-first run verdicts, capped. */
  runs: GoalRun[];
  /** The goal's cached breakdown into parts, from the ledger (if it's been
   *  decomposed). Lets the detail view show "what it needs" without a re-prove. */
  decomposition?: GoalDecomposition | null;
  /** How this goal came to exist. Defaults to `"manual"` for legacy records. */
  source?: GoalSource;
  /** The session this ask was auto-derived from (set when source = "ask"). */
  origin?: GoalOrigin | null;
  /** User hid this auto-born goal (trivial / not really an ask). Kept, not
   *  deleted, so a re-derive from the same session never resurrects it. */
  dismissed?: boolean;
  createdAt: number;
  updatedAt: number;
};

const RUN_CAP = 24;
const keyFor = (repo: string) => `aura.goals.${repo}`;

// ── Tiny external store (subscribe + snapshot per repo) ──────────────────
// Listeners are global; each fires on any goal mutation and re-reads its own
// repo's snapshot. Snapshots are cached so useSyncExternalStore sees a stable
// reference until a real change bumps the version.

const listeners = new Set<() => void>();
const snapshotCache = new Map<string, { version: number; value: GoalRecord[] }>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function readRaw(repo: string): GoalRecord[] {
  try {
    const raw = localStorage.getItem(keyFor(repo));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GoalRecord[];
    return Array.isArray(parsed) ? parsed.filter((g) => g && typeof g.id === "string") : [];
  } catch {
    return [];
  }
}

/** Cached snapshot — same array reference until a mutation bumps `version`,
 *  so React's useSyncExternalStore doesn't loop. */
function snapshot(repo: string): GoalRecord[] {
  const cached = snapshotCache.get(repo);
  if (cached && cached.version === version) return cached.value;
  const value = readRaw(repo);
  snapshotCache.set(repo, { version, value });
  return value;
}

function write(repo: string, goals: GoalRecord[]) {
  try {
    localStorage.setItem(keyFor(repo), JSON.stringify(goals));
  } catch {
    /* quota / disabled storage — in-memory cache still updates below */
  }
  snapshotCache.set(repo, { version: version + 1, value: goals });
  emit();
}

// Cross-window/tab coherence — another window writing the same key bumps us.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith("aura.goals.")) emit();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Stable-ish id from the normalized text (so the same requirement re-uses
 *  one record), salted by length to avoid trivial collisions. */
function idForText(text: string): string {
  const n = normalize(text);
  let h = 5381;
  for (let i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) | 0;
  return `goal_${(h >>> 0).toString(36)}${n.length.toString(36)}`;
}

const now = () => Date.now();

/** Map a prove result to the goal's three-way reached verdict. */
export function verdictFromProve(result: ProveResult): {
  verdict: GoalVerdict;
  ok: number;
  total: number;
} {
  const { tone, ok, total } = verdictOf(result);
  const verdict: GoalVerdict =
    tone === "ok" ? "verified" : tone === "partial" ? "partial" : total > 0 ? "not_wired" : "unknown";
  return { verdict, ok, total };
}

/** Map a structured `aura prove --json` outcome to the goal's reached verdict.
 *  `unknown` is "can't tell yet" (no checkpoint / undecomposable), kept distinct
 *  from "not yet" so the surface never claims an unproven goal failed. */
export function verdictFromOutcome(outcome: ProveOutcome): {
  verdict: GoalVerdict;
  ok: number;
  total: number;
} {
  // Trust the engine's verdict when it gave one; only fall back to counts.
  const v = outcome.verdict;
  const ok = outcome.passed ?? 0;
  const total = outcome.total ?? 0;
  if (v === "verified" || v === "partial" || v === "not_wired" || v === "unknown") {
    return { verdict: v, ok, total };
  }
  const verdict: GoalVerdict =
    total > 0 && ok === total ? "verified" : ok > 0 ? "partial" : total > 0 ? "not_wired" : "unknown";
  return { verdict, ok, total };
}

/** The record's current "reached" state — its newest run, or unknown. */
export function rollup(goal: GoalRecord): { verdict: GoalVerdict; ok: number; total: number; at: number | null } {
  const latest = goal.runs[0];
  if (!latest) return { verdict: "unknown", ok: 0, total: 0, at: null };
  return { verdict: latest.verdict, ok: latest.ok, total: latest.total, at: latest.at };
}

/** A plain one-line reason a goal isn't reached yet — from its latest verdict
 *  and part counts. Pass the live prove `outcome` when the card holds one: it
 *  carries which parts actually exist in code, so a "built but not wired" state
 *  reads honestly instead of claiming nothing was built. Null when the goal is
 *  reached (nothing to explain) or has never been checked (the card already
 *  says "Not checked"). */
export function reachedSummary(goal: GoalRecord, outcome?: ProveOutcome | null): string | null {
  const r = rollup(goal);
  if (r.at == null || r.verdict === "verified") return null;
  if (r.verdict === "unknown")
    return "Aura couldn't check this yet. There's no saved snapshot of the code to compare against.";
  if (r.total === 0) return "Aura couldn't work out what this goal needs yet.";
  const missing = Math.max(0, r.total - r.ok);
  if (r.ok === 0) {
    // How many parts exist in the code — 0 pass, but "built and not wired up" is
    // a different (and honest) story from "nothing built at all". Only the live
    // outcome knows which; without it the answer is neither, and null keeps it
    // that way. Defaulting to 0 here told you nothing had been written whenever
    // the card was drawn from recorded history — which is its first frame.
    const built = outcome
      ? Math.min(r.total, outcome.checks.filter((c) => c.exists).length)
      : null;
    if (built == null)
      return `None of the ${r.total} parts are passing yet. Run a check to see which are built and which aren't there at all.`;
    if (built > 0)
      return built === r.total
        ? `All ${r.total} parts are built, but none are wired up yet, so it isn't finished.`
        : `${built} of ${r.total} parts are built, but none are wired up yet, so it isn't finished.`;
    return `None of the ${r.total} parts this needs are built yet, so it isn't finished.`;
  }
  return `${r.ok} of ${r.total} parts are in place; the other ${missing} ${
    missing === 1 ? "isn't" : "aren't"
  } finished yet.`;
}

/** Did the agent treat this goal as done, and does the code back that up?
 *  Grounded in real signals only — a build-triggered run (the agent committed
 *  the work, so a "done" was implied) or an ask-born goal (what you told it to
 *  build) — so it never invents a claim. `tone`: "gap" = committed as done but
 *  the code check disagrees (the catch), "agree" = committed and confirmed,
 *  "context" = you asked for it, here's where it actually stands. Null when
 *  there's no honest claim signal (e.g. a hand-typed goal never checked). */
export function doneClaim(
  goal: GoalRecord,
): { text: string; tone: "gap" | "agree" | "context" } | null {
  const r = rollup(goal);
  const committed = goal.runs.find((run) => run.trigger === "build");
  if (committed) {
    if (r.verdict === "verified")
      return {
        text: "Your agent committed this as done, and Aura's check of the code agrees.",
        tone: "agree",
      };
    if (r.verdict !== "unknown")
      return {
        text: "Your agent committed this as finished, but Aura's check of the code says it isn't there yet.",
        tone: "gap",
      };
  }
  if (goal.source === "ask" && r.at != null && r.verdict !== "verified" && r.verdict !== "unknown")
    return {
      text: "This is what you asked your agent to build. The check below is where it actually stands.",
      tone: "context",
    };
  return null;
}

// ── Reads ─────────────────────────────────────────────────────────────────

export function listGoals(repo: string): GoalRecord[] {
  return snapshot(repo);
}

export function getGoal(repo: string, id: string): GoalRecord | null {
  return snapshot(repo).find((g) => g.id === id) ?? null;
}

export function goalsForTask(repo: string, taskId: string): GoalRecord[] {
  return snapshot(repo).filter((g) => g.taskId === taskId);
}

export function goalsForRun(repo: string, runKey: string): GoalRecord[] {
  return snapshot(repo).filter((g) => g.runs.some((r) => r.runKey === runKey));
}

// ── Writes (all bump version + persist) ────────────────────────────────────

/** Find-or-create a record for `text`. Returns the (existing or new) record. */
export function upsertGoalByText(repo: string, text: string): GoalRecord {
  const goals = snapshot(repo).slice();
  const id = idForText(text);
  const existing = goals.find((g) => g.id === id || normalize(g.text) === normalize(text));
  if (existing) {
    if (existing.text !== text.trim()) {
      const next = { ...existing, text: text.trim(), updatedAt: now() };
      write(repo, goals.map((g) => (g.id === existing.id ? next : g)));
      return next;
    }
    return existing;
  }
  const rec: GoalRecord = {
    id,
    text: text.trim(),
    taskId: null,
    taskSeq: null,
    runs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  write(repo, [rec, ...goals]);
  return rec;
}

/** Attach a hand-typed goal to a live chat session. Find-or-create the record
 *  (same identity as `upsertGoalByText`) and stamp its `origin` with the
 *  session it was launched from, so the chat can show a durable "pursuing this
 *  goal" pill and jump back to the run that owns it. An existing record keeps
 *  its earliest origin (a goal re-sent from a second session doesn't lose the
 *  first); a brand-new one records this session as its origin. Source is
 *  `"manual"` — it was typed, not auto-derived from an opening ask. */
export function attachSessionGoal(
  repo: string,
  text: string,
  sessionId: string,
  agentId?: string,
): GoalRecord {
  const goals = snapshot(repo).slice();
  const id = idForText(text);
  const existing = goals.find(
    (g) => g.id === id || normalize(g.text) === normalize(text),
  );
  const origin: GoalOrigin = {
    sessionId,
    agentId,
    askText: text.trim(),
    firstSeen: now(),
  };
  if (existing) {
    const next: GoalRecord = {
      ...existing,
      text: text.trim(),
      source: existing.source ?? "manual",
      // Keep the first session this goal was born in; only adopt one if none.
      origin: existing.origin ?? origin,
      updatedAt: now(),
    };
    write(repo, goals.map((g) => (g.id === existing.id ? next : g)));
    return next;
  }
  const rec: GoalRecord = {
    id,
    text: text.trim(),
    taskId: null,
    taskSeq: null,
    runs: [],
    source: "manual",
    origin,
    createdAt: now(),
    updatedAt: now(),
  };
  write(repo, [rec, ...goals]);
  return rec;
}

/** Append (or replace, by runKey) a run verdict on a goal — newest first. */
export function recordRun(repo: string, goalId: string, run: GoalRun): void {
  const goals = snapshot(repo).slice();
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return;
  const g = goals[idx];
  const others = g.runs.filter((r) => r.runKey !== run.runKey);
  const runs = [run, ...others].slice(0, RUN_CAP);
  goals[idx] = { ...g, runs, updatedAt: now() };
  write(repo, goals);
}

export function linkTask(repo: string, goalId: string, taskId: string, taskSeq?: number | null): void {
  const goals = snapshot(repo).slice();
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return;
  goals[idx] = { ...goals[idx], taskId, taskSeq: taskSeq ?? null, updatedAt: now() };
  write(repo, goals);
}

export function unlinkTask(repo: string, goalId: string): void {
  const goals = snapshot(repo).slice();
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return;
  goals[idx] = { ...goals[idx], taskId: null, taskSeq: null, updatedAt: now() };
  write(repo, goals);
}

export function setGoalText(repo: string, goalId: string, text: string): void {
  const goals = snapshot(repo).slice();
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx < 0) return;
  goals[idx] = { ...goals[idx], text: text.trim(), updatedAt: now() };
  write(repo, goals);
}

export function deleteGoal(repo: string, goalId: string): void {
  const goals = snapshot(repo).filter((g) => g.id !== goalId);
  write(repo, goals);
}

/** Fold the durable `.aura/goals.jsonl` ledger into the reactive store. The
 *  ledger (git-tracked, team-shared, written by the CLI + the auto-prove hook)
 *  is canonical for everything it owns — text, task link, runs, decomposition.
 *  Local-only fields the ledger doesn't track (`source` / `origin` / `dismissed`,
 *  i.e. how an ask-derived goal was born and whether it was hidden) are carried
 *  over from the matching local record. Local records with no ledger match are
 *  left untouched — an ask auto-born in this session that hasn't been written
 *  out yet shouldn't vanish. Ledger order wins (newest-first), with surviving
 *  local-only goals appended. No-op when the ledger matches what we already have,
 *  so it won't loop React. */
export function hydrateFromLedger(repo: string, ledgerGoals: GoalRecord[]): void {
  const local = snapshot(repo);
  const localById = new Map(local.map((g) => [g.id, g]));
  const ledgerIds = new Set(ledgerGoals.map((g) => g.id));

  const merged: GoalRecord[] = ledgerGoals.map((lg) => {
    const prev = localById.get(lg.id);
    if (!prev) return lg;
    // Ledger canonical for its own fields; preserve local provenance/visibility.
    return {
      ...lg,
      source: prev.source ?? lg.source,
      origin: prev.origin ?? lg.origin ?? null,
      dismissed: prev.dismissed ?? lg.dismissed,
    };
  });
  // Keep local-only goals (not yet in the ledger) after the canonical set.
  for (const g of local) {
    if (!ledgerIds.has(g.id)) merged.push(g);
  }

  // Skip the write (and the version bump) when nothing actually changed, so a
  // hydrate-on-mount that finds an unchanged ledger doesn't churn the store.
  if (JSON.stringify(merged) === JSON.stringify(local)) return;
  write(repo, merged);
}

// ── React hooks ────────────────────────────────────────────────────────────

export function useGoals(repo: string): GoalRecord[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot(repo),
    () => snapshot(repo),
  );
}

export function useGoalsForTask(repo: string, taskId: string | null): GoalRecord[] {
  const all = useGoals(repo);
  return taskId ? all.filter((g) => g.taskId === taskId) : [];
}

export function useGoalsForRun(repo: string, runKey: string | null): GoalRecord[] {
  const all = useGoals(repo);
  return runKey ? all.filter((g) => g.runs.some((r) => r.runKey === runKey)) : [];
}

/** The goals a chat session launched (via `attachSessionGoal`), newest-first.
 *  Drives the composer's "pursuing goal" pill. `filter` returns a fresh array,
 *  so sorting it never mutates the shared snapshot. */
export function useSessionGoals(
  repo: string,
  sessionId: string | null,
): GoalRecord[] {
  const all = useGoals(repo);
  return sessionId
    ? all
        .filter((g) => g.origin?.sessionId === sessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];
}

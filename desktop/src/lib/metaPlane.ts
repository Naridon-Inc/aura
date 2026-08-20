// Meaning plane (M4 — sovereign substrate). Typed wrappers over the two
// read-only `aura meta …` bridges. Aura keeps a portable "why + proof" record
// alongside the code that travels with the repo on ANY git host — clone it
// anywhere and the same record is verifiable on that clone. These wrappers let
// the in-app panel read it without anyone touching a terminal.
//
// The shapes below mirror the CLI's JSON output exactly. We never synthesize a
// field — the panel renders only what the commands return; absent data is
// simply omitted (optional here), never faked.

import { invoke } from "@tauri-apps/api/core";

/** A proof goal's verdict, as the engine reports it. */
export type MetaVerdict = "verified" | "partial" | "not_wired" | "unknown";

/** One goal inside a commit's proof — a behavioral claim and whether it held. */
export type MetaProofGoal = {
  id: string;
  text: string;
  /** Engine verdict for this single goal. */
  verdict: string;
  /** Checks that passed for this goal. */
  ok: number;
  /** Checks attempted for this goal. */
  total: number;
};

/** The proof attached to a commit: did its stated goals actually hold? */
export type MetaProof = {
  /** Commit the proof is bound to. */
  commit: string;
  /** Overall verdict across all goals. */
  verdict: MetaVerdict;
  /** Goals satisfied across the commit. */
  ok: number;
  /** Goals checked across the commit. */
  total: number;
  /** Per-goal breakdown. */
  goals: MetaProofGoal[];
  /** Unix seconds the proof was computed. */
  at: number;
};

/** One intent row — a recorded "why" for a change, by a specific agent. */
export type MetaIntentRow = {
  /** Unix seconds the intent was logged. */
  ts: number;
  /** Who made the change (agent/author id). */
  agent_id: string;
  /** Plain-language reason the change was made. */
  intent: string;
  /** Optional classification (e.g. "refactor", "feature"). */
  intent_type?: string;
  /** Optional id of the key that signed the intent. */
  key_id?: string;
};

/** One commit as the meaning log reports it — its why-rows and proof. */
export type MetaLogEntry = {
  /** Full commit hash. */
  sha: string;
  /** Short commit hash. */
  short: string;
  /** Commit subject line. */
  summary: string;
  /** The recorded "why" rows for this commit (may be empty). */
  rows: MetaIntentRow[];
  /** Proof verdict for this commit, when one was recorded. */
  proof?: MetaProof;
};

/** One commit's coverage in the verify roll-up. */
export type MetaVerifyCommit = {
  sha: string;
  short: string;
  summary: string;
  /** Whether this commit carries a recorded "why". */
  has_intent: boolean;
  /** Proof for this commit, or null when none was recorded. */
  proof: MetaProof | null;
  /** Whether the proof binds correctly to this commit. */
  binding_ok: boolean;
};

/** The verify roll-up — coverage and what (if anything) needs a look.
 *
 *  `proofs` and `proven` are different numbers. A proof snapshot records a
 *  verdict, so a commit can carry a proof saying its goals were never wired
 *  up; counting that as proven is how the panel came to print "Verified on
 *  this clone" over evidence that said the opposite. The three optional
 *  fields are absent when an older `aura` on PATH wrote the report — see
 *  `gradesVerdicts` in `metaVerifyBanner.ts`. Their absence means "this
 *  engine can't tell us", never zero. */
export type MetaVerifyReport = {
  /** Commit range checked, or null for the default scope. */
  range: string | null;
  /** Commits examined — capped at 200, see `truncated`. */
  commits: number;
  /** Commits that carry a recorded "why". */
  intent_covered: number;
  /** Commits carrying a proof snapshot at all, whatever it says. */
  proofs?: number;
  /** Commits whose proof binds to them and reads "verified". */
  proven: number;
  /** Commits whose proof binds and reads "partial". */
  partial?: number;
  /** Plain-language things that need a look (empty when all is well). */
  issues: string[];
  /** True when nothing needs attention. */
  ok: boolean;
  /** True when the walk stopped at the cap with history still to go, so
   *  `commits` is the most recent slice and not the whole clone. */
  truncated?: boolean;
  /** Per-commit coverage detail. */
  per_commit: MetaVerifyCommit[];
};

/** Read the per-commit meaning log for a repo (`aura meta log --json`). */
export function metaPlaneLog(repoRoot: string): Promise<MetaLogEntry[]> {
  return invoke<MetaLogEntry[]>("meta_plane_log", { repoRoot });
}

/** Verify the meaning plane for a repo (`aura meta verify --json`). When
 *  `range` is given (e.g. `origin/main..HEAD`), the check is scoped to it. */
export function metaPlaneVerify(
  repoRoot: string,
  range?: string,
): Promise<MetaVerifyReport> {
  return invoke<MetaVerifyReport>("meta_plane_verify", { repoRoot, range });
}

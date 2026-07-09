// goalLedger — the durable `.aura/goals.jsonl` ledger, read into the frontend.
//
// The ledger is the source of truth for goals: git-tracked, team-shared, and
// written by the CLI (`aura goals prove/link`) plus the post-commit auto-prove
// hook. It carries far more than the old localStorage cache ever did — the
// commit each goal was last checked at, the files that deliver it, and the
// cached decomposition into checkable parts.
//
// This module is the thin async seam between that ledger and the synchronous,
// reactive `goalStore`: it shells the same bundled `aura` the rest of the app
// uses (via `api.auraCli`, which runs in the repo cwd), parses the snake_case
// JSON the CLI emits, and maps it onto the store's camelCase records. The store
// stays the single reactive surface every component already reads; `goalStore`
// .hydrateFromLedger folds these records in. Mutations (prove / link) go to the
// CLI so they land in the durable ledger — never localStorage alone.

import { api } from "./api";
import type { ProveOutcome } from "./prove";
import type {
  GoalDecomposition,
  GoalRecord,
  GoalRun,
  GoalVerdict,
} from "./goalStore";

// ── The ledger's on-disk (CLI --json) shapes ────────────────────────────────
// snake_case, mirroring the Rust `goals::model` types byte-for-byte.

type LedgerRequirement = {
  node_name: string;
  node_type: string;
  must_call?: string | null;
};

type LedgerDecomposition = {
  requirements?: LedgerRequirement[];
  decomposed_at?: number;
  model?: string | null;
};

type LedgerRun = {
  run_key: string;
  label?: string | null;
  agent_id?: string | null;
  verdict: string;
  ok: number;
  total: number;
  commit?: string | null;
  trigger?: string | null;
  files?: string[];
  at: number;
};

type LedgerGoal = {
  id: string;
  text: string;
  task_id?: string | null;
  task_seq?: number | null;
  /** Plain-language verify plan — the human-readable checks, distinct from
   *  the machine `decomposition`. Empty/absent when none were written. */
  acceptance?: string[];
  decomposition?: LedgerDecomposition | null;
  runs?: LedgerRun[];
  created_at: number;
  updated_at: number;
};

// ── Mapping: ledger (snake_case) → store record (camelCase) ──────────────────

const VERDICTS: ReadonlySet<string> = new Set(["verified", "partial", "not_wired", "unknown"]);

function toVerdict(v: string): GoalVerdict {
  return (VERDICTS.has(v) ? v : "unknown") as GoalVerdict;
}

function mapRun(r: LedgerRun): GoalRun {
  return {
    runKey: r.run_key,
    label: r.label ?? undefined,
    agentId: r.agent_id ?? undefined,
    verdict: toVerdict(r.verdict),
    ok: r.ok ?? 0,
    total: r.total ?? 0,
    at: r.at ?? 0,
    commit: r.commit ?? null,
    trigger: r.trigger ?? null,
    files: Array.isArray(r.files) ? r.files : [],
  };
}

function mapDecomposition(d: LedgerDecomposition | null | undefined): GoalDecomposition | null {
  if (!d || !Array.isArray(d.requirements) || d.requirements.length === 0) return null;
  return {
    requirements: d.requirements.map((r) => ({
      nodeName: r.node_name,
      nodeType: r.node_type,
      mustCall: r.must_call ?? null,
    })),
    decomposedAt: d.decomposed_at,
  };
}

/** Map one ledger goal onto the store's `GoalRecord` shape. */
export function ledgerToRecord(g: LedgerGoal): GoalRecord {
  return {
    id: g.id,
    text: g.text,
    taskId: g.task_id ?? null,
    taskSeq: g.task_seq ?? null,
    acceptance: Array.isArray(g.acceptance)
      ? g.acceptance.filter((c) => typeof c === "string" && c.trim().length > 0)
      : [],
    runs: Array.isArray(g.runs) ? g.runs.map(mapRun) : [],
    decomposition: mapDecomposition(g.decomposition),
    createdAt: g.created_at ?? 0,
    updatedAt: g.updated_at ?? 0,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Read the whole ledger via `aura goals list --json` and map it to records.
 *  Never throws — a missing/old binary or empty repo just yields `[]`, so a
 *  hydrate-on-mount can't blank or crash the surface. */
export async function ledgerList(repoRoot: string): Promise<GoalRecord[]> {
  if (!repoRoot) return [];
  try {
    const res = await api.auraCli(repoRoot, ["goals", "list", "--json"]);
    const text = (res.stdout ?? "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text) as LedgerGoal[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g) => g && typeof g.id === "string").map(ledgerToRecord);
  } catch {
    return [];
  }
}

// ── Mutations (write the durable ledger, then re-read) ───────────────────────

/** Prove a goal through the ledger: `aura goals prove "<text>" [--task AURA-n]
 *  --json`. This decomposes the goal once (cached in the ledger), proves it
 *  against the current code, and records a durable run — stamped with the
 *  commit + the files that deliver it. Returns the structured outcome (the
 *  same `ProveOutcome` shape the Goals detail already renders), or `null` if
 *  the CLI produced nothing parseable. */
export async function ledgerProve(
  repoRoot: string,
  text: string,
  taskRef?: string | null,
): Promise<ProveOutcome | null> {
  if (!repoRoot || !text.trim()) return null;
  const args = ["goals", "prove", text];
  if (taskRef) args.push("--task", taskRef);
  args.push("--json");
  try {
    const res = await api.auraCli(repoRoot, args);
    const out = (res.stdout ?? "").trim();
    if (!out) return null;
    const parsed = JSON.parse(out) as ProveOutcome;
    if (parsed && typeof parsed.verdict === "string" && Array.isArray(parsed.checks)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Tie a goal (by id or text) to a board task in the ledger. */
export async function ledgerLink(repoRoot: string, idOrText: string, taskRef: string): Promise<void> {
  if (!repoRoot || !idOrText || !taskRef) return;
  try {
    await api.auraCli(repoRoot, ["goals", "link", idOrText, taskRef]);
  } catch {
    /* best-effort — the verdict still records even if the link couldn't land */
  }
}

// crewProof — joins a finished Crew node to the goal it delivered, with the
// proof verdict. No new backend: the goals ledger (`.aura/goals.jsonl`) is
// already readable via `ledgerList` (`aura goals list --json`), and each goal
// run carries the SHORT commit it was proven against. We fold the whole ledger
// into a commit → proofs map once, then look up each done node's `commit_sha`.
//
// This is the moat hew/beads can't show: a done task isn't just "an agent ran
// and committed" — it's tied to a goal and whether the code actually satisfies
// it (AST-checked, free, on every commit by the post-commit hook).

import { ledgerList } from "../../../lib/goalLedger";
import type { GoalVerdict } from "../../../lib/goalStore";

export type CrewProof = {
  verdict: GoalVerdict;
  /** Requirements met / total — the "2 of 3 checks" rollup. */
  ok: number;
  total: number;
  goalText: string;
  /** Concrete code files the goal was proven against. */
  files: string[];
  /** When this run landed (for newest-wins ordering). */
  at: number;
};

/** Two commit hashes refer to the same commit if their short prefixes match.
 *  Ledger runs store a 12-char short sha; a loop node carries the full 40 (or
 *  occasionally a 7-char abbrev) — so compare on the shorter common prefix. */
function commitsMatch(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length, 12);
  return n > 0 && a.slice(0, n) === b.slice(0, n);
}

/** Read the whole ledger and fold it into `shortCommit → proofs[]` (newest
 *  first). A commit can deliver more than one goal, so each key holds a list.
 *  Never throws — a missing binary / empty repo yields an empty map. */
export async function loadCrewProof(
  repoRoot: string,
): Promise<Map<string, CrewProof[]>> {
  const map = new Map<string, CrewProof[]>();
  const goals = await ledgerList(repoRoot);
  for (const g of goals) {
    for (const run of g.runs) {
      const c = (run.commit ?? "").trim();
      if (!c) continue;
      const proof: CrewProof = {
        verdict: run.verdict,
        ok: run.ok,
        total: run.total,
        goalText: g.text,
        files: run.files ?? [],
        at: run.at ?? 0,
      };
      const arr = map.get(c);
      if (arr) arr.push(proof);
      else map.set(c, [proof]);
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => b.at - a.at);
  return map;
}

/** All proofs delivered by a node's commit (newest first), or `[]`. */
export function proofForCommit(
  map: Map<string, CrewProof[]>,
  fullSha: string | null | undefined,
): CrewProof[] {
  if (!fullSha) return [];
  for (const [c, arr] of map) {
    if (commitsMatch(c, fullSha)) return arr;
  }
  return [];
}

/** The single proof to headline on a node's pill — the newest run. */
export function bestProof(proofs: CrewProof[]): CrewProof | null {
  return proofs.length ? proofs[0] : null;
}

/** Plain-language label for a verdict — never the raw enum. */
export function proofLabel(p: CrewProof): string {
  switch (p.verdict) {
    case "verified":
      return p.total > 0 ? `Proven · ${p.ok}/${p.total} checks` : "Proven";
    case "partial":
      return `Almost · ${p.ok}/${p.total} checks`;
    case "not_wired":
      return "Not built yet";
    default:
      return "Not checked";
  }
}

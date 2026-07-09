// prove — the shared "does the codebase actually wire this behaviour?" engine.
//
// Wraps `aura prove --goal <text>`. Two shapes:
//   • runProveStructured — `--json` mode (ProveOutcome): per-check plain-English
//     reasons + a verified|partial|not_wired|unknown verdict. The Goals surface
//     uses this so it can say "what's missing" in the user's words, not AST
//     jargon. Preferred.
//   • runProve — the legacy human-text parse (ProveResult), kept for callers
//     not yet migrated (the per-task / per-run goal cards).

import { api } from "./api";

export type Check = {
  ok: boolean;
  /** Raw line for fallback display when parsing can't structure it. */
  line: string;
  /** Best-effort parsed kind ("Class" / "Function" / …). */
  kind: string | null;
  /** Best-effort parsed identifier (between single quotes). */
  identifier: string | null;
};

export type ProveResult = {
  checks: Check[];
  proven: boolean;
  /** Final summary line (e.g. "0 of 4 semantic links verified"). */
  summary: string;
  /** Raw stdout/stderr for the dropdown — debugging when the parser misses. */
  raw: string;
};

export type ProveTone = "ok" | "partial" | "fail";

/** Run a requirement check against the repo and return the structured verdict. */
export async function runProve(repoRoot: string, goal: string): Promise<ProveResult> {
  const res = await api.auraCli(repoRoot, ["prove", "--goal", goal]);
  return parseProveOutput(`${res.stdout}\n${res.stderr}`);
}

// ── Structured (--json) path ────────────────────────────────────────────────

export type ProveVerdict = "verified" | "partial" | "not_wired" | "unknown";

/** One requirement Aura looked for, with a plain-English reason. Mirrors the
 *  Rust `prove_goal_structured` check shape. */
export type ProveCheck = {
  node_name: string;
  node_type: string;
  must_call: string | null;
  exists: boolean;
  is_stub: boolean;
  wired: boolean | null;
  passed: boolean;
  /** Plain-language explanation, e.g. "'HandleGoogleCallback' isn't in the code yet". */
  reason: string;
};

/** The structured proof from `aura prove --json`. `error` (with verdict
 *  "unknown") means "can't tell yet" — no checkpoint / undecomposable — NOT
 *  "not reached". */
export type ProveOutcome = {
  goal: string;
  checks: ProveCheck[];
  passed: number;
  total: number;
  verdict: ProveVerdict;
  error: string | null;
};

/** Run the proof and get the structured outcome (plain reasons + verdict).
 *  Falls back to parsing the human text if `--json` ever yields nothing
 *  parseable, so a stale binary can't blank the surface. */
export async function runProveStructured(repoRoot: string, goal: string): Promise<ProveOutcome> {
  const res = await api.auraCli(repoRoot, ["prove", "--goal", goal, "--json"]);
  const text = res.stdout?.trim() ?? "";
  try {
    const parsed = JSON.parse(text) as ProveOutcome;
    if (parsed && Array.isArray(parsed.checks) && typeof parsed.verdict === "string") {
      return parsed;
    }
  } catch {
    /* fall through to legacy parse */
  }
  // Legacy fallback: derive an outcome from the human report.
  const legacy = parseProveOutput(`${res.stdout}\n${res.stderr}`);
  const { tone, ok, total } = verdictOf(legacy);
  const verdict: ProveVerdict =
    tone === "ok" ? "verified" : tone === "partial" ? "partial" : total > 0 ? "not_wired" : "unknown";
  return {
    goal,
    checks: legacy.checks.map((c) => ({
      node_name: c.identifier ?? c.line,
      node_type: c.kind ?? "Logic",
      must_call: null,
      exists: c.ok,
      is_stub: false,
      wired: null,
      passed: c.ok,
      reason: c.ok ? `${c.line} is built` : `${c.line} isn't in the code yet`,
    })),
    passed: ok,
    total,
    verdict,
    error: total === 0 ? "Couldn't work out what this goal needs yet." : null,
  };
}

/** Reduce a result to a three-way tone + the wired/total counts. */
export function verdictOf(result: ProveResult): {
  tone: ProveTone;
  ok: number;
  total: number;
} {
  const ok = result.checks.filter((c) => c.ok).length;
  const total = result.checks.length;
  const tone: ProveTone =
    result.proven || (total > 0 && ok === total) ? "ok" : ok === 0 ? "fail" : "partial";
  return { tone, ok, total };
}

export function parseProveOutput(text: string): ProveResult {
  const checks: Check[] = [];
  let summary = "";
  let proven = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^\s+|\s+$/g, "");
    if (!line) continue;
    if (line.startsWith("✓") || line.startsWith("✗")) {
      const ok = line.startsWith("✓");
      const body = line.slice(1).trim();
      const m = /^(\w+)\s+'([^']+)'/.exec(body);
      checks.push({
        ok,
        line: body,
        kind: m?.[1] ?? null,
        identifier: m?.[2] ?? null,
      });
      continue;
    }
    if (/^✅|^Goal .* PROVEN|is PROVEN/.test(line)) {
      proven = true;
      summary = line.replace(/^[✅❌]\s*/, "");
      continue;
    }
    if (/^❌|NOT PROVEN/.test(line)) {
      proven = false;
      summary = line.replace(/^[✅❌]\s*/, "");
      continue;
    }
    if (/semantic links verified/.test(line)) {
      summary = line.replace(/^[✅❌]\s*/, "");
    }
  }
  return { checks, proven, summary, raw: text.trim() };
}

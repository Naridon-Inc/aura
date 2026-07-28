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

/** Run a requirement check against the repo and return the structured verdict.
 *  Pass `atCommit` to prove against the code as it was at that commit (or the
 *  nearest checkpoint around it) instead of the checked-out branch — so a
 *  session's goals prove against the code that session produced. */
export async function runProve(
  repoRoot: string,
  goal: string,
  atCommit?: string,
): Promise<ProveResult> {
  const argv = ["prove", "--goal", goal];
  if (atCommit) argv.push("--at", atCommit);
  const res = await api.auraCli(repoRoot, argv);
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
export async function runProveStructured(
  repoRoot: string,
  goal: string,
  atCommit?: string,
): Promise<ProveOutcome> {
  const argv = ["prove", "--goal", goal, "--json"];
  if (atCommit) argv.push("--at", atCommit);
  const res = await api.auraCli(repoRoot, argv);
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

// ── Plain-language check lines ──────────────────────────────────────────────
//
// A check's engine `reason` embeds the raw symbol ("'resolveEmailConsent' isn't
// in the code yet") — jargon that means nothing to the non-engineer the Goals
// surface is for. The check also carries the structured fields (node_name,
// must_call, and the exists/stub/wired flags), which is enough to write the
// same finding as a plain sentence with no code identifier in it. The AST names
// still live in "Show how you know" for anyone who wants them.

/** Turn a code identifier into plain words: `resolveEmailConsent` → "resolve
 *  email consent", `HandleGoogleCallback` → "handle google callback",
 *  `save_theme_pref` → "save theme pref". */
export function humanizeIdentifier(name: string): string {
  return name
    .replace(/[_\-.]+/g, " ") // snake / kebab / dotted → spaces
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → words
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // ACRONYMWord → ACRONYM Word
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The capability a check is about, as a plain phrase — the humanized node
 *  name, capitalized ("Resolve email consent"). Falls back to the engine reason
 *  for a non-identifier node so nothing is ever mangled. */
export function capabilityPhrase(c: ProveCheck): string {
  if (!c.node_name || /\s/.test(c.node_name)) return c.reason;
  const thing = capitalize(humanizeIdentifier(c.node_name));
  return thing || c.reason;
}

/** One plain-language line for a proof check — the finding with the capability
 *  named in words, not the function name. Falls back to the engine `reason`
 *  when the node isn't a bare identifier (e.g. a legacy-parsed line that already
 *  reads as a sentence), so nothing is ever mangled. */
export function plainCheckLine(c: ProveCheck): string {
  // Only humanize a true identifier (no spaces). Anything already sentence-like
  // keeps its engine reason.
  if (!c.node_name || /\s/.test(c.node_name)) return c.reason;
  const thing = capabilityPhrase(c);
  const calls = c.must_call ? humanizeIdentifier(c.must_call) : null;
  if (!c.exists) return `${thing} — not built yet.`;
  if (c.is_stub) return `${thing} — started, but still an empty placeholder.`;
  if (calls && c.wired === false) return `${thing} — built, but not connected to ${calls} yet.`;
  if (c.passed) return calls ? `${thing} — built and connected to ${calls}.` : `${thing} — built.`;
  return `${thing} — not fully wired yet.`;
}

/** Why a not-yet-passing check matters, in plain words — explained from its
 *  structural role (missing / placeholder / built-but-unwired), never invented
 *  specifics. Only meaningful for a check that hasn't passed. */
export function whyItMatters(c: ProveCheck): string {
  if (!c.exists)
    return "One of the steps this goal needs. Until it exists, the goal can't work from start to finish.";
  if (c.is_stub)
    return "It's a placeholder — it looks finished, but there's no real logic inside, so it quietly does nothing.";
  if (c.must_call && c.wired === false)
    return "It's built, but nothing calls it — so this step never actually runs.";
  return "This part isn't finished, so the goal can't fully work yet.";
}

/** A two-word status tag for a not-yet-passing check — for a compact row. */
export function statusTag(c: ProveCheck): string {
  if (!c.exists) return "not built";
  if (c.is_stub) return "placeholder";
  if (c.must_call && c.wired === false) return "not wired";
  return "unfinished";
}

/** A ready-to-hand instruction that gets an agent to finish this one part the
 *  Aura way — build/wire it, then prove it — so "done" means the check passes,
 *  not the agent's word. */
export function finishInstruction(c: ProveCheck, goalText: string): string {
  const thing = capabilityPhrase(c).toLowerCase();
  const prove = `aura prove --goal "${goalText}"`;
  if (!c.exists)
    return `Build the “${thing}” step and wire it into the flow so it runs, then run ${prove} and don't stop until that part shows as built.`;
  if (c.is_stub)
    return `Replace the “${thing}” placeholder with real working logic, then run ${prove} to confirm it's no longer an empty stub.`;
  if (c.must_call && c.wired === false) {
    const target = humanizeIdentifier(c.must_call);
    return `Connect “${thing}” to “${target}” so the step actually fires, then run ${prove} to confirm the link.`;
  }
  return `Finish the “${thing}” step and wire it in, then run ${prove} to confirm it passes.`;
}

/** One prompt covering every not-yet-done part of a goal, ready to paste to an
 *  agent — each part named in plain words, closing with the Aura finish-and-prove
 *  loop so the agent can't declare it done until the check is green. Empty string
 *  when nothing is missing. */
export function finishAllInstruction(outcome: ProveOutcome): string {
  const missing = outcome.checks.filter((c) => !c.passed);
  if (missing.length === 0) return "";
  const status = (c: ProveCheck) =>
    !c.exists ? "not built yet" : c.is_stub ? "only a placeholder" : "built but not wired in";
  const lines = missing.map((c) => `- ${capabilityPhrase(c)} — ${status(c)}`);
  const n = missing.length;
  return [
    `The goal "${outcome.goal}" isn't finished yet — ${n} part${n === 1 ? "" : "s"} still need work:`,
    ...lines,
    "",
    `Build and wire each one in, logging your intent as you go, then run \`aura prove --goal "${outcome.goal}"\` and keep going until every part passes. Don't report it done until that check is green.`,
  ].join("\n");
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

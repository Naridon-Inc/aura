

export type WaveStatus =
  | "dispatched"
  | "shipped"
  | "running"
  | "waiting"
  | "blocked"
  | "firing"
  | "info";

export type WaveEvent = {
  wave: number;
  status: WaveStatus;
  detail: string;
  /** Agent attribution parsed from `Wave N (<agent>)`. */
  agent?: string;
  /** Optional commit short-hash extracted from `(commit 775ee7b)`. */
  commit?: string;
  /** Optional next wave reference parsed from "Firing Wave N (...)". */
  next?: { wave: number; note?: string };
};

// Only treat parens-after-Wave-N as an agent attribution when it looks
// like one — short, alphabetic, possibly hyphenated (e.g. "gemini",
// "claude", "cursor-agent"). Pure hex commit hashes and free-form
// descriptors get rejected so they don't leak into the agent column.
function looksLikeAgentToken(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 20) return false;
  if (/^[a-f0-9]+$/i.test(t)) return false; // commit hash
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(t);
}

export function parseWaveEvent(text: string): WaveEvent | null {
  // Match "Wave N" or "Wave N (gemini)" prefix. Trailing remainder is
  // free-form prose we further mine for status verbs + commits.
  const m = text.match(/^Wave\s+(\d+)\b\s*(?:\(([^)]*)\)\s*)?(.*)$/is);
  if (!m) return null;
  const wave = Number(m[1]);
  const agentCandidate = m[2]?.trim();
  const agent =
    agentCandidate && looksLikeAgentToken(agentCandidate)
      ? agentCandidate
      : undefined;
  // If the parens weren't an agent attribution, keep them in the prose
  // (e.g. "Wave 4 (FTS) shipped..." should still read normally).
  const rest = (
    agent ? m[3] : agentCandidate ? `(${agentCandidate}) ${m[3]}` : m[3]
  ).trim();
  const lower = rest.toLowerCase();
  let status: WaveStatus = "info";
  if (/\bship(ped|ping)\b/.test(lower)) status = "shipped";
  else if (/\bdispatch(ed|ing)\b/.test(lower)) status = "dispatched";
  else if (/\brunning\b/.test(lower)) status = "running";
  else if (/\bwait(ing)?\b/.test(lower)) status = "waiting";
  else if (/\bblock(ed)?\b/.test(lower)) status = "blocked";
  else if (/\bfir(ed|ing)\b/.test(lower)) status = "firing";
  // Commit hash forms accepted: "commit abc1234", `abc1234`, or a bare
  // 7-12 hex in parens right after a status verb (e.g. "shipped
  // (c0ceddf)"). The bare form lets us pick up commits the brain emits
  // without the "commit" keyword.
  const commit =
    rest.match(/\bcommit\s+`?([a-f0-9]{7,40})`?/i)?.[1] ??
    rest.match(/\b(?:shipped|landed)\s*\(`?([a-f0-9]{7,12})`?\)/i)?.[1] ??
    rest.match(/`([a-f0-9]{7,40})`/)?.[1];
  const nextMatch = rest.match(/Firing\s+Wave\s+(\d+)(?:\s*\(([^)]+)\))?/i);
  const next = nextMatch
    ? { wave: Number(nextMatch[1]), note: nextMatch[2]?.trim() }
    : undefined;
  return { wave, status, detail: rest, agent, commit, next };
}

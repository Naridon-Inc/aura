// askEngine — the "Ask Aura" retrieval brain, frontend-side.
//
// The `aura ask` CLI only searches the `aura/checkpoints` branch, which is
// empty on most real projects — so it wrongly reports "just initialized, no
// history" even when the project has a deep record. The real recorded
// reasoning lives in `.aura/intent_log.jsonl`: one signed entry per commit
// carrying the agent's own plain-language account of what it changed and why.
// That file is small (well under the 2MB read cap) so we load and search it
// directly — no daemon, no cloud, no checkpoints branch.
//
// The shape we return is deliberately "answer first, sources below": the
// single most relevant recorded decision, phrased plainly, is the answer; the
// ranked list underneath is the set of past decisions it was drawn from — the
// conversations that made the code what it is.

import { api } from "./api";
import { relativeAgeFromSecs } from "./relativeTime";
import { agentName } from "./agentNames";
import { sentenceCase } from "./textCase";

export type AskSource = {
  /** Who recorded it (already humanized, e.g. "Claude"). */
  agent: string;
  /** The agent's recorded reasoning for one commit (raw, may be multi-line). */
  text: string;
  /** Plain one-line lead derived from `text` — ticket/commit prefixes stripped. */
  title: string;
  /** Unix seconds (0 when unknown). */
  ts: number;
  taskId?: string;
  /** Relevance score; higher is better. */
  score: number;
};

export type AskResult =
  | { kind: "answer"; answer: string; sources: AskSource[] }
  // Corpus has entries but nothing matched the question.
  | { kind: "no-match"; total: number }
  // Project has no recorded history at all.
  | { kind: "empty" };

type RawIntent = {
  agent_id?: string;
  intent?: string;
  timestamp?: string | number;
  task_id?: string;
};

type Corpus = { sources: AskSource[] };

// Parsing the log on every keystroke would be wasteful; a project's recorded
// history only grows, so a per-repo cache for the dialog's lifetime is safe.
const corpusCache = new Map<string, Corpus>();

/** Turn a raw agent_id into a friendly name, for a sentence.
 *
 *  An id nobody can name — a DID, a long key, or one of the "MCP Agent"
 *  placeholders — reads "An agent" rather than leaking the id. One name table
 *  for the whole app: see lib/agentNames. */
function agentLabel(id: string | undefined): string {
  return agentName(id, { empty: "An agent", unknown: "An agent" });
}

// Leading noise we strip so the lead reads like a sentence, not a commit line.
const CONVENTIONAL_RE =
  /^\s*(?:\[[^\]]*\]\s*)?(?:feat|fix|bugfix|refactor|chore|perf|performance|docs|revert|style|test|build|ci|wip)(?:\([^)]*\))?\s*[:\-–—]\s*/i;
const TICKET_RE = /^\s*(?:[A-Za-z][A-Za-z ]{0,20}?)?(?:PR|AURA|issue)\s*#?\d+\s*[—\-–:]\s*/i;
const STAGE_RE = /^\s*Stage\s+\S+\s*[:\-–—]\s*/i;

/** First readable sentence of an intent, with commit/ticket chrome removed. */
function leadLine(intent: string): string {
  let s = intent.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(CONVENTIONAL_RE, "").replace(TICKET_RE, "").replace(STAGE_RE, "");
    if (s === before) break;
  }
  const dot = s.search(/[.!?](\s|$)/);
  let lead = dot > 24 ? s.slice(0, dot + 1) : s;
  if (lead.length > 170) lead = lead.slice(0, 167).trimEnd() + "…";
  if (!lead) return intent.slice(0, 120);
  return sentenceCase(lead);
}

/** Read + parse `.aura/intent_log.jsonl` for a repo (cached per repoRoot). */
export async function loadCorpus(repoRoot: string, force = false): Promise<Corpus> {
  if (!force) {
    const hit = corpusCache.get(repoRoot);
    if (hit) return hit;
  }
  const path = `${repoRoot.replace(/\/$/, "")}/.aura/intent_log.jsonl`;
  let text = "";
  try {
    const f = await api.readFile(path);
    if (f.status === "ok") text = f.text;
  } catch {
    // Missing / unreadable → empty corpus (handled as "empty" upstream).
  }
  const sources: AskSource[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r: RawIntent;
    try {
      r = JSON.parse(t) as RawIntent;
    } catch {
      continue;
    }
    const intent = (r.intent ?? "").trim();
    if (!intent) continue;
    const tsNum =
      typeof r.timestamp === "string" ? parseInt(r.timestamp, 10) : Number(r.timestamp ?? 0);
    sources.push({
      agent: agentLabel(r.agent_id),
      text: intent,
      title: leadLine(intent),
      ts: Number.isFinite(tsNum) ? tsNum : 0,
      taskId: r.task_id,
      score: 0,
    });
  }
  const corpus = { sources };
  corpusCache.set(repoRoot, corpus);
  return corpus;
}

const STOP = new Set(
  ("the a an of to in on for and or is are was were how does do did done why what where who when which " +
    "this that it its with as at by from into our your their my me we us i you they them be been being have " +
    "has had will can could would should may might must not no about work works working use used using get gets")
    .split(" "),
);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

/** Rank recorded decisions against a free-text question by keyword overlap. */
export function rank(sources: AskSource[], question: string, limit = 6): AskSource[] {
  const qTokens = Array.from(new Set(tokenize(question)));
  if (qTokens.length === 0) return [];
  const qPhrase = question.toLowerCase().trim();
  const scored = sources.map((s) => {
    const hay = (s.text + " " + s.agent).toLowerCase();
    let score = 0;
    for (const tok of qTokens) {
      let idx = hay.indexOf(tok);
      let hits = 0;
      while (idx !== -1 && hits < 4) {
        hits++;
        idx = hay.indexOf(tok, idx + tok.length);
      }
      if (hits > 0) score += 1 + Math.min(hits - 1, 3) * 0.25;
    }
    if (qPhrase.length > 6 && hay.includes(qPhrase)) score += 2;
    return { ...s, score };
  });
  const matched = scored.filter((s) => s.score > 0);
  matched.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return matched.slice(0, limit);
}

// How code-ish a line reads — camelCase, foo(), file.ext, dotted.paths,
// ALLCAPS_CONSTS. Used to pick the most human line as the headline answer.
function jargonScore(s: string): number {
  let n = 0;
  n += (s.match(/[a-z][A-Z]/g) ?? []).length; // camelCase humps
  n += (s.match(/\w\(\)/g) ?? []).length; // fn() calls
  n += (s.match(/\.(ts|tsx|js|jsx|rs|py|go|rb|json)\b/g) ?? []).length; // file exts
  n += (s.match(/[a-z]\.[a-z]/gi) ?? []).length; // dotted.paths
  n += (s.match(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g) ?? []).length; // SCREAMING_CONSTS
  return n;
}

// Light plain-language pass for the headline: drop empty call parens, strip
// parenthetical file references, and split camelCase humps so an identifier
// that must remain reads as words. Deliberately conservative — the answer is
// already chosen to be the least code-ish candidate.
function plainify(s: string): string {
  return s
    .replace(/\s*\([^)]*\.(?:ts|tsx|js|jsx|rs|py|go|rb|json)[^)]*\)/gi, "")
    .replace(/\(\)/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The most relevant recorded decision, phrased plainly. We do not fabricate a
 *  synthesis — we surface what a strong matching record actually says. Among
 *  the top candidates (those close to the best relevance) we pick the most
 *  human-readable line as the headline, so the answer leads with meaning
 *  rather than a wall of identifiers; the full ranked list stays as sources. */
export function compose(ranked: AskSource[]): AskResult {
  if (ranked.length === 0) return { kind: "no-match", total: 0 };
  const top = ranked[0].score;
  const candidates = ranked.filter((s) => s.score >= top * 0.55).slice(0, 6);
  let best = candidates[0];
  let bestJargon = jargonScore(best.title);
  for (const c of candidates.slice(1)) {
    const j = jargonScore(c.title);
    if (j < bestJargon) {
      best = c;
      bestJargon = j;
    }
  }
  return { kind: "answer", answer: plainify(best.title), sources: ranked };
}

/** End-to-end: load → rank → compose. */
export async function ask(repoRoot: string, question: string): Promise<AskResult> {
  const corpus = await loadCorpus(repoRoot);
  if (corpus.sources.length === 0) return { kind: "empty" };
  const ranked = rank(corpus.sources, question);
  if (ranked.length === 0) return { kind: "no-match", total: corpus.sources.length };
  return compose(ranked);
}

/** Human "3d ago"-style label for a unix-seconds timestamp.
 *
 *  This spelled its units out — "5 min ago", "2 hrs ago", "3 days ago" — which
 *  is a perfectly good way to write an age, and was the only place in the app
 *  writing it that way. An Ask result sits in the same window as every other
 *  surface, so it reads "5m ago" like the rest of them now. */
export function relativeTime(tsSeconds: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(tsSeconds);
}

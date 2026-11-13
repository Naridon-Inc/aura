// The change story's data, with no window: the report `aura intent-vs-actual
// show <sha> --json` returns, how a run's several commits fold into one, which
// stated line is the ask and which are what the AI said, the per-symbol pieces,
// and the verdict the story draws. Pure, so the rules the story follows are
// tested without rendering it. The hooks that load a report live beside this
// in `useIntentReport`; IntentStory re-exports both, so callers import one name.

import type { ClaudeSession } from "../../../lib/api";
import { isAutoStubText, isNonClaudeAgent, nearestSessionByTime } from "../../../lib/sessionMeta";
import {
  basisCanBeChecked,
  intentBasis,
  mixedBasisNote,
  uncheckableLabel,
  uncheckableNote,
  type IntentBasis,
} from "../../../lib/intentBasis";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";

export type StatedIntent = {
  timestamp: number;
  agent_id: string;
  intent: string;
  intent_type?: string | null;
  /** Where the text came from when nobody called `log-intent`:
   *  `session_prompt`, `brain_inferred` or `guard_auto_stub`. Absent means
   *  somebody stated it. This report is a comparison between this text and
   *  the AST — see lib/intentBasis for why that only counts sometimes. */
  source?: string | null;
};

// Structured per-symbol change. Emitted by `intent-vs-actual show` once
// the CLI carries it; until then deriveNodes() synthesizes the same shape
// (minus file/line/signature/rationale) from the string arrays.
export type NodeRef = {
  identifier: string;
  kind: string;
  change: "added" | "modified" | "deleted";
  file?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  signature?: string | null;
  is_stub?: boolean;
  contains_secret?: boolean;
  covered?: boolean;
  rationale?: string | null;
};

export type IntentReport = {
  commit_sha: string;
  commit_short: string;
  commit_message: string;
  commit_time: number;
  author: string;
  stated: StatedIntent[];
  modified_nodes: string[];
  added_nodes: string[];
  deleted_nodes: string[];
  aligned_nodes: string[];
  mismatched_nodes: string[];
  alignment_score: number;
  banner: "aligned" | "drift" | "diverged";
  changed_files: string[];
  // Forward-compatible: present once the CLI emits structured nodes.
  nodes?: NodeRef[];
};

/** How a verdict reads at a glance: settled, worth a look, or not lined up. */
export type VerdictTone = "good" | "warn" | "bad";

// ── A run's commits, read as one ─────────────────────────────────────

/** Merge several per-commit reports into one run-level report. A single run
 *  usually lands as several commits; judging only the first (what the raw
 *  single-commit hook does) leaves "what changed" empty whenever that first
 *  commit happens to be a deps bump / merge / non-code touch while the real
 *  symbol work lives in later commits — even though the Changes tab counts
 *  files across all of them. Unioning the node + file + intent lists gives the
 *  whole run's picture; coverage is recomputed so the verdict stays honest.
 *  The newest commit supplies the representative metadata. */
export function mergeIntentReports(reports: IntentReport[]): IntentReport | null {
  const live = reports.filter(Boolean);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  const head = [...live].sort((a, b) => b.commit_time - a.commit_time)[0];
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

  const modified = uniq(live.flatMap((r) => r.modified_nodes));
  const added = uniq(live.flatMap((r) => r.added_nodes));
  const deleted = uniq(live.flatMap((r) => r.deleted_nodes));
  const aligned = uniq(live.flatMap((r) => r.aligned_nodes));
  const mismatched = uniq(live.flatMap((r) => r.mismatched_nodes));
  const changed_files = uniq(live.flatMap((r) => r.changed_files));

  // Dedupe stated intents by (time, agent, text) — the same note can recur
  // when a file is touched across more than one of the run's commits.
  const statedSeen = new Set<string>();
  const stated: StatedIntent[] = [];
  for (const r of live) {
    for (const s of r.stated) {
      const k = `${s.timestamp}|${s.agent_id}|${s.intent}`;
      if (statedSeen.has(k)) continue;
      statedSeen.add(k);
      stated.push(s);
    }
  }
  stated.sort((a, b) => a.timestamp - b.timestamp);

  // Structured nodes (rich cards w/ file+line+rationale), deduped by identity.
  const nodeSeen = new Set<string>();
  const nodes: NodeRef[] = [];
  for (const r of live) {
    for (const n of r.nodes ?? []) {
      const k = `${n.identifier}|${n.change}|${n.file ?? ""}`;
      if (nodeSeen.has(k)) continue;
      nodeSeen.add(k);
      nodes.push(n);
    }
  }

  const totalChanged = modified.length + added.length + deleted.length;
  const score =
    totalChanged > 0 ? Math.min(1, aligned.length / totalChanged) : head.alignment_score ?? 0;
  // A commit message is a stated reason: the CLI folds it into the text it
  // scores, so `mismatched` below was already measured against it. Judging
  // the run on intent rows alone called every message-only run "No clear
  // match" in red — an accusation of divergence over work the CLI's own
  // per-commit scoring had found fully covered. Only the run with no reason
  // anywhere is a real hole.
  const anyMessage = live.some((r) => r.commit_message?.trim());
  const banner: IntentReport["banner"] =
    stated.length === 0 && !anyMessage
      ? "diverged"
      : mismatched.length === 0
        ? "aligned"
        : aligned.length >= mismatched.length
          ? "drift"
          : "diverged";

  return {
    ...head,
    stated,
    modified_nodes: modified,
    added_nodes: added,
    deleted_nodes: deleted,
    aligned_nodes: aligned,
    mismatched_nodes: mismatched,
    changed_files,
    nodes: nodes.length > 0 ? nodes : undefined,
    alignment_score: score,
    banner,
  };
}

// ── Who asked, and what the AI said ──────────────────────────────────

// A normalized "Asked" beat — either the user's real prompt (from the
// correlated Claude session) or, failing that, the earliest genuine logged
// intent. `fromSession` drives the provenance line.
export type AskedNode = {
  text: string;
  agentId: string;
  timestamp: number;
  intentType?: string | null;
  fromSession: boolean;
};

/** Split a report's stated intents into the user's "asked" (the correlated
 *  session's first prompt, else the earliest genuine logged intent) and the
 *  "said" (every other genuine intent). Guard `[auto]` placeholders are
 *  dropped — they name no real work. Shared by the standalone story and the
 *  session Alignment tab so both read the same beats from one rule. */
export function deriveAskedSaid(
  report: IntentReport,
  sessions: ClaudeSession[],
): { asked: AskedNode | null; said: StatedIntent[] } {
  const genuine = [...report.stated]
    .filter((s) => !isAutoStubText(s.intent) && s.source !== "guard_auto_stub")
    .sort((a, b) => a.timestamp - b.timestamp);

  // Borrow a Claude transcript only when this commit could have come from one.
  // `correlateClaudeSession` gates the same borrow row by row and says why:
  // an agent that keeps its own logs (codex, gemini, …) must never be shown
  // wearing a nearby Claude session's prompt. Here the evidence is the
  // report's own rows — if every one of them names such an agent, the closest
  // Claude prompt is somebody else's work, and it would render under Claude's
  // badge as the reason for this change.
  const claudeAuthored =
    genuine.length === 0 || genuine.some((s) => !isNonClaudeAgent(s.agent_id));
  const sess = claudeAuthored
    ? nearestSessionByTime(report.commit_time, sessions)
    : null;
  const sessionPrompt = sess?.first_prompt?.trim() || "";
  if (sessionPrompt) {
    return {
      asked: {
        text: sessionPrompt,
        agentId: "claude",
        timestamp: sess ? sess.mtime : report.commit_time,
        fromSession: true,
      },
      said: genuine,
    };
  }
  // An ask is something somebody stated. A `brain_inferred` line was written
  // by Aura afterwards, from the diff — promoting it here would print it under
  // the heading "Asked" as the origin of the very change it describes. It
  // stays in "Said", where it is marked; with nothing else on record the beat
  // says outright that the change has no stated origin.
  const first = genuine.find((s) => s.source !== "brain_inferred");
  if (first) {
    return {
      asked: {
        text: first.intent,
        agentId: first.agent_id,
        timestamp: first.timestamp,
        intentType: first.intent_type,
        fromSession: false,
      },
      said: genuine.filter((s) => s !== first),
    };
  }
  return { asked: null, said: genuine };
}

// ── Data shaping ─────────────────────────────────────────────────────

// Use the CLI's structured nodes when present; otherwise synthesize cards
// from the string arrays so the page is rich on a new binary and still
// works on an old one. The change axis (added/modified/deleted) and the
// coverage axis (aligned) are merged: each changed symbol becomes one card
// tagged with whether the task named it.
export function deriveNodes(report: IntentReport): NodeRef[] {
  if (report.nodes && report.nodes.length > 0) return report.nodes;
  const aligned = new Set(report.aligned_nodes);
  const mk = (ids: string[], change: NodeRef["change"]): NodeRef[] =>
    ids.map((id) => ({
      identifier: id,
      kind: "",
      change,
      covered: aligned.has(id),
    }));
  return [
    ...mk(report.modified_nodes, "modified"),
    ...mk(report.added_nodes, "added"),
    ...mk(report.deleted_nodes, "deleted"),
  ];
}

/** How much a piece is worth a second look: a possible secret beats an
 *  unfinished bit beats a deletion; ordinary edits and additions score 0. */
export function riskScore(n: NodeRef): number {
  return (n.contains_secret ? 4 : 0) + (n.is_stub ? 2 : 0) + (n.change === "deleted" ? 1 : 0);
}

// A "capability" is a named thing a person can reason about — a function,
// method, class, component. Bare values (a local, a constant, a type alias) are
// internal mechanics. Unknown/blank kinds count as capabilities so a change we
// simply couldn't classify is never hidden.
const CAPABILITY_KIND =
  /function|fn|method|class|interface|enum|struct|trait|component|hook|constructor|module/i;
export function isCapabilityNode(n: NodeRef): boolean {
  const k = (n.kind || "").toLowerCase();
  return k === "" || CAPABILITY_KIND.test(k);
}

/** A plain noun for the kind — what a person would call this piece of code.
 *  Null when the CLI carried no kind (a piece synthesized from a name list). */
export function kindNoun(kind: string): string | null {
  const k = (kind || "").toLowerCase().trim();
  if (!k) return null;
  if (k.includes("class")) return "class";
  if (k.includes("component")) return "component";
  if (k.includes("hook")) return "hook";
  if (k.includes("method")) return "method";
  if (k.includes("constructor")) return "setup";
  if (k.includes("function") || k === "fn") return "function";
  if (k.includes("interface")) return "interface";
  if (k.includes("enum")) return "enum";
  if (k.includes("type")) return "type";
  if (
    k.includes("variable") ||
    k.includes("declarator") ||
    k.includes("const") ||
    k.includes("field") ||
    k.includes("property")
  )
    return "value";
  return "code";
}

/** What this report's score was computed against — see lib/intentBasis.
 *  Every verdict rendering in this file goes through here, so the chip, the
 *  glyph and the sentence can't reach different conclusions. */
export function reportBasis(report: IntentReport): IntentBasis {
  return intentBasis(report.stated, report.commit_message);
}

/** The mark drawn beside the verdict. `?` whenever there was nothing for
 *  the change to disagree with — a tick there would be unearned. */
export function verdictGlyph(report: IntentReport): string {
  if (!basisCanBeChecked(reportBasis(report))) return "?";
  return report.banner === "aligned" ? "✓" : report.banner === "drift" ? "–" : "✗";
}

export function bannerTone(report: IntentReport): {
  /** The ink the verdict is drawn in: yellow, green or red. */
  color: string;
  /** The same reading as a library tone, for the glyph and the mark. */
  tone: VerdictTone;
  label: string;
  msg: string;
  /** Extra line under `msg`, when the verdict stands but rests on something
   *  the reader should know about. Empty most of the time. */
  note: string;
} {
  // A pass or a fail is only meaningful when the reason was written
  // independently of the change. When it wasn't, say what's missing rather
  // than dress the score up as a verdict.
  const basis = reportBasis(report);
  if (!basisCanBeChecked(basis)) {
    return {
      color: "var(--ui-yellow)",
      tone: "warn",
      label: uncheckableLabel(basis),
      msg: uncheckableNote(basis),
      note: "",
    };
  }

  if (report.banner === "aligned") {
    return {
      color: "var(--ui-green)",
      tone: "good",
      label: "Matches task",
      msg: "Every changed piece is covered by the recorded reason.",
      note: mixedBasisNote(basis),
    };
  }
  if (report.banner === "drift") {
    return {
      color: "var(--ui-yellow)",
      tone: "warn",
      label: "Needs review",
      msg: "Some changed pieces weren't named in the reason.",
      note: mixedBasisNote(basis),
    };
  }
  return {
    color: "var(--ui-red)",
    tone: "bad",
    label: "No clear match",
    msg: "The reason covers few or none of the changed pieces.",
    note: mixedBasisNote(basis),
  };
}

export function formatRelative(unix: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(unix, { style: "compact" });
}

export function formatAbsolute(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

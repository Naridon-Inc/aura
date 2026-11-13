// The safety check's raw findings, read as rows a person can scan: a
// severity parsed off each line, near-identical lines folded into one row
// with a count, and the rows ordered worst first.

import type { AuraHumanFinding, PrDetail } from "../../../lib/api";
import { RAW_FINDING_STREAMS, type RawFindingStream } from "../../../lib/prReviewState";

// ── Safety-check findings ────────────────────────────────────────────
// The Aura review JSON is a flat bag of free-text findings spread across a
// few fields. Rendered raw (the old version dumped each as a truncated
// monospace <li>) it degenerated into a wall of identical sentences — a
// historical engine bug emitted one "graph-neighborhood overlap" finding
// PER local branch, so a busy repo showed 100+ near-copies and the panel
// read as pure noise. This view: parses a severity off each line, collapses
// findings that differ only by the ref/branch they name into one row with a
// ×N count (the specifics drill down on demand), groups by severity, and
// draws them as the check report's rows instead of raw monospace.

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
/** Which mark a check-report row draws: a cross, a warning, or a quiet ring. */
export type CheckStatus = "failed" | "attention" | "pending";

export const SEVERITY_STATUS: Record<Severity, CheckStatus> = {
  critical: "failed",
  high: "failed",
  medium: "attention",
  low: "pending",
  info: "pending",
};
export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export type RawFinding = { category: string; defaultSev: Severity; text: string };

// Each raw stream's category and default severity. Keyed by the one stream
// list, so a stream the engine adds can't be left out of this panel.
export const STREAM_CATEGORY: Record<RawFindingStream, [string, Severity]> = {
  invariant_violations: ["Invariant", "high"],
  cross_branch_conflicts: ["Cross-branch", "medium"],
  blast_radius: ["Blast radius", "info"],
  omni_graph_impact: ["Cross-repo", "medium"],
  taste_findings: ["Taste", "low"],
};

export function collectRawFindings(
  review: NonNullable<PrDetail["aura_review"]>,
): RawFinding[] {
  const out: RawFinding[] = [];
  for (const stream of RAW_FINDING_STREAMS) {
    const [category, defaultSev] = STREAM_CATEGORY[stream];
    for (const t of review[stream] ?? []) {
      const text = t.trim();
      if (text) out.push({ category, defaultSev, text });
    }
  }
  return out;
}

// Plain-language label for the engine's internal finding categories, so the
// little tag on each finding row reads like English instead of compiler
// vocabulary. Matches the Safety check counters elsewhere ("Broken rules",
// "Ripple effects", "Branch clashes").
export const CATEGORY_LABELS: Record<string, string> = {
  Invariant: "Broken rule",
  "Cross-branch": "Branch clash",
  "Blast radius": "Ripple effect",
  "Cross-repo": "Other repo",
  Taste: "Style",
};
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

// Categories whose findings are prose sentences from the engine (rule breaks,
// clashes) read better humanized and in a normal font; the rest are bare code
// identifiers (symbol names) that stay in mono.
export function isProseCategory(category: string): boolean {
  return category === "Invariant" || category === "Cross-branch";
}

export function normSeverity(token: string): Severity {
  const t = token.toLowerCase();
  if (t === "critical") return "critical";
  if (t === "high") return "high";
  if (t === "moderate" || t === "medium" || t === "med") return "medium";
  if (t === "low") return "low";
  return "info"; // info | note
}

export function parseSeverity(raw: RawFinding): { severity: Severity; text: string } {
  const m = raw.text.match(
    /^\s*(critical|high|moderate|medium|med|low|info|note)\s*[:\-–—]\s*/i,
  );
  if (m) {
    return { severity: normSeverity(m[1]), text: raw.text.slice(m[0].length).trim() };
  }
  // No explicit prefix → category default, with a small escalation: a
  // deleted/removed protected node is critical, not merely "high".
  if (
    raw.category === "Invariant" &&
    /\b(delete|deleted|removed|protected node)\b/i.test(raw.text)
  ) {
    return { severity: "critical", text: raw.text };
  }
  return { severity: raw.defaultSev, text: raw.text };
}

// Collapse the variable tail of a finding so messages that differ only by
// the branch/ref they name fold into one template. "Graph-neighborhood
// overlap detected with branch aura/snapshot/x" → "Graph-neighborhood
// overlap detected". Falls back to the original when stripping would leave
// too little to read.
export function genericLabel(text: string): string {
  const t = text
    .replace(/\bwith\s+branch\b.*$/i, "")
    .replace(/\b(on|against|with|branch|ref)\b[\s:'"]*[\w./-]+.*$/i, "")
    .replace(/aura\/snapshot\/[\w./-]+/gi, "")
    .replace(/[\s:–—-]+$/g, "")
    .trim();
  return t.length >= 6 ? t : text.trim();
}

export type FindingGroup = {
  key: string;
  severity: Severity;
  category: string;
  label: string;
  items: string[];
  count: number;
};

export function buildFindingGroups(
  review: NonNullable<PrDetail["aura_review"]>,
): FindingGroup[] {
  const map = new Map<string, FindingGroup>();
  for (const raw of collectRawFindings(review)) {
    const { severity, text } = parseSeverity(raw);
    const label = genericLabel(text);
    const key = `${raw.category}::${label.toLowerCase()}`;
    const g = map.get(key);
    if (!g) {
      map.set(key, {
        key,
        severity,
        category: raw.category,
        label,
        items: [text],
        count: 1,
      });
    } else {
      g.count += 1;
      if (!g.items.includes(text)) g.items.push(text);
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[g.severity]) {
        g.severity = severity;
      }
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
  );
}

// The humanized review's own severities, as chips.
export const HUMAN_SEVERITY_STATUS: Record<AuraHumanFinding["severity"], CheckStatus> = {
  critical: "failed",
  warning: "attention",
  advisory: "pending",
  info: "pending",
};
export const HUMAN_SEVERITY_LABEL: Record<AuraHumanFinding["severity"], string> = {
  critical: "Must fix",
  warning: "Review",
  advisory: "Style",
  info: "FYI",
};
export const HUMAN_SEVERITY_RANK: Record<AuraHumanFinding["severity"], number> = {
  critical: 0,
  warning: 1,
  advisory: 2,
  info: 3,
};

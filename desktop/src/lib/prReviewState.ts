// What the PR "Findings" panel is allowed to say, and when.
//
// The panel used to answer from one value:
//
//     {!review ? "No Aura review on disk for base X — run `aura pr-review`"
//              : groups.length === 0 ? "No semantic findings — clean review."
//              : <FindingsList/>}
//
// `review` was `Option<AuraReviewPayload>` filled by a reader that returned
// `None` when the reviews directory couldn't be opened, when a file couldn't
// be read, and when a review written by a different build of the CLI failed
// to parse — so a definite claim about the contents of a directory was being
// made from a read that had failed, and the advice attached to it was to
// re-run the command that produced the file we'd just refused to read.
//
// And `groups` was a fold over five streams, one of which (`taste_findings`)
// the Tauri bridge silently dropped because its struct didn't name the field.
// `risk_score` counts those findings, so the same row could show an elevated
// risk beside the words "clean review".
//
// So: every answer here is earned by a read that came back, and "clean" is
// only reachable when every stream the engine can fill was actually looked at
// and was actually empty.

import type { AuraReviewPayload } from "./api";

/** The raw finding streams a review carries, in the order the panel groups
 *  them. One list, so the fold, the counter and the coverage test can't drift
 *  apart — the last time a stream went missing, nothing noticed for a release. */
export const RAW_FINDING_STREAMS = [
  "invariant_violations",
  "cross_branch_conflicts",
  "blast_radius",
  "omni_graph_impact",
  "taste_findings",
] as const;

export type RawFindingStream = (typeof RAW_FINDING_STREAMS)[number];

export type PrReviewInput = {
  /** `PrDetail.aura_review` — the newest review on disk for this base. */
  review: AuraReviewPayload | null | undefined;
  /** `PrDetail.aura_review_error` — why the read came back empty, or what it
   *  had to skip. Absent means the read completed and found what it found. */
  reviewError?: string | null;
  /** The PR's base branch, for the "nothing here yet" advice. */
  base: string;
};

export type PrReviewState =
  /** The read itself failed. We know nothing about this PR's review. */
  | { kind: "failed"; title: string; message: string }
  /** The read completed and there is genuinely no review for this base. */
  | { kind: "absent"; title: string; body: string }
  /** A file is there and this build can't make sense of it. Not the same as
   *  "there isn't one", and very much not the same as "it's clean". */
  | { kind: "unreadable"; title: string; message: string }
  /** The engine's plain-language cards. */
  | { kind: "humanized"; total: number; unverified: number }
  /** Older review — group the raw streams ourselves. */
  | { kind: "raw"; total: number; unverified: number }
  /** Every stream was read and every stream was empty. */
  | { kind: "clean"; title: string; body: string | null };

/** `unverified_nodes` is opaque JSON from the engine (`serde_json::Value`):
 *  an array of symbol names, or of `{path, node}` objects, or absent. It adds
 *  20 to the risk score and no panel has ever rendered it — so the one thing
 *  we must not do is let it be silently zero. */
export function countUnverified(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object")
    return Object.keys(value as Record<string, unknown>).length;
  return 0;
}

/** Every raw finding line a review carries, in stream order. The one fold —
 *  the panel's count, the panel's list and the per-file badge all read this,
 *  so none of them can be looking at a different set of streams. */
export function rawFindingTexts(review: AuraReviewPayload): string[] {
  const out: string[] = [];
  for (const stream of RAW_FINDING_STREAMS) {
    const arr = review[stream] as string[] | undefined;
    for (const t of arr ?? []) if (t.trim()) out.push(t);
  }
  return out;
}

/** How many raw findings a review carries, across every stream. */
export function countRawFindings(review: AuraReviewPayload): number {
  return rawFindingTexts(review).length;
}

/** The strings `unverified_nodes` names — symbol names, or the `path` and
 *  `node` of each `{path, node}` object. It is `serde_json::Value`, so this
 *  is best-effort by construction; what it must not be is silently empty. */
export function unverifiedTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const n of value) {
    if (typeof n === "string") {
      if (n.trim()) out.push(n);
      continue;
    }
    if (n && typeof n === "object") {
      const obj = n as Record<string, unknown>;
      for (const key of ["path", "node"] as const) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) out.push(v);
      }
    }
  }
  return out;
}

/** How many findings name each of these files.
 *
 *  Substring-matched against the freeform lines the engine emits, because it
 *  has never surfaced structured per-file findings — fragile, and the file
 *  rows say "worth a look", not "wrong". What it may not do is fold over a
 *  SUBSET of the streams: this used to read `invariant_violations`,
 *  `blast_radius` and `cross_branch_conflicts` only, so a file whose findings
 *  were all taste or omni-graph ones showed no badge at all while the panel
 *  above it counted them. A row with no badge reads as a clean file. */
export function findingsByPath(
  review: AuraReviewPayload | null | undefined,
  paths: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!review) return out;
  const haystacks = [
    ...rawFindingTexts(review),
    ...unverifiedTexts(review.unverified_nodes),
  ];
  for (const path of paths) {
    if (!path) continue;
    let n = 0;
    for (const h of haystacks) if (h.includes(path)) n += 1;
    if (n > 0) out.set(path, n);
  }
  return out;
}

/** True when the engine wrote the humanized surface (`pr_humanize`). Older
 *  binaries leave all three empty and the raw streams are all we have. */
export function hasHumanizedSurface(review: AuraReviewPayload): boolean {
  return (
    (review.findings ?? []).length > 0 ||
    (review.changes ?? []).some((c) => !!c.why) ||
    !!(review.summary && review.summary.trim())
  );
}

/** A review whose own base branch is missing didn't come from a build that
 *  agrees with this one about what a review is. Every field on the bridge
 *  struct is `#[serde(default)]`, so *any* JSON object deserializes into a
 *  review with nothing in it — and a review with nothing in it reads exactly
 *  like a clean one. */
function identifiable(review: AuraReviewPayload): boolean {
  return typeof review.base_branch === "string" && review.base_branch !== "";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function prReviewState(input: PrReviewInput): PrReviewState {
  const { review, reviewError, base } = input;

  if (!review) {
    if (reviewError) {
      return {
        kind: "failed",
        title: "Aura couldn’t read this project’s reviews",
        message: reviewError,
      };
    }
    return {
      kind: "absent",
      title: "No Aura review yet",
      body: `Nothing has reviewed this branch against ${base}. Run a safety check to see what changed and whether anything looks risky.`,
    };
  }

  if (!identifiable(review)) {
    return {
      kind: "unreadable",
      title: "This review was written by a different version of Aura",
      message:
        reviewError ??
        "The file is there, but it doesn’t have the shape this build expects. Update Aura, or run the safety check again to write a fresh one.",
    };
  }

  const unverified = countUnverified(review.unverified_nodes);

  // A humanized review keeps its own renderer even with no finding cards —
  // the summary and the per-file "why" are the point of it. The unverified
  // count rides along so the empty-list line can't claim more than it knows.
  if (hasHumanizedSurface(review)) {
    const total = (review.findings ?? []).reduce(
      (n, f) => n + Math.max(1, f.count),
      0,
    );
    return { kind: "humanized", total, unverified };
  }

  const raw = countRawFindings(review);
  if (raw > 0) return { kind: "raw", total: raw, unverified };

  const line = noFindingsLine(unverified);
  return { kind: "clean", title: line.title, body: line.body };
}

/** What to say when a review came back with no findings in it.
 *
 *  One function, because three surfaces need this sentence and the whole
 *  defect was surfaces answering the same question differently. "Clean" is
 *  only true when there was nothing the engine couldn't check. */
export function noFindingsLine(unverified: number): {
  title: string;
  body: string | null;
  clean: boolean;
} {
  if (unverified > 0) {
    return {
      title: "Nothing flagged, but not everything could be checked",
      body: `${unverified} changed ${plural(unverified, "piece", "pieces")} of code couldn’t be traced back to a proven starting point, so this isn’t a full all-clear.`,
      clean: false,
    };
  }
  return { title: "Nothing needs attention", body: null, clean: true };
}

/** The number beside the word "Findings". Computed from the same fold the
 *  list below it is drawn from, so the two can't disagree. */
export function prReviewTotal(state: PrReviewState): number {
  return state.kind === "humanized" || state.kind === "raw" ? state.total : 0;
}

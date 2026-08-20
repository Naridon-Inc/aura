// What the alignment check is actually checking against.
//
// `aura intent-vs-actual` scores the reason text against the AST nodes a
// commit changed. That is a real check only when the reason was written
// independently of the change. It often isn't:
//
//   • When an agent edits files without calling `log-intent`, the mutation
//     guard fills the reason in for it. Best source first: the session's
//     opening prompt (`session_prompt`), else a line Aura's own model wrote
//     *by reading the diff* (`brain_inferred`), else a placeholder naming
//     the file count (`guard_auto_stub`). Which one it used is stamped on
//     the row as `changeset.source`.
//   • A `brain_inferred` line therefore describes the very nodes it is then
//     compared against. It matches by construction. Scoring it produces a
//     high number and a green "Matches task" no matter what the agent did —
//     the weakest row in the log yielding the most reassuring verdict.
//   • A `guard_auto_stub` line names no identifiers at all, so it scores ~0
//     and reads red — "the AI went off-script" — when the truth is that
//     nobody ever said what the change was for.
//
// So the score alone can't be rendered as a verdict. This module derives the
// one fact the surfaces need first: is there anything here that could have
// disagreed? Kept in `lib/` because three surfaces ask it — the Alignment
// beat, the per-commit dot, and the Drift gate — and they must not each
// answer it their own way.

import { isAutoStubText } from "./sessionMeta";

export type IntentBasis =
  /** Somebody stated the reason — a typed intent, a session prompt, or a
   *  commit message. Independent of the diff, so the score means something. */
  | "stated"
  /** Every reason on record was written by Aura from this same change. */
  | "inferred"
  /** Both kinds present. The score still rests on at least one real reason. */
  | "mixed"
  /** Only the guard's placeholder — an agent edited, nobody said why. */
  | "uncaptured"
  /** Nothing recorded near this commit at all, not even a message. */
  | "none";

/** The subset of a stated-intent row this derivation reads. Structural so
 *  both the full report type and the slim chip cache can pass their rows. */
export type BasisRow = {
  intent: string;
  source?: string | null;
};

/**
 * Classify what a commit's alignment score was computed against.
 *
 * `commitMessage` counts as a stated reason because the CLI concatenates it
 * with the intent rows to build the haystack it scores — a commit whose
 * message says why *is* being checked against something a person wrote,
 * even with an empty intent log.
 */
export function intentBasis(
  rows: readonly BasisRow[] | null | undefined,
  commitMessage?: string | null,
): IntentBasis {
  let stated = commitMessage && commitMessage.trim() ? 1 : 0;
  let inferred = 0;
  let placeholder = 0;

  for (const r of rows ?? []) {
    if (r.source === "brain_inferred") inferred++;
    else if (r.source === "guard_auto_stub" || isAutoStubText(r.intent)) placeholder++;
    else stated++;
  }

  if (stated > 0 && inferred > 0) return "mixed";
  if (stated > 0) return "stated";
  if (inferred > 0) return "inferred";
  if (placeholder > 0) return "uncaptured";
  return "none";
}

/** True when the score is a comparison between two independent things, and
 *  so may be rendered as a verdict. False means the number exists but
 *  answers nothing — show what's missing instead of a pass or a fail. */
export function basisCanBeChecked(basis: IntentBasis): boolean {
  return basis === "stated" || basis === "mixed";
}

/** Plain-language headline for a basis that can't be checked. Empty for the
 *  two that can — the verdict itself is the headline there. */
export function uncheckableLabel(basis: IntentBasis): string {
  return basisCanBeChecked(basis) ? "" : "Nothing to check against";
}

/** Why there's nothing to check against, in the user's terms. Empty for a
 *  basis that can be checked. */
export function uncheckableNote(basis: IntentBasis): string {
  switch (basis) {
    case "inferred":
      return "Nobody recorded what this change was for. The line being compared was written by Aura, from this same change, so it lines up whatever the agent did.";
    case "uncaptured":
      return "An agent changed these files while nobody was recording a reason. There is no statement of intent to hold the code against.";
    case "none":
      return "No reason and no commit message were recorded here, so there is nothing to compare the change to.";
    default:
      return "";
  }
}

/** One-line form of {@link uncheckableNote}, for a tooltip or a chip where
 *  the full sentence won't fit. Same fact, fewer words. */
export function uncheckableShort(basis: IntentBasis): string {
  switch (basis) {
    case "inferred":
      return "Aura wrote this reason from the change itself. Nothing independent to check";
    case "uncaptured":
      return "An agent changed these files and nobody recorded a reason";
    case "none":
      return "Nothing recorded to check against";
    default:
      return "";
  }
}

/** Disclosure for a `mixed` basis: the verdict stands, but one of the
 *  reasons behind it came from Aura rather than from whoever changed the
 *  code. Empty for every other basis. */
export function mixedBasisNote(basis: IntentBasis): string {
  return basis === "mixed"
    ? "One of the reasons below was written by Aura from the change itself, not by whoever made it."
    : "";
}

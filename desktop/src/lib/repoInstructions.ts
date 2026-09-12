// Per-repo instructions for the agent — how THIS repo wants its reviews
// done, its pull requests written, and its conflicts resolved. They live in
// the repo's `.aura/settings.toml` (edited from Settings → Copies & scripts)
// and get appended to the prompts Aura seeds, so a rule like "always link
// the Linear ticket in the PR body" reaches the agent without anyone
// retyping it per task.
//
// This module is PURE — no Tauri, no store — so the composition is unit
// testable. The cache that fetches settings for the active repo lives in
// `repoInstructionsStore.ts`.

import type { RepoWorktreeSettings } from "./api";

export type RepoInstructions = {
  review: string;
  pr: string;
  conflicts: string;
};

export const EMPTY_INSTRUCTIONS: RepoInstructions = {
  review: "",
  pr: "",
  conflicts: "",
};

/** Trim a settings field down to the text we would append: null, blank and
 *  whitespace-only all read as "nothing configured". */
function clean(text: string | null | undefined): string {
  return (text ?? "").trim();
}

/** Pull the three instruction texts out of a settings payload. Tolerates a
 *  payload from an older backend that has none of the fields. */
export function instructionsFromSettings(
  settings: Partial<RepoWorktreeSettings> | null | undefined,
): RepoInstructions {
  return {
    review: clean(settings?.reviewInstructions),
    pr: clean(settings?.prInstructions),
    conflicts: clean(settings?.conflictInstructions),
  };
}

/** Append one block of repo-specific instructions under a heading. Returns
 *  the prompt untouched when the text is blank, so a repo with nothing
 *  configured never gets an empty "This repo's rules:" section. */
export function withRepoInstructions(
  prompt: string,
  text: string | null | undefined,
  heading: string,
): string {
  const body = clean(text);
  if (!body) return prompt;
  const base = prompt.replace(/\s+$/, "");
  return `${base}\n\n${heading}\n${body}`;
}

export const PR_INSTRUCTIONS_HEADING =
  "This repo has its own rules for pull requests. Follow them:";
export const REVIEW_INSTRUCTIONS_HEADING =
  "This repo has its own rules for reviews. Follow them:";
export const CONFLICT_INSTRUCTIONS_HEADING =
  "This repo has its own rules for resolving conflicts. Follow them:";

export function appendPrInstructions(
  prompt: string,
  instructions: RepoInstructions | null | undefined,
): string {
  return withRepoInstructions(prompt, instructions?.pr, PR_INSTRUCTIONS_HEADING);
}

export function appendReviewInstructions(
  prompt: string,
  instructions: RepoInstructions | null | undefined,
): string {
  return withRepoInstructions(
    prompt,
    instructions?.review,
    REVIEW_INSTRUCTIONS_HEADING,
  );
}

export function appendConflictInstructions(
  prompt: string,
  instructions: RepoInstructions | null | undefined,
): string {
  return withRepoInstructions(
    prompt,
    instructions?.conflicts,
    CONFLICT_INSTRUCTIONS_HEADING,
  );
}

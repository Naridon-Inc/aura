// Parity W8 — PR skills: reusable prompt templates the Manager brain runs to
// shepherd a PR (describe, review, address feedback, ship).
//
// Each skill ships with a builtin template here, and a repo can override any
// of them by dropping `.aura/skills/pr/<id>.md` — same placeholder grammar —
// so teams tune the agent's PR voice without forking the app. Templates are
// plain markdown with `{{PLACEHOLDER}}` slots; `buildPrSkillPrompt` fills the
// slots and prepends the live repo-context block from `prFlowState`.
//
// Dispatch is intentionally not here: the PrRailPanel and the `/pr` chat verb
// both build the prompt with this module, then hand it to the ambient Manager
// session (`sendToAmbientManager`) — one brain path, two entries.

import { api } from "./api";
import { buildPrContextMarkdown, collectPrContext } from "./prFlowState";

export type PrSkillId = "describe" | "review" | "address" | "ship";

export type PrSkill = {
  id: PrSkillId;
  /** Button / menu label. */
  label: string;
  /** One-liner for help bubbles and tooltips. */
  summary: string;
  /** Builtin template — used when the repo has no override file. */
  template: string;
};

const DESCRIBE_TEMPLATE = `You are shepherding a pull request.

Write a complete PR description for {{PR_TITLE}} (branch \`{{HEAD_REF}}\`{{PR_NUMBER}}).

Requirements:
- Open with a 1–2 sentence summary of WHAT changed and WHY.
- A "Changes" section: bullet per logical change, grouped by area.
- A "Testing" section: what was verified and how.
- Call out anything reviewers should look at extra carefully (risk, tradeoffs, follow-ups).
- Keep it factual. Derive everything from the actual diff and commits, never invent.

{{CONTEXT}}`;

const REVIEW_TEMPLATE = `You are reviewing a pull request as a senior engineer on this codebase.

Review {{PR_TITLE}} (branch \`{{HEAD_REF}}\`{{PR_NUMBER}}).

Focus, in order:
1. Correctness. Bugs, missed edge cases, broken invariants.
2. Safety. Security issues, data loss paths, race conditions.
3. Architecture. Layer violations, duplication, APIs that will age badly.
4. Polish. Naming, dead code, missing tests. Mention only when it matters.

For each finding give file, what's wrong, and a concrete fix. End with a verdict:
approve / approve-with-nits / request-changes, plus one sentence of rationale.

{{CONTEXT}}`;

const ADDRESS_TEMPLATE = `You are addressing review feedback on a pull request.

Work through the open feedback on {{PR_TITLE}} (branch \`{{HEAD_REF}}\`{{PR_NUMBER}}):
- Read every unresolved review comment.
- For each: either implement the fix, or explain (briefly, in the code-change
  summary) why it should stay as-is.
- Keep fixes minimal and on-topic. No drive-by refactors.
- After the changes, summarize comment-by-comment what was done.

{{CONTEXT}}`;

const SHIP_TEMPLATE = `You are shipping a pull request.

Take {{PR_TITLE}} (branch \`{{HEAD_REF}}\`{{PR_NUMBER}}) the rest of the way:
1. Verify the working tree is committed and the branch is pushed.
2. Confirm checks are green and required reviews are in. If something is red
   or missing, STOP and report exactly what blocks the merge.
3. If everything is green: merge using the repo's preferred strategy, then
   confirm the merge landed and note any follow-up tasks.

Never force-merge past failing checks or missing approvals.

{{CONTEXT}}`;

export const PR_SKILLS: readonly PrSkill[] = [
  {
    id: "describe",
    label: "Describe",
    summary: "Draft a complete PR description from the actual diff and commits",
    template: DESCRIBE_TEMPLATE,
  },
  {
    id: "review",
    label: "Review",
    summary: "Senior-engineer review pass: correctness, safety, architecture",
    template: REVIEW_TEMPLATE,
  },
  {
    id: "address",
    label: "Address",
    summary: "Work through unresolved review comments with minimal fixes",
    template: ADDRESS_TEMPLATE,
  },
  {
    id: "ship",
    label: "Ship",
    summary: "Verify green checks + approvals, then merge, never force past red",
    template: SHIP_TEMPLATE,
  },
];

export function getPrSkill(id: string): PrSkill | null {
  return PR_SKILLS.find((s) => s.id === id) ?? null;
}

/**
 * Load the template for a skill — the repo's `.aura/skills/pr/<id>.md`
 * override when present and readable, else the builtin. Any read failure
 * (missing file, binary, too large) silently falls back: an override must
 * never be able to brick the button.
 */
export async function loadPrSkillTemplate(repoRoot: string, skill: PrSkill): Promise<string> {
  try {
    const file = await api.readFile(`${repoRoot}/.aura/skills/pr/${skill.id}.md`);
    if (file.status === "ok" && file.text.trim().length > 0) {
      return file.text;
    }
  } catch {
    // No override — builtin it is.
  }
  return skill.template;
}

export type PrSkillTarget = {
  /** GitHub PR number when the skill acts on an open PR. */
  prNumber?: number | null;
  /** PR title, or a stand-in like the branch name pre-PR. */
  title?: string | null;
  /** Head branch the work lives on. */
  headRef?: string | null;
};

/**
 * Build the final prompt for a skill: resolve template (override or builtin),
 * substitute placeholders, fill `{{CONTEXT}}` with the live repo snapshot plus
 * any extra context the caller already built (e.g. task-board context).
 */
export async function buildPrSkillPrompt(
  repoRoot: string,
  skill: PrSkill,
  target: PrSkillTarget,
  extraContext?: string,
): Promise<string> {
  const [template, ctx] = await Promise.all([
    loadPrSkillTemplate(repoRoot, skill),
    collectPrContext(repoRoot),
  ]);

  const contextBlock = [buildPrContextMarkdown(ctx), extraContext?.trim() || ""]
    .filter(Boolean)
    .join("\n\n");

  // split/join instead of replaceAll — the tsconfig lib predates es2021,
  // and split/join also won't reinterpret `$&`-style sequences in titles.
  const fill = (s: string, slot: string, value: string) => s.split(slot).join(value);
  let out = template;
  out = fill(out, "{{PR_NUMBER}}", target.prNumber != null ? `, PR #${target.prNumber}` : "");
  out = fill(out, "{{PR_TITLE}}", target.title?.trim() || "the current work");
  out = fill(out, "{{HEAD_REF}}", target.headRef?.trim() || ctx.branch || "current branch");
  out = fill(out, "{{CONTEXT}}", contextBlock);
  return out.trim();
}

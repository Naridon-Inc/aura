// What each agent-run git action says in the chat it opens.
//
// Create PR, Commit and push, Resolve, Fix errors, Pull latest, Update the PR
// and Add comments to chat each open a new chat tab and send one message
// there, so the work happens where it can be watched. This file is the pure
// half: the action, and what it knows about the branch, in; the tab's title,
// the message, and the words for a send that fails, out.
//
// A message that carries instructions sends them the way the composer sends
// an attached text file: a `File: <name>` block ahead of the short ask, so
// the chat shows "Create a PR" with "PR instructions.md" beside it.

import type { PrCheck, PrComment } from "./api";

export const PR_INSTRUCTIONS_FILE = "PR instructions.md";
export const FIX_ERRORS_FILE = "Fix errors instructions.md";

/** Where a repo keeps the template a new pull request's description follows,
 *  in the order they are looked for. */
export const PR_TEMPLATE_PATHS = [
  "pull_request_template.md",
  ".github/pull_request_template.md",
  "docs/pull_request_template.md",
];

/** A text file attached to a message, in the composer's own format. */
export function attachedFile(name: string, body: string): string {
  return `File: ${name}\n\`\`\`\n${body}\n\`\`\``;
}

/** Attached files first, then the ask: how the composer joins them. */
export function withFiles(ask: string, files: { name: string; body: string }[]): string {
  return [...files.map((f) => attachedFile(f.name, f.body)), ask].join("\n\n");
}

/** The repo's own rules, set apart so they win over the defaults above them.
 *  Blank rules add nothing. */
export function userPreferences(text: string | null | undefined): string {
  const body = (text ?? "").trim();
  if (!body) return "";
  return [
    "",
    "IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.",
    "## User Preferences",
    "<user-preferences>",
    body,
    "</user-preferences>",
  ].join("\n");
}

export type CreatePrInput = {
  branch: string;
  /** The remote the branch pushes to, e.g. `origin`. */
  remote: string;
  /** The branch the pull request goes into, e.g. `main`. */
  target: string;
  draft: boolean;
  /** A title the user already wrote; used exactly as-is. */
  title?: string;
  /** A description the user already wrote; used exactly as-is. */
  description?: string;
  /** The repo's pull request template, when it has one. */
  template?: string | null;
  /** The repo's own rules for pull requests. */
  preferences?: string | null;
  /** A separate repository inside the project (`cloud`) the PR is for,
   *  instead of the project itself. */
  folder?: string;
};

/** The steps the chat follows to open the pull request. */
export function createPrInstructions(i: CreatePrInput): string {
  let create = `Use \`gh pr create --base ${i.target}`;
  if (i.title) create += " --title <title>";
  if (i.description) create += " --body <description>";
  create += "` to create a PR onto the target branch.";
  if (!i.title) create += " Keep the title under 80 characters.";
  if (!i.description) {
    create +=
      " Keep the description under five sentences, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.";
  }
  const steps = [
    "If you have any skills related to creating PRs, invoke them now. Instructions there should take precedence over these instructions.",
    "Run `git status` to check for uncommitted changes. If there are any, review them with `git diff` and commit them. Follow any instructions the user gave you about writing commit messages.",
    `If the branch has no upstream or has unpushed commits, push with \`git push -u ${i.remote} HEAD\`. If the branch tracks a remote branch with a different name or on a different remote, push to that upstream instead.`,
    `Use \`git diff ${i.remote}/${i.target}...\` to review the PR diff`,
    create,
  ];
  let out = [
    "The user likes the current state of the code.",
    "",
    `The current branch is ${i.branch}.`,
    `The target branch is ${i.remote}/${i.target}.`,
    `The user requested a ${i.draft ? "draft " : ""}PR.`,
    ...(i.folder
      ? [
          "",
          `This PR is for the separate git repository in the \`${i.folder}/\` folder, not for the project around it. Run every git and gh command below from inside \`${i.folder}/\`.`,
        ]
      : []),
    "",
    "Follow these steps to create a PR:",
    "",
    steps.map((s) => `- ${s}`).join("\n"),
    "",
    "If any of these steps fail, ask the user for help.",
  ].join("\n");
  if (i.title) {
    out += `\n\n## PR Title\n\nThe user has provided this PR title. Use it exactly as-is:\n${i.title}`;
  }
  if (i.description) {
    out += `\n\n## PR Description\n\nThe user has provided this PR description. Use it exactly as-is:\n${i.description}`;
  }
  const template = i.template?.trim();
  if (template && !i.description) {
    out +=
      "\n\n## PR Description Template\n\nThis workspace has a PR template, which is provided below. Use it for writing the PR description, filling it in based on the changes made.\n\n" +
      `\`\`\`markdown\n${template}\n\`\`\``;
  }
  return `${out}\n${userPreferences(i.preferences)}`;
}

/** Bring the target in and settle the lines both sides changed. */
export function resolveConflictsInstruction(target: string, rebase = false): string {
  return rebase
    ? `Rebase your branch onto the remote branch (${target}) and resolve conflicts. Stage the resolved files and run \`git rebase --continue\`, then push --force-with-lease.`
    : `Merge the remote branch (${target}) into your branch and resolve conflicts. Then, commit and push your changes.`;
}

/** Bring `remote/target` in when a fast-forward can't. */
export function pullTargetInstruction(
  remote: string,
  target: string,
  hasUncommittedChanges: boolean,
): string {
  const ref = `${remote}/${target}`;
  return hasUncommittedChanges
    ? `Commit uncommitted changes, then merge ${ref} into this branch. Then push.`
    : `Merge ${ref} into this branch. Then push.`;
}

export const COMMIT_AND_PUSH = "Commit and push all changes";

/** Commit and push for the separate git repository in `folder`, which the
 *  project's own commit leaves alone. */
export function commitPushFolderInstruction(folder: string): string {
  return `Commit and push all changes in the separate git repository in the \`${folder}/\` folder, not the project around it. Run every git command from inside \`${folder}/\`.`;
}

export const RESOLVE_INCOMPATIBLE = "Resolve branch incompatibility with remote";
export const FIX_ERRORS = "Fix the failing CI actions. I've attached the failure logs.";

/** One failing check as the file the fix-errors message attaches. GitHub
 *  gives no logs for a run that never started, so its file carries the
 *  status and GitHub's reason instead. */
export function failingCheckFile(check: PrCheck): { name: string; body: string } {
  const id = check.url.match(/\/job\/(\d+)/)?.[1] ?? check.url.match(/\/runs\/(\d+)/)?.[1] ?? "";
  const safe = check.name.replace(/[^a-zA-Z0-9-_]/g, "_");
  const status = [
    "=== JOB STATUS ===",
    check.description.trim() || check.raw || "failed",
    ...(check.failure_reason.trim()
      ? ["", "=== GITHUB ANNOTATION ===", check.failure_reason.trim()]
      : []),
  ].join("\n");
  return {
    name: `${safe}${id ? `_${id}` : ""}_status.txt`,
    body: `Failing Job Name: ${check.name}\nGitHub Job ID: ${id}\n\n${status}`,
  };
}

function where(c: PrComment): string {
  return c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
}

/** A review comment as the chat receives it: who, where, and what they said. */
export function reviewCommentText(c: PrComment): string {
  return `@${c.author}${where(c)}: ${c.body.trim()}`;
}

/** Every agent-run git action, with what it needs to say its message. */
export type GitChatRequest =
  | ({ action: "create-pr" } & CreatePrInput)
  | { action: "commit-push"; folder?: string }
  | { action: "resolve-conflicts"; target: string; preferences?: string | null }
  | { action: "resolve-local-conflicts"; preferences?: string | null }
  | { action: "resolve-incompatible" }
  | { action: "pull-latest"; remote: string; target: string; hasUncommittedChanges: boolean }
  | { action: "fix-errors"; failing: PrCheck[]; preferences?: string | null }
  | { action: "add-comments"; pr: { number: number; title: string }; comments: PrComment[] }
  | { action: "update-pr"; branch: string; prNumber: number };

export type GitChat = {
  /** The new chat tab's title. */
  label: string;
  /** The message sent there, exactly as the chat shows it. */
  text: string;
  /** The toast's words when the chat can't be started or the send fails. */
  failure: string;
};

/** What a git action's chat is called and says. */
export function gitChatFor(req: GitChatRequest): GitChat {
  switch (req.action) {
    case "create-pr":
      return {
        label: req.draft ? "Create a draft PR" : "Create a PR",
        text: withFiles("Create a PR", [{ name: PR_INSTRUCTIONS_FILE, body: createPrInstructions(req) }]),
        failure: "Failed to create PR",
      };
    case "commit-push":
      // A separate repository inside the project commits on its own: the
      // project's commit never carries it.
      if (req.folder) {
        return {
          label: `Commit and push ${req.folder}`,
          text: commitPushFolderInstruction(req.folder),
          failure: "Failed to commit and push",
        };
      }
      return { label: COMMIT_AND_PUSH, text: COMMIT_AND_PUSH, failure: "Failed to commit and push" };
    case "resolve-conflicts":
      return {
        label: "Resolve merge conflicts",
        text: `${resolveConflictsInstruction(req.target)}\n${userPreferences(req.preferences)}`.trim(),
        failure: "Failed to resolve merge conflicts",
      };
    case "resolve-local-conflicts":
      return {
        label: "Resolve merge conflicts",
        text: `Resolve the merge conflicts in this branch, then commit and push your changes.\n${userPreferences(req.preferences)}`.trim(),
        failure: "Failed to resolve merge conflicts",
      };
    case "resolve-incompatible":
      return { label: RESOLVE_INCOMPATIBLE, text: RESOLVE_INCOMPATIBLE, failure: "Failed to resolve branch incompatibility" };
    case "pull-latest":
      return {
        label: `Pull latest ${req.target}`,
        text: pullTargetInstruction(req.remote, req.target, req.hasUncommittedChanges),
        failure: "Pulling latest from remote failed",
      };
    case "fix-errors":
      return {
        label: "Fix errors",
        text: withFiles(FIX_ERRORS, [
          ...req.failing.map(failingCheckFile),
          { name: FIX_ERRORS_FILE, body: `${FIX_ERRORS}\n${userPreferences(req.preferences)}`.trim() },
        ]),
        failure: "Failed to fix checks",
      };
    case "add-comments":
      return {
        label: "Address review comments",
        text: [
          `Review comments on PR #${req.pr.number} "${req.pr.title}". Please read them and address each one:`,
          "",
          ...req.comments.map((c) => `- ${reviewCommentText(c)}`),
        ].join("\n"),
        failure: req.comments.length === 1 ? "Failed to add comment to chat" : "Failed to add comments to chat",
      };
    case "update-pr":
      return {
        label: `Update PR #${req.prNumber}`,
        text: [
          `Update pull request #${req.prNumber} for branch \`${req.branch}\`. More work has landed since it was opened.`,
          "",
          `- Push the branch if it has unpushed commits.`,
          `- Read the current title and description with \`gh pr view ${req.prNumber} --json title,body\`.`,
          `- Rewrite them to match ALL changes in the branch now, with \`gh pr edit ${req.prNumber}\`. Keep the title under 80 characters and the description under five sentences, unless the user instructed you otherwise.`,
          "",
          "If any of these steps fail, ask the user for help.",
        ].join("\n"),
        failure: "Failed to update PR",
      };
  }
}

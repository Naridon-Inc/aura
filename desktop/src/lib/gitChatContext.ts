// What a git chat's message needs from the repo itself: the pull request
// rules and template someone wrote down, and the conflict rules. Read when the
// button is pressed, so an edit to the settings shows up in the next chat.

import { gitChatFor, PR_TEMPLATE_PATHS, type GitChat, type GitChatRequest } from "./gitChatPrompts";
import { readFile } from "./place/workApi";
import { loadRepoInstructions } from "./repoInstructionsStore";
import type { RepoInstructions } from "./repoInstructions";

type ReadText = (path: string) => Promise<{ text: string; status: string }>;

/** The repo's pull request template — the first of the usual places that
 *  holds readable text — or null when it has none. */
export async function readPrTemplate(repoRoot: string, read: ReadText = readFile): Promise<string | null> {
  for (const rel of PR_TEMPLATE_PATHS) {
    try {
      const file = await read(`${repoRoot}/${rel}`);
      if (file.status === "ok" && file.text.trim()) return file.text;
    } catch {
      // Not there: try the next place.
    }
  }
  return null;
}

export type RepoContextDeps = {
  instructions: (repoRoot: string) => Promise<RepoInstructions>;
  template: (repoRoot: string) => Promise<string | null>;
};

const liveDeps: RepoContextDeps = { instructions: loadRepoInstructions, template: (r) => readPrTemplate(r) };

/** `req`'s chat, with what the caller left unset filled from the repo. */
export async function withRepoContext(
  repoRoot: string,
  req: GitChatRequest,
  deps: RepoContextDeps = liveDeps,
): Promise<GitChat> {
  switch (req.action) {
    case "create-pr": {
      const [rules, template] = await Promise.all([
        req.preferences === undefined ? deps.instructions(repoRoot) : null,
        // A nested repository's PR uses that repository's template.
        req.template === undefined
          ? deps.template(req.folder ? `${repoRoot.replace(/\/+$/, "")}/${req.folder}` : repoRoot)
          : null,
      ]);
      return gitChatFor({
        ...req,
        preferences: req.preferences ?? rules?.pr ?? null,
        template: req.template ?? template,
      });
    }
    case "resolve-conflicts":
    case "resolve-local-conflicts": {
      const rules = req.preferences === undefined ? await deps.instructions(repoRoot) : null;
      return gitChatFor({ ...req, preferences: req.preferences ?? rules?.conflicts ?? null });
    }
    default:
      return gitChatFor(req);
  }
}

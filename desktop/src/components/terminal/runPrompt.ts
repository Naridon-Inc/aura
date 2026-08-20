// Asking a project how it should run.
//
// One implementation, two callers: the pencil on the Run row, and ⌘R pressed
// on a project we could not read a command out of. Both must ask the same
// question and show the same evidence, so neither owns it.
//
// It lives here rather than in `lib/runPane.ts` because asking needs the
// dialog host, and the Run logic is deliberately free of React so it can be
// tested without one.

import { askText } from "../ui/ask";
import { detectRun, resolveRunCommand, setRunCommandOverride } from "../../lib/runPane";

/** Fired after the pinned command changes, so every row showing it re-reads.
 *  `detail.repoRoot` is the project that changed. */
export const RUN_COMMAND_CHANGED = "aura:run-command-changed";

/** Ask for this project's run command and remember the answer.
 *
 *  Returns the command in force afterwards, or `null` if the person cancelled
 *  or cleared it — a caller that was about to run should then not run. We
 *  never fill the box with a hopeful guess: the suggestions are shown as
 *  suggestions, with the file each came from, and the empty case says plainly
 *  that the project told us nothing. */
export async function promptForRunCommand(repoRoot: string): Promise<string | null> {
  const suggestion = await detectRun(repoRoot).catch(() => null);
  const candidates = suggestion?.candidates ?? [];
  const body = candidates.length
    ? `This project suggests: ${candidates
        .map((c) => `${c.command} (${c.source})`)
        .join(", ")}`
    : "Nothing in this project said how to run it, so there is nothing to suggest.";

  const current = await resolveRunCommand(repoRoot);
  const next = await askText({
    title: "How should this project run?",
    body,
    label: "Command",
    value: current ?? "",
    placeholder: "npm run dev",
    submitLabel: "Save",
  });
  if (next === null) return null; // cancelled — change nothing, run nothing

  const trimmed = next.trim();
  setRunCommandOverride(repoRoot, trimmed || null);
  // Clearing the box falls back to whatever the repo says, which may be a
  // command or may be nothing. Re-resolve rather than assume what we wrote.
  const resolved = await resolveRunCommand(repoRoot);
  window.dispatchEvent(
    new CustomEvent(RUN_COMMAND_CHANGED, { detail: { repoRoot } }),
  );
  return resolved;
}

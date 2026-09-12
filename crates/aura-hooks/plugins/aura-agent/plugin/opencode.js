// Aura's OpenCode plugin: report what the agent changed, so the repo shows as
// worked-in rather than idle.
//
// OpenCode has no shell-command hooks — a plugin is a module it imports — so
// this is the shim rather than the decision. What counts as a change, and what
// the intent row says, live in `on-post-tool-use.sh` next door, the one body
// every non-Claude CLI runs. Duplicating that logic here is how the two would
// stop agreeing the first time either learned a new editing tool.
//
// Staged by `aura-hooks` at `~/.config/opencode/plugin/aura.js`, where OpenCode
// auto-discovers it for every project. Nothing is written into the repo.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK = join(homedir(), ".aura", "plugins", "aura-agent", "scripts", "on-post-tool-use.sh");

/** Hand one tool call to the shared hook and forget about it. Failure is not
 *  worth surfacing: the agent's own work succeeded, and only the record of it
 *  was missed. */
const report = (payload, cwd) => {
  try {
    const child = spawn(HOOK, {
      cwd,
      env: { ...process.env, AURA_HOOK_AGENT: "OpenCode" },
      stdio: ["pipe", "ignore", "ignore"],
      detached: false,
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  } catch {
    // no-op
  }
};

// One export, and a default one, against this repo's usual preference for
// named exports. OpenCode takes *any* export that looks like a plugin, so a
// module offering the same function twice risks registering it twice — and
// two registrations means two intent rows for every edit.
export default async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();
  return {
    "tool.execute.after": async (input) => {
      // `sessionID` is what makes these rows a session rather than a pile of
      // edits — the console groups by it. OpenCode puts it on the input
      // alongside the tool, so it costs nothing to carry.
      report(
        { tool: input.tool, args: input.args, sessionID: input.sessionID, cwd },
        cwd,
      );
    },
  };
};

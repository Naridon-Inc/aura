// The slash-command catalog for the native Aura chat. One source of truth,
// consumed in two places:
//   1. ManagerComposer's slash menu — the discoverability popup that appears
//      as soon as the user types `/`, so commands are findable without docs.
//   2. chatSlashHandler's `/help` — prints the same list as a chat bubble.
//
// The handlers themselves live in `chatSlashHandler.ts`; this file is purely
// the menu/metadata layer so the two never drift. Keep entries ordered by how
// often a user reaches for them.

export type ManagerCommand = {
  /** Primary verb, no leading slash. */
  name: string;
  /** Alternate verbs that fire the same handler. */
  aliases?: string[];
  /** Argument hint rendered after the verb (e.g. "<text>"). Omit for bare verbs. */
  args?: string;
  /** One-line description shown in the menu and in `/help`. */
  summary: string;
};

export const MANAGER_COMMANDS: ManagerCommand[] = [
  {
    name: "help",
    aliases: ["commands", "?"],
    summary: "List every slash command you can run here.",
  },
  {
    name: "status",
    summary: "Is your work safe? Recording, protection, and engine at a glance.",
  },
  {
    name: "capture",
    aliases: ["recording"],
    args: "[on|off]",
    summary: "Turn change-recording on or off for this project.",
  },
  {
    name: "doctor",
    aliases: ["health"],
    summary: "Check this project's health — stuck sessions, missing hooks, orphaned snapshots.",
  },
  {
    name: "resume",
    aliases: ["sessions", "history"],
    summary: "Reopen a previous Aura conversation.",
  },
  {
    name: "model",
    aliases: ["brain"],
    args: "[query]",
    summary: "Pick which AI answers the next message.",
  },
  {
    name: "agents",
    aliases: ["agent"],
    summary: "List the coding assistants installed on this machine.",
  },
  {
    name: "diff",
    args: "[file]",
    summary: "Show what changed in plain terms (whole tree, or one file).",
  },
  {
    name: "review",
    aliases: ["pr-review"],
    args: "[base]",
    summary: "Have Aura read your changes for bugs and risky deletions.",
  },
  {
    name: "prove",
    args: "<what you built>",
    summary: "Check the code really does what you set out to do.",
  },
  {
    name: "rewind",
    args: "<function> <file>",
    summary: "Roll one function back to its last safe version.",
  },
  {
    name: "search",
    args: "<text>",
    summary: "Find matching code across the repo.",
  },
  {
    name: "zone",
    aliases: ["zones"],
    args: "claim|release <path>",
    summary: "Claim, list, or release short-lived file ownership.",
  },
  {
    name: "team",
    args: "[members|invite <email>]",
    summary: "Team status, member list, and invites.",
  },
  {
    name: "taste",
    args: "[pending|rule <id>|approve|reject|sync]",
    summary: "Review and manage the project's learned taste rules.",
  },
  {
    name: "orchestrate",
    aliases: ["orch"],
    args: "[run <objective>|pause|resume|cancel]",
    summary: "Fan a goal out across multiple agents.",
  },
  {
    name: "loop",
    args: "[sync|run [n]]",
    summary: "Sync the task board into the dependency graph and run the ready set.",
  },
  {
    name: "pr",
    args: "describe|review|address|ship [#N]",
    summary: "Ask Aura to handle the PR — draft, review, address feedback, or ship.",
  },
  {
    name: "launch",
    args: "<branch> <agent> [agent…]",
    summary: "Create a parallel copy on a branch and spawn an agent fleet inside it.",
  },
];

/** Filter the catalog by a verb prefix (no leading slash). Matches the primary
 *  name and any alias, so `/his` surfaces `/resume`. Empty prefix returns all. */
export function matchManagerCommands(prefix: string): ManagerCommand[] {
  const p = prefix.toLowerCase();
  if (!p) return MANAGER_COMMANDS;
  return MANAGER_COMMANDS.filter(
    (c) =>
      c.name.startsWith(p) || (c.aliases ?? []).some((a) => a.startsWith(p)),
  );
}

/** The `/help` body — a markdown list mirroring the menu, rendered as a
 *  system bubble in the chat timeline. */
export function managerCommandHelp(): string {
  const lines = MANAGER_COMMANDS.map((c) => {
    const sig = `/${c.name}${c.args ? " " + c.args : ""}`;
    return `- \`${sig}\` — ${c.summary}`;
  });
  return [
    "**Slash commands**",
    "",
    "Type `/` in the composer to pick one without typing the whole thing.",
    "",
    ...lines,
    "",
    "**Claude Code's own commands**",
    "",
    "Your project's and personal Claude commands (`.claude/commands/*.md`) show",
    "up in the `/` menu tagged **Claude**. Pick one and it runs on Claude's CLI",
    "and replies right here — whichever brain is currently selected.",
    "",
    "**Send a command straight to one assistant**",
    "",
    "Start a message with `@<assistant> /<command>` to run it on that tool's",
    "own CLI — e.g. `@cc /resume` continues your last Claude Code session,",
    "`@claude /continue` does the same. The reply lands right here in the chat.",
    "",
    "_Everything else you type goes straight to Aura as a normal message._",
  ].join("\n");
}

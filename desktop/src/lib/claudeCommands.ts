// Claude Code's own custom slash commands, surfaced inside the Aura chat.
//
// Claude Code lets a project (`.claude/commands/*.md`) or a person
// (`~/.claude/commands/*.md`) define custom slash commands — each markdown file
// IS a command, named after its file. Those commands are Claude's, not Aura's,
// so they only make sense when run on Claude's CLI. This module discovers them
// (reusing the same `agent_skills_list` scan the Skills pane uses) and exposes:
//
//   • a menu list   → the TiptapComposer slash popup shows them alongside
//                     Aura's native verbs, tagged so the user knows they run on
//                     Claude;
//   • a sync lookup → chatSlashHandler routes a matching `/verb` to Claude's
//                     CLI no matter which brain is currently selected.
//
// Nothing is invented: a row here is a real `.md` file on disk. We key the
// invocation token off the file *basename* (the actual slash name Claude
// answers to) rather than any frontmatter `name`, which is only a display label.

import { api } from "./api";

export type ClaudeCommand = {
  /** The verb Claude answers to — the file stem, e.g. `commit` for
   *  `commit.md`. This is what gets sent as `/commit`. */
  name: string;
  /** One plain-language line (frontmatter `description` or the file's first
   *  prose line). May be empty. */
  summary: string;
  /** "project" (this repo's `.claude/commands`) or "user" (your home copy). */
  scope: "project" | "user";
  /** Absolute path to the source `.md`, for reference. */
  path: string;
};

/** Per-repo cache so the synchronous menu + handler lookups never block on a
 *  filesystem scan. Populated by `primeClaudeCommands`. A repo present here with
 *  an empty list HAS been scanned (it just has no Claude commands) — distinct
 *  from a repo never primed, so callers don't re-scan the filesystem on every
 *  miss in a repo that simply has none. */
const cache = new Map<string, ClaudeCommand[]>();

/** Repos that have actually been scanned at least once. A repo whose cache is an
 *  empty list IS in here (scanned, no commands) — `cache` presence alone can't
 *  tell "primed to empty" from "never primed", so callers gate a cold-prime on
 *  this Set instead of `cachedClaudeCommands(...).length === 0`. */
const primed = new Set<string>();

/** Derive the real slash name from a command file path — the basename without
 *  its `.md` extension. `…/.claude/commands/commit.md` → `commit`. */
function nameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

/** Scan this repo's installed Claude commands. Filters the shared agent-skills
 *  discovery down to Claude's slash commands, derives the invocation token from
 *  each file's name, and lets a project command shadow a same-named user one. */
export async function loadClaudeCommands(repoRoot: string): Promise<ClaudeCommand[]> {
  if (!repoRoot) return [];
  let skills;
  try {
    skills = await api.agentSkillsList(repoRoot);
  } catch {
    return [];
  }
  const byName = new Map<string, ClaudeCommand>();
  for (const s of skills) {
    if (s.agent !== "claude" || s.kind !== "command") continue;
    const name = nameFromPath(s.path);
    if (!name) continue;
    const scope: "project" | "user" = s.scope === "project" ? "project" : "user";
    const existing = byName.get(name.toLowerCase());
    // Project scope wins over user scope for the same command name (Claude's
    // own precedence), so don't let a later user-scope entry clobber it.
    if (existing && existing.scope === "project" && scope === "user") continue;
    byName.set(name.toLowerCase(), {
      name,
      summary: s.description || "",
      scope,
      path: s.path,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Populate the cache for `repoRoot`. Safe to call repeatedly — it overwrites
 *  the prior snapshot so newly-added command files show up on the next prime. */
export async function primeClaudeCommands(repoRoot: string): Promise<ClaudeCommand[]> {
  const list = await loadClaudeCommands(repoRoot);
  cache.set(repoRoot, list);
  primed.add(repoRoot);
  return list;
}

/** Whether `repoRoot` has been scanned at least once (even if it has no Claude
 *  commands). Lets the handler skip a redundant cold-prime on every unmatched
 *  `/verb` in a repo that genuinely has none. */
export function hasPrimed(repoRoot: string): boolean {
  return primed.has(repoRoot);
}

/** The last-primed snapshot for `repoRoot`, or an empty list. Synchronous. */
export function cachedClaudeCommands(repoRoot: string): ClaudeCommand[] {
  return cache.get(repoRoot) ?? [];
}

/** Find a primed Claude command by its slash verb (case-insensitive), or null.
 *  Used by chatSlashHandler to decide whether a fall-through `/verb` should be
 *  routed to Claude's CLI. */
export function findClaudeCommand(repoRoot: string, verb: string): ClaudeCommand | null {
  const v = verb.toLowerCase();
  return cachedClaudeCommands(repoRoot).find((c) => c.name.toLowerCase() === v) ?? null;
}

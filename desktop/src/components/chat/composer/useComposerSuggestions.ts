// What the composer's `/` and `@` lists offer, given the text before the
// caret. The shared composer draws the list, filters it by what was typed and
// inserts the pick; this only says which rows exist right now:
//
//   `/`  Aura's own verbs, then the repo's Claude commands, then whatever the
//        running agent published — or, for a composer that types straight
//        into one agent's CLI, that CLI's commands and nothing else.
//   `@`  the open board tasks (from `@ta`), the live terminal, and the files
//        in the folder being typed, so `@src/` lists what is in `src`.
//
// A folder pick leaves `@folder/` open so the next list descends into it; a
// task pick swaps the draft for that task's kickoff brief.

import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { ListTodo, Terminal } from "lucide-react";
import type { DirEntry, Task } from "../../../lib/api";
import { cachedClaudeCommands, primeClaudeCommands, type ClaudeCommand } from "../../../lib/claudeCommands";
import { loadDirList, peekDirList, warmDirList } from "../../../lib/dirListCache";
import { onIdle } from "../../../lib/idle";
import { matchManagerCommands } from "../../../lib/managerCommands";
import { fetchTasks } from "../../../lib/tasksCache";
import { FileIcon } from "../../FileIcon";
import { buildTaskAgentPrompt, taskRef } from "../../tasks/taskPrompt";
import type { ComposerSuggestion } from "../../ui/composer";

/** One row of a `/` list: a command, where it came from, and its hint. */
export type SlashItem = {
  name: string;
  summary: string;
  args?: string;
  /** Where the row came from, which decides its badge and its React key.
   *  `"cli"` rows belong to whichever agent CLI the host composer is driving
   *  and carry no badge — in that menu every row is that agent's, so labelling
   *  each one would be noise. */
  source: "aura" | "claude" | "cli" | "agent";
  scope?: "project" | "user";
  /** Badge text for `"agent"` rows — the agent that published the command,
   *  e.g. "OpenCode". These sit in a menu that also holds Aura's verbs and
   *  the repo's Claude commands, and which of the three a word belongs to
   *  decides where it runs. */
  badge?: string;
};

const HIDDEN = new Set([".git", "node_modules", "target"]);

function isClosedStatus(status: string): boolean {
  const s = (status || "").toLowerCase();
  return s === "done" || s === "completed" || s === "closed" || s === "cancelled";
}

/** The token the shared composer is completing: same rule it uses itself. */
export function composerToken(before: string): { sigil: "@" | "/"; query: string } | null {
  const m = before.match(/(?:^|\s)([@/])([^\s]*)$/);
  return m ? { sigil: m[1] as "@" | "/", query: m[2] } : null;
}

type Row = { id: string; text: string; kind: "dir" | "task" | "other"; task?: Task };

export function useComposerSuggestions({
  repoRoot,
  before,
  slashRows,
  agentRows,
  terminalAttaches = false,
}: {
  repoRoot: string | null;
  /** The draft up to the caret. */
  before: string;
  /** A composer that owns its whole command vocabulary (an agent's CLI). */
  slashRows?: (query: string) => SlashItem[];
  /** Commands the running agent published, after Aura's and the repo's. */
  agentRows?: SlashItem[];
  /** The host turns `@terminal` into the terminal's output at send, so the
   *  row says so. */
  terminalAttaches?: boolean;
}): {
  suggestions: ComposerSuggestion[];
  /** Applies what a pick means beyond inserting it: the next value of the
   *  draft, or null when the inserted text stands. */
  resolvePick: (pick: ComposerSuggestion, value: string) => string | null;
} {
  const token = composerToken(before);
  const slashQuery = token?.sigil === "/" ? token.query.toLowerCase() : null;
  const mentionQuery = token?.sigil === "@" ? token.query : null;

  const [claudeCmds, setClaudeCmds] = useState<ClaudeCommand[]>(() =>
    repoRoot ? cachedClaudeCommands(repoRoot) : [],
  );
  const [files, setFiles] = useState<DirEntry[]>([]);
  const [openTasks, setOpenTasks] = useState<Task[]>([]);

  // Re-read the repo's commands each time a `/` list opens, so a command file
  // added mid-session shows without a reload.
  useEffect(() => {
    if (!repoRoot) {
      setClaudeCmds([]);
      return;
    }
    if (slashQuery === null) return;
    let alive = true;
    void primeClaudeCommands(repoRoot).then((list) => {
      if (alive) setClaudeCmds(list);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, slashQuery !== null]);

  const mentionDir =
    mentionQuery === null || !repoRoot
      ? null
      : mentionQuery.includes("/")
        ? mentionQuery.slice(0, mentionQuery.lastIndexOf("/"))
        : "";

  useEffect(() => {
    if (mentionDir === null || !repoRoot) {
      setFiles([]);
      return;
    }
    let alive = true;
    const dirPath = mentionDir ? `${repoRoot}/${mentionDir}` : repoRoot;
    const cached = peekDirList(dirPath);
    if (cached) setFiles(cached);
    void loadDirList(dirPath)
      .then((entries) => {
        if (alive) setFiles(entries);
      })
      .catch(() => {
        if (alive && !cached) setFiles([]);
      });
    return () => {
      alive = false;
    };
  }, [mentionDir, repoRoot]);

  // The root listing is warmed while idle so the first `@` paints from cache.
  useEffect(() => {
    if (!repoRoot) return;
    return onIdle(() => warmDirList(repoRoot));
  }, [repoRoot]);

  useEffect(() => {
    if (!repoRoot) {
      setOpenTasks([]);
      return;
    }
    if (mentionQuery === null) return;
    let alive = true;
    void fetchTasks(repoRoot)
      .then((rows) => {
        if (alive) setOpenTasks(rows.filter((t) => !isClosedStatus(t.status)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, mentionQuery !== null]);

  const slashItems = useMemo<SlashItem[]>(() => {
    if (slashQuery === null) return [];
    if (slashRows) return slashRows(slashQuery);
    const aura: SlashItem[] = matchManagerCommands(slashQuery).map((c) => ({
      name: c.name,
      summary: c.summary,
      args: c.args,
      source: "aura",
    }));
    const taken = new Set(aura.map((a) => a.name.toLowerCase()));
    const claude: SlashItem[] = claudeCmds
      .filter((c) => (!slashQuery || c.name.toLowerCase().startsWith(slashQuery)) && !taken.has(c.name.toLowerCase()))
      .map((c) => ({ name: c.name, summary: c.summary, source: "claude", scope: c.scope }));
    for (const c of claude) taken.add(c.name.toLowerCase());
    const agent = (agentRows ?? []).filter(
      (c) => (!slashQuery || c.name.toLowerCase().startsWith(slashQuery)) && !taken.has(c.name.toLowerCase()),
    );
    return [...aura, ...claude, ...agent];
  }, [slashQuery, slashRows, claudeCmds, agentRows]);

  const mentionRows = useMemo<Row[]>(() => {
    if (mentionQuery === null) return [];
    const frag = mentionQuery.includes("/") ? "" : mentionQuery.toLowerCase();
    const rows: Row[] = [];
    if (!mentionQuery.includes("/")) {
      if ("terminal".includes(frag)) rows.push({ id: "terminal", text: "terminal", kind: "other" });
      if (frag.length >= 2 && "task".startsWith(frag)) {
        for (const t of openTasks
          .slice()
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, 7))
          rows.push({ id: `task:${t.id}`, text: `${taskRef(t)} ${t.title}`, kind: "task", task: t });
      }
    }
    for (const e of files) {
      if (HIDDEN.has(e.name)) continue;
      const path = mentionDir ? `${mentionDir}/${e.name}` : e.name;
      rows.push({ id: `file:${path}`, text: e.is_dir ? `${path}/` : path, kind: e.is_dir ? "dir" : "other" });
    }
    return rows;
  }, [mentionQuery, mentionDir, files, openTasks]);

  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (slashQuery !== null)
      return slashItems.map((c) => ({
        id: `${c.source}:${c.name}`,
        label: `/${c.name}`,
        detail: [c.args, c.summary, c.badge].filter(Boolean).join(" · ") || undefined,
        insertText: `/${c.name}`,
        kind: "command" as const,
      }));
    return mentionRows.map((r) => {
      const base = { id: r.id, label: r.text, kind: "mention" as const };
      // `@ta` has to find the task rows by their namespace, not their title.
      if (r.kind === "task")
        return { ...base, detail: "task", insertText: "", icon: createElement(ListTodo, { size: 12 }) };
      if (r.id === "terminal")
        return {
          ...base,
          detail: terminalAttaches ? "Attach current terminal output" : undefined,
          insertText: "@terminal",
          icon: createElement(Terminal, { size: 12 }),
        };
      // A file reads as its name, then the folder it sits in.
      const path = r.text.replace(/\/$/, "");
      const cut = path.lastIndexOf("/");
      const name = path.slice(cut + 1);
      return {
        ...base,
        name,
        detail: cut > 0 ? path.slice(0, cut) : undefined,
        insertText: `@${r.text}`,
        icon: createElement(FileIcon, { name, isDirectory: r.kind === "dir", size: 12 }),
      };
    });
  }, [slashQuery, slashItems, mentionRows, terminalAttaches]);

  const resolvePick = useCallback(
    (pick: ComposerSuggestion, value: string): string | null => {
      if (pick.id.startsWith("task:")) {
        const row = mentionRows.find((r) => r.id === pick.id);
        return row?.task ? buildTaskAgentPrompt(row.task) : null;
      }
      // A folder keeps its token open (no trailing space) so the list
      // descends into it on the next keystroke.
      if (pick.kind === "mention" && pick.insertText.endsWith("/")) {
        const at = value.lastIndexOf(`${pick.insertText} `);
        return at < 0 ? null : value.slice(0, at + pick.insertText.length) + value.slice(at + pick.insertText.length + 1);
      }
      return null;
    },
    [mentionRows],
  );

  return { suggestions, resolvePick };
}

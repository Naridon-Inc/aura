// mentionSources — unified @-mention catalog for the Pages editor. Loads the
// three things a page can reference (people from the team roster, tasks from
// the board, and other pages) once, then offers a single fuzzy search over
// the merged set. The editor's @ popover passes a query (and an optional kind
// filter) and renders grouped results.
//
// People → inserted as `@handle` so the Rust mentioned_handles extractor +
// auto-DM fire. Tasks → `[AURA-<n>](aura://task/<id>)`. Pages → `[[Title]]`.

import { invoke } from "@tauri-apps/api/core";
import { notesList } from "./pagesApi";

export type MentionKind = "person" | "task" | "page";

export type MentionItem = {
  kind: MentionKind;
  /** Stable id — handle for people, task id, page id. */
  id: string;
  /** Primary text shown in the popover row + chip. */
  label: string;
  /** Secondary text (name for people, title for tasks, scope for pages). */
  sublabel?: string;
  /** People only — the bare handle inserted into the markdown. */
  handle?: string;
  /** Drives the Avatar tile (name for people). */
  avatarHandle?: string;
  /** Tasks only — rendered token `AURA-<n>`. */
  taskRef?: string;
  /** Pages only — exact title for the `[[Title]]` wikilink. */
  pageTitle?: string;
};

export type MentionSources = {
  people: MentionItem[];
  tasks: MentionItem[];
  pages: MentionItem[];
};

// Minimal shapes — we only read what we render, so we don't couple this
// surface to the full shared TeamMember / Task / NoteSummary types.
type RosterMember = {
  handle?: string | null;
  name?: string | null;
  email?: string | null;
};
type RosterManifest = { members?: RosterMember[] | null };
type BoardTask = {
  id: string;
  sequence_id?: number | null;
  title?: string | null;
};

const EMPTY: MentionSources = { people: [], tasks: [], pages: [] };

/** Load people, tasks and pages for a repo. Resilient — a failing source
 *  yields an empty group rather than failing the whole load. */
export async function loadMentionSources(
  repoRoot: string,
): Promise<MentionSources> {
  if (!repoRoot) return EMPTY;
  const [people, tasks, pages] = await Promise.all([
    loadPeople(repoRoot),
    loadTasks(repoRoot),
    loadPages(repoRoot),
  ]);
  return { people, tasks, pages };
}

async function loadPeople(repoRoot: string): Promise<MentionItem[]> {
  try {
    const manifest = await invoke<RosterManifest>("team_load", { repoRoot });
    const members = manifest.members ?? [];
    return members
      .filter((m) => !!m.handle)
      .map((m) => {
        const handle = (m.handle as string).trim();
        return {
          kind: "person" as const,
          id: handle,
          label: handle,
          sublabel: m.name ?? undefined,
          handle,
          avatarHandle: m.name || handle,
        };
      });
  } catch {
    return [];
  }
}

async function loadTasks(repoRoot: string): Promise<MentionItem[]> {
  try {
    const tasks = await invoke<BoardTask[]>("tasks_list", { repoRoot });
    return tasks.map((t) => {
      const ref = `AURA-${t.sequence_id ?? 0}`;
      return {
        kind: "task" as const,
        id: t.id,
        label: ref,
        sublabel: t.title ?? undefined,
        taskRef: ref,
      };
    });
  } catch {
    return [];
  }
}

async function loadPages(repoRoot: string): Promise<MentionItem[]> {
  try {
    const summaries = await notesList({ repoRoot });
    return summaries
      .filter((s) => !s.archived_at)
      .map((s) => ({
        kind: "page" as const,
        id: s.id,
        label: s.title || "Untitled",
        sublabel: scopeLabel(s.scope),
        pageTitle: s.title || "Untitled",
      }));
  } catch {
    return [];
  }
}

function scopeLabel(scope: string): string {
  if (scope === "team") return "Team page";
  if (scope === "channel") return "Channel page";
  if (scope === "member") return "Personal page";
  return "Page";
}

function scoreItem(item: MentionItem, q: string): number {
  const label = item.label.toLowerCase();
  const sub = (item.sublabel ?? "").toLowerCase();
  const handle = (item.handle ?? "").toLowerCase();
  if (handle && handle === q) return 1000;
  if (label === q) return 900;
  if (handle.startsWith(q)) return 650;
  if (label.startsWith(q)) return 600;
  if (sub.startsWith(q)) return 500;
  if (handle.includes(q)) return 320;
  if (label.includes(q)) return 300;
  if (sub.includes(q)) return 200;
  return 0;
}

/** Fuzzy search across all (or one kind of) mention sources. Empty query
 *  returns the head of each group so the popover has something to show the
 *  instant `@` is typed. */
export function searchMentions(
  sources: MentionSources,
  query: string,
  kindFilter?: MentionKind,
  limitPerKind = 6,
): { people: MentionItem[]; tasks: MentionItem[]; pages: MentionItem[] } {
  const q = query.trim().toLowerCase();
  const pick = (items: MentionItem[]): MentionItem[] => {
    if (!q) return items.slice(0, limitPerKind);
    return items
      .map((m) => ({ m, score: scoreItem(m, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limitPerKind)
      .map((x) => x.m);
  };
  return {
    people: kindFilter && kindFilter !== "person" ? [] : pick(sources.people),
    tasks: kindFilter && kindFilter !== "task" ? [] : pick(sources.tasks),
    pages: kindFilter && kindFilter !== "page" ? [] : pick(sources.pages),
  };
}

/** Flatten the grouped search into a single ordered list (people → tasks →
 *  pages) for keyboard navigation. */
export function flattenMentionResults(grouped: {
  people: MentionItem[];
  tasks: MentionItem[];
  pages: MentionItem[];
}): MentionItem[] {
  return [...grouped.people, ...grouped.tasks, ...grouped.pages];
}

/** The exact markdown a picked mention inserts. People stay `@handle` so the
 *  backend handle extractor + auto-DM fire; tasks become an `aura://task`
 *  link; pages become a page link. */
export function mentionInsertText(item: MentionItem): string {
  if (item.kind === "person") return `@${item.handle ?? item.id} `;
  if (item.kind === "task") {
    return `[${item.taskRef ?? item.label}](aura://task/${item.id}) `;
  }
  return `[[${item.pageTitle ?? item.label}]] `;
}

// mentionSources — unified @-mention catalog for the Pages + Scribble editors.
// Loads the four things a doc can reference (people from the team roster, pull
// requests, tasks from the board, and other pages) once, then offers a single
// fuzzy search over the merged set. The editor's @ popover passes a query (and
// an optional kind filter) and renders the flattened results.
//
// People → inserted as `@handle` so the Rust mentioned_handles extractor +
// auto-DM fire. PRs → `[#<n>](aura://pr/<n>)`. Tasks →
// `[AURA-<n>](aura://task/<id>)`. Pages → `[[Title]]`.

import { invoke } from "@tauri-apps/api/core";
import { notesList } from "./pagesApi";

export type MentionKind = "person" | "pr" | "task" | "page";

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
  /** PRs only — the pull-request number for the `aura://pr/<n>` token. */
  prNumber?: number;
  /** Pages only — exact title for the `[[Title]]` wikilink. */
  pageTitle?: string;
};

export type MentionSources = {
  people: MentionItem[];
  prs: MentionItem[];
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
type PrRow = {
  number: number;
  title?: string | null;
  state?: string | null;
};

/** A fully-populated empty catalog. Callers that need a fallback value should
 *  use this rather than an inline literal, so adding a new source kind can't
 *  silently leave a call site with a missing group. */
export const EMPTY_MENTION_SOURCES: MentionSources = {
  people: [],
  prs: [],
  tasks: [],
  pages: [],
};

const EMPTY = EMPTY_MENTION_SOURCES;

// Module-level catalog cache. The @-mention catalog (people, PRs, tasks, pages)
// rarely changes within a session, yet every editor that mounts an @ popover
// would otherwise fire four fresh Tauri round-trips (team_load, pr_list,
// tasks_list, notes_list) before the first keystroke can resolve — so a user
// typing `@AURA-` right after opening sees NO tasks until that batch lands, and
// every surface remount refetches from scratch. Keeping the whole catalog on the
// module (survives React remounts), keyed by repoRoot, lets a caller paint the
// last-known catalog synchronously and revalidate in the background (SWR), the
// same contract pagesApi uses for cachedNote / cachedList.
const catalogCache = new Map<string, MentionSources>();

/** Last-known mention catalog for a repo, or undefined if never loaded this
 *  session. Seed editor state with this synchronously so the @ popover has
 *  people / PRs / tasks / pages on the very first keystroke, then revalidate via
 *  {@link loadMentionSources}. */
export function cachedMentionSources(
  repoRoot: string,
): MentionSources | undefined {
  return repoRoot ? catalogCache.get(repoRoot) : undefined;
}

/** Load people, PRs, tasks and pages for a repo. Resilient — a failing source
 *  yields an empty group rather than failing the whole load. Populates the
 *  module catalog cache on completion so the next mount is an instant hit. */
export async function loadMentionSources(
  repoRoot: string,
): Promise<MentionSources> {
  if (!repoRoot) return EMPTY;
  const [people, prs, tasks, pages] = await Promise.all([
    loadPeople(repoRoot),
    loadPrs(repoRoot),
    loadTasks(repoRoot),
    loadPages(repoRoot),
  ]);
  const prior = catalogCache.get(repoRoot);
  // Don't let a transient failure of one source (which is swallowed to an empty
  // group) wipe a group we already had — keep the last-known non-empty group so
  // a hiccup in tasks_list never blanks the task mentions until a full reload.
  const merged: MentionSources = {
    people: people.length || !prior ? people : prior.people,
    prs: prs.length || !prior ? prs : prior.prs,
    tasks: tasks.length || !prior ? tasks : prior.tasks,
    pages: pages.length || !prior ? pages : prior.pages,
  };
  catalogCache.set(repoRoot, merged);
  return merged;
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

async function loadPrs(repoRoot: string): Promise<MentionItem[]> {
  try {
    const prs = await invoke<PrRow[]>("pr_list", { repoRoot });
    // Open PRs first, then the rest — you mention live work far more often.
    const ordered = [...prs].sort((a, b) => {
      const ao = (a.state ?? "").toLowerCase() === "open" ? 0 : 1;
      const bo = (b.state ?? "").toLowerCase() === "open" ? 0 : 1;
      return ao - bo || b.number - a.number;
    });
    return ordered.map((p) => ({
      kind: "pr" as const,
      id: String(p.number),
      label: `#${p.number}`,
      sublabel: p.title ?? undefined,
      prNumber: p.number,
    }));
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
): {
  people: MentionItem[];
  prs: MentionItem[];
  tasks: MentionItem[];
  pages: MentionItem[];
} {
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
    prs: kindFilter && kindFilter !== "pr" ? [] : pick(sources.prs),
    tasks: kindFilter && kindFilter !== "task" ? [] : pick(sources.tasks),
    pages: kindFilter && kindFilter !== "page" ? [] : pick(sources.pages),
  };
}

/** Flatten the grouped search into a single ordered list (people → PRs → tasks
 *  → pages) for keyboard navigation. */
export function flattenMentionResults(grouped: {
  people: MentionItem[];
  prs: MentionItem[];
  tasks: MentionItem[];
  pages: MentionItem[];
}): MentionItem[] {
  return [...grouped.people, ...grouped.prs, ...grouped.tasks, ...grouped.pages];
}

/** The exact markdown a picked mention inserts. People stay `@handle` so the
 *  backend handle extractor + auto-DM fire; tasks become an `aura://task`
 *  link; pages become a page link. */
export function mentionInsertText(item: MentionItem): string {
  if (item.kind === "person") return `@${item.handle ?? item.id} `;
  if (item.kind === "pr") {
    return `[#${item.prNumber ?? item.id}](aura://pr/${item.prNumber ?? item.id}) `;
  }
  if (item.kind === "task") {
    return `[${item.taskRef ?? item.label}](aura://task/${item.id}) `;
  }
  return `[[${item.pageTitle ?? item.label}]] `;
}

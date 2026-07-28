// Storage for Scribble — a common markdown place to write, split into a shared
// TEAM space and a private PERSONAL space.
//
//   TEAM     → a shared Page titled "Scribble" (scope "team") in the Pages
//              store (.aura/notes). Backed by Pages rather than a raw channel
//              note ON PURPOSE: the Pages store is the surface the
//              aura_pages_list / aura_page_read / aura_page_write MCP tools
//              expose, so Aura chat and spawned agents can read AND write the
//              team scribble directly — not just humans. It's committed +
//              team-visible, so "anyone can edit and see".
//   PERSONAL → localStorage, per-repo, private to this machine (never synced).

import { api } from "../../../lib/api";

const TEAM_TITLE = "Scribble";
const TEAM_SCOPE = "team" as const;
const idKey = (repoRoot: string) => `aura.scribble.pageRef.${repoRoot}`;
const personalKey = (repoRoot: string) => `aura.scribble.personal.${repoRoot}`;

type PageRef = { id: string; bucket: string };

function readCachedRef(repoRoot: string): PageRef | null {
  try {
    const raw = localStorage.getItem(idKey(repoRoot));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.id === "string") return { id: p.id, bucket: p.bucket ?? "" };
  } catch {
    /* ignore */
  }
  return null;
}
function cacheRef(repoRoot: string, ref: PageRef): void {
  try {
    localStorage.setItem(idKey(repoRoot), JSON.stringify(ref));
  } catch {
    /* ignore */
  }
}

// Resolve (and cache) the shared "Scribble" team page, creating it on first
// use. A teammate may have created it already, so we search the roster of team
// pages by title before minting a new one — avoids duplicate "Scribble" pages.
async function resolveTeamPage(repoRoot: string): Promise<PageRef> {
  const cached = readCachedRef(repoRoot);
  if (cached) return cached;
  try {
    const list = await api.notesList({ repoRoot, scope: TEAM_SCOPE });
    const found = list.find(
      (n) => n.title.trim().toLowerCase() === TEAM_TITLE.toLowerCase(),
    );
    if (found) {
      const ref = { id: found.id, bucket: found.bucket ?? "" };
      cacheRef(repoRoot, ref);
      return ref;
    }
  } catch {
    /* fall through to create */
  }
  const note = await api.notesWrite({
    repoRoot,
    scope: TEAM_SCOPE,
    bucket: "",
    title: TEAM_TITLE,
    body: "",
  });
  const ref = { id: note.id, bucket: note.bucket ?? "" };
  cacheRef(repoRoot, ref);
  return ref;
}

export async function readTeamCanvas(repoRoot: string): Promise<string> {
  try {
    const ref = await resolveTeamPage(repoRoot);
    const note = await api.notesRead(repoRoot, TEAM_SCOPE, ref.bucket, ref.id);
    return note.body;
  } catch {
    return "";
  }
}

export async function writeTeamCanvas(repoRoot: string, body: string): Promise<void> {
  const ref = await resolveTeamPage(repoRoot);
  await api.notesWrite({
    repoRoot,
    scope: TEAM_SCOPE,
    bucket: ref.bucket,
    id: ref.id,
    title: TEAM_TITLE,
    body,
  });
}

export function readPersonalCanvas(repoRoot: string): string {
  try {
    return localStorage.getItem(personalKey(repoRoot)) ?? "";
  } catch {
    return "";
  }
}
export function writePersonalCanvas(repoRoot: string, body: string): void {
  try {
    localStorage.setItem(personalKey(repoRoot), body);
  } catch {
    /* quota / disabled — the in-memory value still holds for the session */
  }
}

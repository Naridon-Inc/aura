// Resolve a local repo root → `owner/name` (github_full_name). The
// A2A cloud filters by this slug, so the Tasks panel needs it to avoid
// pulling tasks from other workspaces.
//
// Cache per repoRoot so we don't shell `git remote` on every render.
// Tolerates: no remote, non-github remote, no .git at all — returns
// null in those cases so callers can fall back to "no filter" behavior.

import { api } from "./api";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

const SSH_RE = /git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;
const HTTPS_RE = /^https?:\/\/[^/]*github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

function parseRemote(url: string): string | null {
  const t = url.trim();
  const m1 = t.match(SSH_RE);
  if (m1) return `${m1[1]}/${m1[2]}`;
  const m2 = t.match(HTTPS_RE);
  if (m2) return `${m2[1]}/${m2[2]}`;
  return null;
}

export async function repoSlugFor(repoRoot: string): Promise<string | null> {
  if (cache.has(repoRoot)) return cache.get(repoRoot)!;
  const pending = inflight.get(repoRoot);
  if (pending) return pending;
  const p = (async () => {
    try {
      const url = await api.gitRemoteOrigin(repoRoot);
      const slug = url ? parseRemote(url) : null;
      cache.set(repoRoot, slug);
      return slug;
    } catch {
      cache.set(repoRoot, null);
      return null;
    }
  })();
  inflight.set(repoRoot, p);
  try {
    return await p;
  } finally {
    inflight.delete(repoRoot);
  }
}

/** Invalidate the cache for a repo (e.g. user reconfigured remote). */
export function invalidateRepoSlug(repoRoot: string) {
  cache.delete(repoRoot);
}

// Resolve a local repo root → the name the cloud files it under. The
// A2A cloud filters by this slug, so the Tasks panel needs it to avoid
// pulling tasks from other workspaces.
//
// The rule itself is NOT here. It lives in Rust (`repo_identity.rs`) and is
// reached through the `repo_identity_get` command. This file used to carry
// its own pair of GitHub regexes, which meant the app answered "what repo is
// this?" twice, differently — the TS half knew only github.com, so a GitLab or
// self-hosted project fell through to "no filter" and the panel pulled every
// workspace's tasks. One rule, one place, and non-GitHub hosts now resolve.
//
// Cache per repoRoot so we don't cross the IPC boundary on every render.

import { api } from "./api";
import type { RepoIdentity } from "./api";

const cache = new Map<string, RepoIdentity | null>();
const inflight = new Map<string, Promise<RepoIdentity | null>>();

async function identityFor(repoRoot: string): Promise<RepoIdentity | null> {
  if (cache.has(repoRoot)) return cache.get(repoRoot)!;
  const pending = inflight.get(repoRoot);
  if (pending) return pending;
  const p = (async () => {
    try {
      const id = await api.repoIdentity(repoRoot);
      cache.set(repoRoot, id);
      return id;
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

/**
 * The repo's hosted name (`owner/repo` on GitHub, `host/path` elsewhere), or
 * null when it has no remote. Null keeps its old meaning for callers: "no
 * cloud counterpart, so don't filter".
 */
export async function repoSlugFor(repoRoot: string): Promise<string | null> {
  const id = await identityFor(repoRoot);
  return id?.remote_slug ?? null;
}

/**
 * The name this project is filed under no matter what — the hosted name when
 * there is one, otherwise its stable `local/<name>-<id>`. Use this where a
 * project needs an identity rather than a cloud counterpart; unlike
 * `repoSlugFor` it never returns null for a remote-less project, and two
 * folders sharing a basename get two different values.
 */
export async function projectSlugFor(repoRoot: string): Promise<string | null> {
  const id = await identityFor(repoRoot);
  return id?.slug ?? null;
}

/** The org this project was explicitly bound to, or null if never chosen. */
export async function boundOrgFor(repoRoot: string): Promise<string | null> {
  const id = await identityFor(repoRoot);
  return id?.org ?? null;
}

/** Bind this project to an org (null clears it). Refreshes the cache. */
export async function bindProjectOrg(
  repoRoot: string,
  org: string | null,
): Promise<RepoIdentity> {
  const id = await api.repoIdentityBind(repoRoot, org);
  cache.set(repoRoot, id);
  return id;
}

/** Invalidate the cache for a repo (e.g. user reconfigured remote). */
export function invalidateRepoSlug(repoRoot: string) {
  cache.delete(repoRoot);
}

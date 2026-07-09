// Repo avatars — replace the generic folder glyph on a workspace tile
// with the GitHub owner's avatar. GitHub serves
// `https://github.com/<owner>.png` for both users AND orgs with no auth,
// so a repo whose `origin` points at GitHub gets a real face/logo instead
// of a folder.
//
// Resolving the owner means shelling out to `git remote get-url origin`
// (via the `repo_github_owner` Tauri command), which we must NOT do on
// every render. So we cache the resolved owner per repo root in
// localStorage — same one-device UI-preference storage shape as
// `lib/workspaceCustomization.ts`. The cache stores the owner even when it
// is `null` (non-GitHub repo) so we don't re-shell git for a repo we've
// already learned has no GitHub remote.

import { repoGithubOwner } from "./api";

const KEY = "aura.repoAvatars";

type AvatarEntry = { owner: string | null };
type AvatarMap = Record<string, AvatarEntry>;

function read(): AvatarMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AvatarMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let cache: AvatarMap = read();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore quota */
  }
}

/** Build the avatar URL for a GitHub owner. `size=64` is plenty for the
 *  32px rail tiles at 2× DPI and keeps the request light. */
function avatarUrlForOwner(owner: string): string {
  return `https://github.com/${owner}.png?size=64`;
}

/** Synchronous, render-safe lookup for first paint. Returns the cached
 *  avatar URL, or `null` when we have no cached owner yet OR the repo is
 *  known not to be on GitHub. Never shells git — call `resolveRepoAvatar`
 *  (async) to populate/refresh the cache. */
export function cachedRepoAvatar(repoRoot: string): string | null {
  const entry = cache[repoRoot];
  if (!entry || !entry.owner) return null;
  return avatarUrlForOwner(entry.owner);
}

/** Resolve (and cache) the repo's GitHub owner, returning its avatar URL
 *  or `null` off GitHub. Best-effort: any failure caches `null` so we
 *  degrade cleanly to the folder/letter fallback and don't re-shell git
 *  on the next render. */
export async function resolveRepoAvatar(repoRoot: string): Promise<string | null> {
  // Already resolved (owner string OR a remembered `null`)? Reuse it.
  const existing = cache[repoRoot];
  if (existing) {
    return existing.owner ? avatarUrlForOwner(existing.owner) : null;
  }
  let owner: string | null = null;
  try {
    owner = await repoGithubOwner(repoRoot);
  } catch {
    owner = null;
  }
  cache = { ...cache, [repoRoot]: { owner } };
  persist();
  return owner ? avatarUrlForOwner(owner) : null;
}

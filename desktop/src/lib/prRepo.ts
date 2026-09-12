// Which GitHub repo a workspace's pull requests live in — when the checkout
// is not on this laptop.
//
// `gh` always runs HERE, with the human's own login; that is the whole point
// of a PR panel that works the same wherever the code sits. On this laptop it
// finds the repo the way it always has, by looking at the checkout it is run
// in. A workspace standing in a machine has no checkout here to look at, so
// the panel names the repo instead (`gh -R owner/repo`), and the name comes
// from the one place that knows it: the box's own `origin`.
//
// `remoteRepoFor` is the single question every PR call asks first. It answers
// `null` for a project on this laptop — "ask git in the checkout", the old
// behaviour, untouched — and a slug for a project on a machine. A machine
// whose origin cannot be read, or is not GitHub, is an error rather than a
// silent fall back to the laptop's copy: a PR list for the wrong repo looks
// exactly like the right one.

import { machineIdForRoot } from "./activeMachine";
import { gitRemoteOrigin, placeScope } from "./place/workApi";

/** One `owner/repo` segment — what GitHub allows in a login or a repo name,
 *  which is also what `cmd_prs::slug_ok` accepts on the other side. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo` out of an origin URL, or `null` when the URL is not one.
 *
 *  Every spelling git writes for a GitHub remote is read: `https://`, `ssh://`
 *  with or without a login, the `git@host:owner/repo` shorthand, with or
 *  without `.git`, with or without a trailing slash. Any host is accepted —
 *  a GitHub Enterprise remote is still `owner/repo` to `gh` — but only the
 *  first two path segments are, so a URL to a file inside the repo is not
 *  mistaken for the repo. */
export function parseOwnerRepo(url: string): string | null {
  const text = url.trim();
  if (!text) return null;
  let path: string;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+\/(.*)$/.exec(text);
  const scp = /^[^/@\s]+@[^/:\s]+:(.*)$/.exec(text);
  if (scheme) path = scheme[1] ?? "";
  else if (scp) path = scp[1] ?? "";
  else {
    // `github.com/owner/repo` — a URL somebody pasted without its scheme.
    const bare = /^[^/\s]+\.[^/\s]+\/(.*)$/.exec(text);
    if (!bare) return null;
    path = bare[1] ?? "";
  }
  const parts = path.replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/, "");
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  // A segment opening with `-` would read as a flag where `gh` takes `-R`.
  if (owner.startsWith("-") || repo.startsWith("-")) return null;
  return `${owner}/${repo}`;
}

/** What `remoteRepoFor` needs to know, handed in so the routing is testable
 *  without a machine book or a live backend. */
export type RemoteRepoDeps = {
  machineIdForRoot: (root: string) => string | null;
  gitRemoteOrigin: (repoRoot: string) => Promise<string>;
  placeScope: (repoRoot: string) => string;
};

/** Build the question over `deps`. The default instance below is the one the
 *  app uses; a test builds its own. */
export function makeRemoteRepoFor(deps: RemoteRepoDeps) {
  // Keyed by place: the same local root on two machines can point at two
  // forks, and the laptop's own checkout at a third.
  const known = new Map<string, string>();

  async function remoteRepoFor(repoRoot: string): Promise<string | null> {
    if (!deps.machineIdForRoot(repoRoot)) return null;
    const scope = deps.placeScope(repoRoot);
    const hit = known.get(scope);
    if (hit) return hit;
    const origin = await deps.gitRemoteOrigin(repoRoot);
    const slug = parseOwnerRepo(origin);
    if (!slug) {
      throw new Error(
        origin.trim()
          ? `The checkout on the machine points at ${origin.trim()}, which isn't a GitHub repo, so there are no pull requests to show for it.`
          : "The checkout on the machine has no origin, so there is no GitHub repo to show pull requests for.",
      );
    }
    known.set(scope, slug);
    return slug;
  }

  /** Forget a resolved slug — after the origin is changed, or all of them. */
  function forgetRemoteRepo(repoRoot?: string): void {
    if (repoRoot === undefined) known.clear();
    else known.delete(deps.placeScope(repoRoot));
  }

  return { remoteRepoFor, forgetRemoteRepo };
}

const live = makeRemoteRepoFor({ machineIdForRoot, gitRemoteOrigin, placeScope });

/** The `owner/repo` to hand `gh -R` for this workspace, or `null` when the
 *  checkout is on this laptop and `gh` can find the repo itself. Throws when
 *  the workspace is on a machine whose origin gives no repo to name. */
export const remoteRepoFor = live.remoteRepoFor;

export const forgetRemoteRepo = live.forgetRemoteRepo;

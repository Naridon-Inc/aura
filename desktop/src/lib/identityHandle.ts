// Who "me" is, in one repo.
//
// The Tasks surfaces speak in `@me`: the rail counts a "My tasks" bucket, the
// board's assignee filter offers it, and a new task defaults its assignee to
// whoever is typing. All three take that answer as a `currentHandle` prop —
// and nothing above them ever passed one. So `@me` resolved to nothing: the
// rail's My-tasks row was never rendered at all (it is conditional on the
// prop), the board's filter searched for a literal "@me" assignee that no task
// carries, and Create landed with the assignee blank.
//
// The answer already existed one module over: `identity_status` classifies the
// local git user against the repo's roster and returns `effective_handle` —
// the same handle the Team surface, the roster and the task files use. This
// resolves it, once per repo, and hands it to the surfaces that were asking.
//
// Cached per root because three components mount against the same repo and the
// verdict is a git-config read plus a roster scan; an in-flight promise is
// shared so a simultaneous mount makes one call, not three.

import { useEffect, useState } from "react";

import { identityStatus } from "./identityApi";

const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** The handle `@me` means in this repo, or "" when it can't be worked out —
 *  no repo open, an unreadable one, or a git user with no seat on the roster.
 *  Never throws: a surface that can't name you should show everyone's work,
 *  not an error. */
export function effectiveHandleFor(repoRoot: string): Promise<string> {
  if (!repoRoot) return Promise.resolve("");
  const hit = resolved.get(repoRoot);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(repoRoot);
  if (pending) return pending;

  const p = identityStatus(repoRoot)
    .then((s) => s.effective_handle?.trim() || "")
    .catch(() => "")
    .then((handle) => {
      resolved.set(repoRoot, handle);
      inflight.delete(repoRoot);
      return handle;
    });
  inflight.set(repoRoot, p);
  return p;
}

/** Forget a repo's verdict — after the user claims a seat or pins an override,
 *  so the next read reflects the choice they just made rather than the cache. */
export function forgetEffectiveHandle(repoRoot?: string): void {
  if (repoRoot) {
    resolved.delete(repoRoot);
    inflight.delete(repoRoot);
    return;
  }
  resolved.clear();
  inflight.clear();
}

/** The handle `@me` means here, as a hook. `undefined` while it is being
 *  worked out, so a caller can tell "not yet" from "not you" — the rail hides
 *  its My-tasks row on the second, and must not flash it on the first. */
export function useEffectiveHandle(repoRoot: string): string | undefined {
  const [handle, setHandle] = useState<string | undefined>(() =>
    repoRoot ? resolved.get(repoRoot) : "",
  );
  useEffect(() => {
    let live = true;
    // A repo already resolved answers synchronously above; re-running here
    // keeps the value honest when the root changes under a mounted component.
    void effectiveHandleFor(repoRoot).then((h) => {
      if (live) setHandle(h);
    });
    return () => {
      live = false;
    };
  }, [repoRoot]);
  return handle;
}

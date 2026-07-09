// Polls git branch + diff stats for a repo root, throttled by document
// visibility. Both probes are cheap (~5ms each on warm disk) but we
// don't need them more often than the user's eye can register, so 5s
// is fine. Returns null fields while loading or on error so the caller
// can render a clean fallback instead of stale data.

import { useEffect, useState } from "react";
import { api, type DiffStats } from "./api";
import { useDocumentVisibility } from "./useDocumentVisibility";

const POLL_MS = 5000;

export type RepoMeta = {
  branch: string | null;
  diff: DiffStats | null;
};

export function useRepoMeta(repoRoot: string | null | undefined): RepoMeta {
  const [meta, setMeta] = useState<RepoMeta>({ branch: null, diff: null });
  const visible = useDocumentVisibility();

  useEffect(() => {
    if (!repoRoot) {
      setMeta({ branch: null, diff: null });
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const [branch, diff] = await Promise.all([
          api.gitBranch(repoRoot!).catch(() => null),
          api.gitDiffStats(repoRoot!).catch(() => null),
        ]);
        if (!cancelled) setMeta({ branch, diff });
      } catch {
        if (!cancelled) setMeta({ branch: null, diff: null });
      }
    }
    void tick();
    if (!visible) return;
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible]);

  return meta;
}

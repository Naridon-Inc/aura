import { useEffect, useState } from "react";
import { gitBranch } from "../../lib/place/workApi";
import { useDocumentVisibility } from "../../lib/useDocumentVisibility";

/** The branch checked out at `repoRoot`, kept current.
 *
 *  Commits and checkouts made in the app refresh it at once through
 *  `aura:git-changed`; a slow poll catches checkouts made outside it (a
 *  terminal, an agent) and stops while the window is hidden. A failed read
 *  keeps the last answer — `git branch` failing for a moment (index.lock
 *  during a commit) is not the user leaving their branch. */
export function useCurrentBranch(repoRoot: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  const visible = useDocumentVisibility();
  useEffect(() => {
    if (!repoRoot) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const b = (await gitBranch(repoRoot)).trim();
        if (!cancelled) setBranch(b || null);
      } catch {
        // Keep the branch we last read.
      }
    };
    void poll();
    window.addEventListener("aura:git-changed", poll);
    const id = visible ? window.setInterval(poll, 10000) : null;
    return () => {
      cancelled = true;
      if (id !== null) window.clearInterval(id);
      window.removeEventListener("aura:git-changed", poll);
    };
  }, [repoRoot, visible]);
  return branch;
}

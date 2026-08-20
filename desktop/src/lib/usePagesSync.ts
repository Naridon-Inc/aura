// Pull teammates' page edits whether or not you're looking at Pages.
//
// Pages broadcast themselves the moment they're saved — `publish_note_upsert`
// puts the whole file on the hidden `__aura_pages_sync` channel. The other
// half, `pages_sync_poll`, is what turns that broadcast into a file on your
// disk, and it only ever ran from inside the Pages surface. So a page reached
// a teammate when they happened to open Pages, and not before: someone would
// write a note, @-mention a colleague in it, and the colleague would get the
// DM about a page that wasn't on their machine yet. "It didn't sync to
// everyone" was exactly right — it synced to whoever had that one screen open.
//
// The poll belongs to the project, not to the screen, so this hook runs it
// from App for the open project and Pages joins the same poll rather than
// starting a second one. One interval per repo root, shared by every caller:
// two pollers on one cursor file would each advance it past rows the other had
// already applied, and whichever lost the race would report "nothing changed"
// while the notes tree had in fact just moved underneath it.

import { useEffect } from "react";
import { api } from "./api";

const POLL_MS = 6000;

/** Fired after a poll that actually wrote or removed something. Detail carries
 *  the repo root so a listener scoped to another project ignores it. */
export const PAGES_SYNCED_EVENT = "aura:pages-synced";

export type PagesSyncedDetail = {
  repoRoot: string;
  appliedIds: string[];
  removedIds: string[];
};

type Poller = { refs: number; handle: number };

const pollers = new Map<string, Poller>();

async function pollOnce(repoRoot: string): Promise<void> {
  try {
    const res = await api.pagesSyncPoll(repoRoot);
    if (!res.changed) return;
    window.dispatchEvent(
      new CustomEvent<PagesSyncedDetail>(PAGES_SYNCED_EVENT, {
        detail: {
          repoRoot,
          appliedIds: res.applied_ids,
          removedIds: res.removed_ids,
        },
      }),
    );
  } catch {
    // Solo repo, signed out, or offline. The next tick tries again; a failed
    // poll is not news, and the rail's own outbox owns the sending half.
  }
}

/** Ask for teammates' page changes to keep arriving while this component is
 *  mounted. Safe to call from several places at once — they share one timer
 *  per repo root, and the last one to unmount stops it. */
export function usePagesSync(repoRoot: string | null): void {
  useEffect(() => {
    if (!repoRoot) return;
    const existing = pollers.get(repoRoot);
    if (existing) {
      existing.refs += 1;
    } else {
      // Lead with a poll rather than waiting out the first interval: opening a
      // project is the moment you most want to be up to date, and six seconds
      // of showing a page you know exists but can't see reads as broken.
      void pollOnce(repoRoot);
      pollers.set(repoRoot, {
        refs: 1,
        handle: window.setInterval(() => void pollOnce(repoRoot), POLL_MS),
      });
    }
    return () => {
      const p = pollers.get(repoRoot);
      if (!p) return;
      p.refs -= 1;
      if (p.refs > 0) return;
      window.clearInterval(p.handle);
      pollers.delete(repoRoot);
    };
  }, [repoRoot]);
}

/** Run `onChanged` whenever a poll lands new page content for this repo. */
export function useOnPagesSynced(
  repoRoot: string | null,
  onChanged: () => void,
): void {
  useEffect(() => {
    if (!repoRoot) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PagesSyncedDetail>).detail;
      if (detail?.repoRoot === repoRoot) onChanged();
    };
    window.addEventListener(PAGES_SYNCED_EVENT, handler);
    return () => window.removeEventListener(PAGES_SYNCED_EVENT, handler);
  }, [repoRoot, onChanged]);
}

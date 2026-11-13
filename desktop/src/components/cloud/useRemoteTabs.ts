// The tabs a remote workspace is showing, and the slot they belong to.
//
// This is the binding between a workspace's chrome and lib/remoteWorkspaceSnapshot,
// and it exists because the tabs used to be a plain `useState` seeded with a
// single Chat tab. That state died with the mount, and the window unmounts a
// remote workspace every time you look at something else — another box, a page,
// your own files. Walking back into a machine you had three agents open on gave
// you one Chat tab and no way to tell that anything had been lost.
//
// Two rules, and they are the whole hook:
//
//   • Which tabs you see is a question about a PLACE — (machine, project) —
//     not about this component's lifetime. So the state is looked up by slot,
//     and re-looked-up whenever the slot changes underneath it.
//   • The slot is written through on every change, not on the way out. An
//     unmount handler is the wrong place for the only copy of something: the
//     window can be closed, reloaded or crash between the last tab you opened
//     and the cleanup that was going to record it.
//
// The switch itself — save the outgoing slot, read the incoming one, and carry
// the tabs forward when a box merely learns which project it is holding — is
// `switchRemoteSlot`, in the lib module, so it is testable without React.

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import type { BoxSession } from "../../lib/api";
import type { RemotePaneDirection, RemotePaneTree } from "../../lib/remotePaneTree";
import {
  activeTab,
  closeRemoteTab,
  emptyRemoteSnapshot,
  focusRemoteTab,
  hasSessionTabs,
  loadRemoteSnapshot,
  openSessionTab,
  openFileTab,
  openDiffTab,
  paneCandidates,
  panesInView,
  refreshSessions,
  remoteSlotFor,
  remoteSlotKey,
  saveRemoteSnapshot,
  showPaneAlone,
  showPaneBeside,
  switchRemoteSlot,
  type RemoteSlot,
  type RemoteTab,
  type RemoteWorkspaceSnapshot,
} from "../../lib/remoteWorkspaceSnapshot";

export type RemoteTabs = {
  tabs: RemoteTab[];
  activeId: string;
  /** The tab in front, already resolved — null only when the strip is empty. */
  active: RemoteTab | null;
  /** Whether anything has been opened here beyond the machine's conversation. */
  hasSessions: boolean;
  /** Join a session, or refresh and focus one already open. */
  openSession: (session: BoxSession, readOnly: boolean) => void;
  /** Open a file of the project to edit, or focus it. */
  openFile: (path: string) => void;
  /** Open a scope's diff — the working tree, or one commit — on a file. */
  openDiff: (sha: string | null, path: string | null) => void;
  /** Close the view. The session keeps running on the box. */
  closeTab: (id: string) => void;
  focusTab: (id: string) => void;
  /** How the body is divided right now, or null for the one-tab body. Only
   *  non-null while the tab in front is one of its panes — see `panesInView`. */
  panes: RemotePaneTree | null;
  /** The other open tabs that could join the pane holding `beside`. Empty when
   *  the body already holds as many as a screen usefully can. */
  splitWith: (beside: string) => RemoteTab[];
  /** Show an open tab beside a pane that is already on screen. */
  showBeside: (
    beside: string,
    id: string,
    direction: RemotePaneDirection,
  ) => void;
  /** Give the body back to the tab in front. Closes nothing. */
  showAlone: () => void;
  /** Hand the box's latest read to the tabs drawn from it. */
  syncSessions: (sessions: readonly BoxSession[]) => void;
};

type Held = {
  slot: RemoteSlot | null;
  /** The slot's storage key, or "" for a workspace that has no box yet. Held
   *  beside the slot so a stale render can be recognised by string compare. */
  key: string;
  snap: RemoteWorkspaceSnapshot;
};

function readSlot(slot: RemoteSlot | null): RemoteWorkspaceSnapshot {
  return (slot ? loadRemoteSnapshot(slot) : null) ?? emptyRemoteSnapshot();
}

export function useRemoteTabs(
  machineId: string | null,
  repoRoot: string | null | undefined,
  remoteRoot?: string | null,
): RemoteTabs {
  const slot = useMemo(
    () => remoteSlotFor(machineId, repoRoot, remoteRoot),
    [machineId, repoRoot, remoteRoot],
  );
  const slotKey = slot ? remoteSlotKey(slot) : "";

  // Read straight off the incoming slot, so the render that first sees a new
  // machine already draws that machine's tabs. Without it there is one commit
  // where the new box wears the old box's strip — and the body under it would
  // dial a terminal for a session that isn't on this machine.
  //
  // Keyed on `slotKey` rather than `slot`: the slot is a fresh object whenever
  // its inputs re-derive, and re-reading storage on every render is a cost with
  // no answer to show for it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fresh = useMemo(() => readSlot(slot), [slotKey]);

  const [held, setHeld] = useState<Held>(() => ({
    slot,
    key: slotKey,
    snap: fresh,
  }));

  const snap = held.key === slotKey ? held.snap : fresh;

  // Before paint, not after: this is the commit that swaps the slot, and the
  // save-then-load in `switchRemoteSlot` is what stops a switch from being the
  // thing that loses the tabs.
  useLayoutEffect(() => {
    setHeld((cur) =>
      cur.key === slotKey
        ? cur
        : { slot, key: slotKey, snap: switchRemoteSlot(cur.slot, cur.snap, slot) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey]);

  // Write through. A workspace with no box resolved yet has nowhere to write —
  // its tabs live in memory until there is a place to file them under, which is
  // what `remoteSlotFor` returning null means.
  useEffect(() => {
    if (held.key !== slotKey || !held.slot) return;
    saveRemoteSnapshot(held.slot, held.snap);
  }, [slotKey, held]);

  const update = useCallback(
    (fn: (cur: RemoteWorkspaceSnapshot) => RemoteWorkspaceSnapshot) => {
      setHeld((cur) => {
        // An event can land in the gap between a slot changing and the layout
        // effect committing it. Run the switch rather than writing the new tab
        // into the slot the user has already left.
        const base =
          cur.key === slotKey
            ? cur.snap
            : switchRemoteSlot(cur.slot, cur.snap, slot);
        const next = fn(base);
        if (next === cur.snap && cur.key === slotKey) return cur;
        return { slot, key: slotKey, snap: next };
      });
    },
    [slot, slotKey],
  );

  const openSession = useCallback(
    (session: BoxSession, readOnly: boolean) =>
      update((cur) => openSessionTab(cur, session, readOnly)),
    [update],
  );
  const openFile = useCallback(
    (path: string) => update((cur) => openFileTab(cur, path)),
    [update],
  );
  const openDiff = useCallback(
    (sha: string | null, path: string | null) =>
      update((cur) => openDiffTab(cur, sha, path)),
    [update],
  );
  const closeTab = useCallback(
    (id: string) => update((cur) => closeRemoteTab(cur, id)),
    [update],
  );
  const focusTab = useCallback(
    (id: string) => update((cur) => focusRemoteTab(cur, id)),
    [update],
  );
  const syncSessions = useCallback(
    (sessions: readonly BoxSession[]) =>
      update((cur) => refreshSessions(cur, sessions)),
    [update],
  );
  const showBeside = useCallback(
    (beside: string, id: string, direction: RemotePaneDirection) =>
      update((cur) => showPaneBeside(cur, beside, id, direction)),
    [update],
  );
  const showAlone = useCallback(() => update(showPaneAlone), [update]);
  // A function rather than a list: each pane's own toolbar asks about itself,
  // and the candidates for the pane you opened the menu on are not the
  // candidates for whichever pane happened to hold the keyboard.
  const splitWith = useCallback(
    (beside: string) => paneCandidates(snap, beside),
    [snap],
  );

  return {
    tabs: snap.tabs,
    activeId: snap.activeId,
    active: activeTab(snap),
    hasSessions: hasSessionTabs(snap),
    openSession,
    openFile,
    openDiff,
    closeTab,
    focusTab,
    syncSessions,
    panes: panesInView(snap),
    splitWith,
    showBeside,
    showAlone,
  };
}

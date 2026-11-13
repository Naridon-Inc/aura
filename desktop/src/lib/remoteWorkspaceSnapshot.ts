// Per-place tab snapshot for a workspace on a machine that isn't this one.
//
// The remote twin of lib/workspaceSnapshot, and deliberately the same shape of
// answer: one persisted blob per place, written as the tabs change and read
// back on the way in, so leaving a box and coming back lands you on what you
// left instead of a fresh Chat tab.
//
// It has to exist separately because the *place* is not the same kind of thing.
// A local place is a checkout, and its slot is keyed by the root. A remote place
// is a box AND a project — `remotePlaceKey`'s rule, the one the window already
// files these under: the same machine holding two projects is two places you can
// stand in, and their tabs must not pour into one slot. So the key here is
// (machineId, repoRoot), spelled by `remotePlaceKey` rather than by a second
// hand-rolled join, because two spellings of one identity is how `/a/b` and
// `/a/b/` become two boxes.
//
// Its own key prefix, not workspaceSnapshot's: the blob inside is a list of
// remote tabs, and `snapshotSlotKeys` sweeps every key under the local prefix
// and parses each one as a `WorkspaceSnapshot`. Sharing the prefix would hand
// that sweep a blob it would read as a workspace with no tabs at all.
//
// Honest about what's NOT persisted here:
//   • The tmux session itself. It lives on the box and outlives every window
//     that ever attached to it — that is the whole point of putting work there.
//     What we store is which sessions you had *open a view of*.
//   • Whether those sessions still exist. A box read is the only honest source
//     (see useBox), so a restored tab carries the session as it was last seen
//     and `refreshSessions` corrects it the moment the box answers.
//   • The live PTY. `Terminal` keeps its own session cache keyed by
//     machine + tab id, so a restored tab re-attaches rather than dialling a
//     second client into the same pane.
//
// Schema is versioned via `v`. An unreadable blob is treated as no snapshot, so
// a tab list comes back empty rather than corrupt — but a blob from an OLDER
// schema we still understand is migrated instead of dropped, because the only
// copy of "you had three agents open on that box" is not worth throwing away
// over a field it predates.

import type { BoxSession } from "./api";
import { setDurable } from "./localStore";
import { carryForward, knownIdsOf } from "./machineRef";
import {
  addPaneBeside,
  parsePaneTree,
  prunePanes,
  paneCount,
  paneHolds,
  paneLeaf,
  paneTabIds,
  MAX_REMOTE_PANES,
  type RemotePaneDirection,
  type RemotePaneTree,
} from "./remotePaneTree";
import { normalizeRoot, remotePlaceKey } from "./remotePlaces";

/** 2 added `layout` — which of the open tabs are on screen together. v1 blobs
 *  are read and carried forward with no layout, which is exactly what they
 *  meant. */
const SCHEMA_VERSION = 2;

/** Schemas whose blobs can still be read. */
const READABLE_VERSIONS: readonly number[] = [1, 2];

/** A tab is the conversation about this machine, a session the machine
 *  itself is holding, or a file or diff the frame's right panel opened.
 *
 *  Terminal tabs used to be invented by the workspace — a local id, a locally
 *  chosen tmux name, and one saved directory for all of them. That made every
 *  session invisible to everything except the window that opened it, and made a
 *  box a single-project machine. Now the box names its own sessions and a tab
 *  only ever attaches to one, which is what lets the CLI, yesterday's laptop and
 *  a teammate all show up in the same list. */
export type RemoteTab =
  | { id: "cloud"; kind: "cloud"; label: string }
  | {
      /** `fileTabId(path)`. */
      id: string;
      kind: "file";
      /** Local-spelled absolute path under the project; the wire re-roots it
       *  onto the machine. Opened from the right panel's All files or Changes. */
      path: string;
    }
  | {
      /** `diffTabId(sha)`. One per scope, the way the workspace names its
       *  diff tab after what it compares: "Uncommitted changes", or one
       *  commit. Opening another file of the same scope re-points it. */
      id: string;
      kind: "diff";
      /** The commit, or null for the working tree against HEAD. */
      sha: string | null;
      /** The file in view, relative to the project; null shows the scope's
       *  summary. */
      path: string | null;
    }
  | {
      id: string;
      kind: "session";
      session: BoxSession;
      /** Watching rather than driving. tmux hands every client the same pane,
       *  so joining a session someone else is working in means sharing their
       *  keyboard — a read-only client can see everything and type nothing.
       *  It is its own tab id (`watch:…`) rather than a flag on the same one,
       *  because switching between the two has to re-dial: a terminal already
       *  attached read-only cannot be talked into accepting input. */
      readOnly: boolean;
    };

/** The tab id for a file opened to edit. */
export function fileTabId(path: string): string {
  return `file:${path}`;
}

/** The tab id for a diff scope — the working tree, or one commit. */
export function diffTabId(sha: string | null): string {
  return sha ? `diff:${sha}` : "diff:uncommitted";
}

/** What a diff tab is called: the scope it compares. */
export function diffTabLabel(sha: string | null): string {
  return sha ? `Commit ${sha.slice(0, 7)}` : "Uncommitted changes";
}

/** The tab id for a session, given how you're joining it. */
export function tabIdFor(session: string, readOnly: boolean): string {
  return readOnly ? `watch:${session}` : session;
}

/** The conversation about the machine. Not a tab you opened — it is the machine
 *  seen from the board's side, so it is in every slot and cannot be closed. */
export const CHAT_TAB_ID = "cloud";

function chatTab(): RemoteTab {
  return { id: CHAT_TAB_ID, kind: "cloud", label: "Chat" };
}

export type RemoteWorkspaceSnapshot = {
  v: number;
  tabs: RemoteTab[];
  /** Which tab is in front. Always names one of `tabs`, and when a layout is in
   *  view it is also which PANE holds the keyboard. */
  activeId: string;
  /** Which open tabs are shown together, and how they divide the body. Null —
   *  the usual case — means the body is whatever tab is in front.
   *
   *  A view of the strip, never a second place a tab can live: every leaf is a
   *  tab id that is also in `tabs`, so closing a tab removes the pane and there
   *  is no way to be in a pane and off the strip. */
  layout: RemotePaneTree | null;
};

/** A place you have opened but not yet done anything in: the machine's own
 *  conversation, and nothing else. */
export function emptyRemoteSnapshot(): RemoteWorkspaceSnapshot {
  return { v: SCHEMA_VERSION, tabs: [chatTab()], activeId: CHAT_TAB_ID, layout: null };
}

// ---------------------------------------------------------------------------
// The slot
// ---------------------------------------------------------------------------

/** Which box, and which project on it. Both halves, because one box is a copy
 *  of several projects and each of them is somewhere you can stand. A third
 *  when the place works in a worktree on the box other than the machine's own
 *  checkout: two worktrees of one project are two places, with two strips. */
export type RemoteSlot = { machineId: string; repoRoot: string; remoteRoot?: string };

/** The slot a workspace is standing in, or null when it hasn't resolved a box.
 *
 *  Null rather than a wildcard on purpose: an entry that names no machine yet
 *  (opened from a cloud conversation, or from the fleet page before the book is
 *  read) would otherwise be handed a slot that *every* unresolved entry shares,
 *  and the first box to resolve would inherit another box's tabs. No machine,
 *  no slot, nothing written — the tabs live in memory until there is a place to
 *  file them under.
 *
 *  A project the box hasn't named is a real slot, though: `machine\0id\0` is
 *  where "this box, no project known" belongs, and `switchRemoteSlot` carries
 *  it forward when the project turns up. */
export function remoteSlotFor(
  machineId: string | null | undefined,
  repoRoot: string | null | undefined,
  remoteRoot?: string | null,
): RemoteSlot | null {
  const id = machineId?.trim() ?? "";
  if (!id) return null;
  const there = normalizeRoot(remoteRoot);
  return there
    ? { machineId: id, repoRoot: normalizeRoot(repoRoot), remoteRoot: there }
    : { machineId: id, repoRoot: normalizeRoot(repoRoot) };
}

const SLOT_KEY_PREFIX = "aura.remoteWorkspaceSnapshot.";

/** Where this place's tabs are filed. `remotePlaceKey` spells the identity —
 *  the same string the window keys the entered-places set by — and this only
 *  prefixes it. */
export function remoteSlotKey(slot: RemoteSlot): string {
  return `${SLOT_KEY_PREFIX}${remotePlaceKey({
    machineId: slot.machineId,
    repoRoot: slot.repoRoot,
    remoteRoot: slot.remoteRoot,
  })}`;
}

export function sameRemoteSlot(
  a: RemoteSlot | null,
  b: RemoteSlot | null,
): boolean {
  if (!a || !b) return a === b;
  return remoteSlotKey(a) === remoteSlotKey(b);
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

/** Put a blob off disk back into a shape the strip can draw.
 *
 *  A slot always has its Chat tab and always has an `activeId` naming a tab that
 *  is really there — neither is recoverable from a half-written blob, and a
 *  strip with no conversation on it (or one focused on a tab that isn't in the
 *  list) is a worse outcome than a slot that reads as fresh. */
function rehydrate(parsed: RemoteWorkspaceSnapshot): RemoteWorkspaceSnapshot {
  const tabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
  const seenIds = new Set<string>();
  const opened = tabs.flatMap((t): RemoteTab[] => {
    if (t?.kind === "session") {
      return !!t.session?.name && typeof t.id === "string" ? [t] : [];
    }
    if (t?.kind === "file" && typeof t.path === "string" && t.path) {
      const id = fileTabId(t.path);
      if (seenIds.has(id)) return [];
      seenIds.add(id);
      return [{ id, kind: "file", path: t.path }];
    }
    if (t?.kind === "diff") {
      const sha = typeof t.sha === "string" && /^[0-9a-f]{7,64}$/.test(t.sha) ? t.sha : null;
      const id = diffTabId(sha);
      if (seenIds.has(id)) return [];
      seenIds.add(id);
      return [{ id, kind: "diff", sha, path: typeof t.path === "string" ? t.path : null }];
    }
    // Anything else — the files/changes/git/PRs/run tabs older builds opened,
    // whose work the frame's right panel and header now do — is dropped.
    return [];
  });
  const out = [chatTab(), ...opened];
  const activeId = out.some((t) => t.id === parsed.activeId)
    ? parsed.activeId
    : CHAT_TAB_ID;
  // The arrangement is checked against the tabs that survived rather than
  // trusted: a pane naming a tab this slot no longer has would be a terminal
  // with nothing behind it. A v1 blob has no `layout` at all and `parsePaneTree`
  // says so by returning null — which is what v1 meant.
  const ids = new Set(out.map((t) => t.id));
  const layout = parsePaneTree(parsed.layout, (id) => ids.has(id));
  return { v: SCHEMA_VERSION, tabs: out, activeId, layout };
}

export function loadRemoteSnapshot(
  slot: RemoteSlot,
): RemoteWorkspaceSnapshot | null {
  try {
    // A strip saved under an id this machine had before — the address key it
    // was renamed from, or the id it was reconnected as — is this machine's
    // strip, and is moved to the id it goes by now as it is read.
    const raw = carryForward(
      localStorage,
      (machineId) => remoteSlotKey({ ...slot, machineId }),
      knownIdsOf(slot.machineId),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemoteWorkspaceSnapshot;
    // Older-but-readable is migrated, not discarded. Dropping a v1 blob would
    // empty the strip of everyone who had tabs open on a box the day they
    // updated, to save reading one field we already treat as optional.
    if (!READABLE_VERSIONS.includes(parsed?.v)) return null;
    return rehydrate(parsed);
  } catch {
    return null;
  }
}

export function saveRemoteSnapshot(
  slot: RemoteSlot,
  snap: RemoteWorkspaceSnapshot,
): void {
  // Durable, not best-effort, for the same reason the local slot is: this blob
  // is the only record that you had three agents open on that box, and a quota
  // failure here is exactly the switch-away-and-come-back-to-an-empty-strip bug
  // it exists to prevent. `setDurable` evicts regenerable caches to make room.
  setDurable(remoteSlotKey(slot), JSON.stringify(snap));
}

export function removeRemoteSnapshot(slot: RemoteSlot): void {
  try {
    localStorage.removeItem(remoteSlotKey(slot));
  } catch {
    /* storage unavailable — nothing to drop */
  }
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

/** The same box, finally naming the project you were already working in.
 *
 *  This is not a switch and must not be treated as one. Entering a machine from
 *  the fleet page names no project; the box then reports the one it is a copy
 *  of, or gets filed under the project you came from, and `repoRoot` goes from
 *  nothing to something a beat after the workspace is already open. Swapping
 *  slots on that transition would empty the strip in front of someone who had
 *  just attached a session — the tabs were opened on this box and the project
 *  merely became known. */
export function learnedItsProject(
  from: RemoteSlot | null,
  to: RemoteSlot | null,
): boolean {
  if (!from || !to) return false;
  return (
    from.machineId === to.machineId &&
    (from.remoteRoot ?? "") === (to.remoteRoot ?? "") &&
    !from.repoRoot &&
    !!to.repoRoot
  );
}

/** Fold the tabs you are standing on into the ones the target slot already
 *  holds. Held tabs keep their order and their records; anything open here that
 *  the slot has never seen is appended. Focus stays on the tab that is on
 *  screen — a switch that is not a switch must not move what you are looking
 *  at. */
function carryInto(
  held: RemoteWorkspaceSnapshot,
  current: RemoteWorkspaceSnapshot,
): RemoteWorkspaceSnapshot {
  const seen = new Set(held.tabs.map((t) => t.id));
  const tabs = [...held.tabs, ...current.tabs.filter((t) => !seen.has(t.id))];
  const activeId = tabs.some((t) => t.id === current.activeId)
    ? current.activeId
    : held.activeId;
  // The slot's own arrangement wins. Tabs opened while the box was still
  // nameless are carried in as tabs, not as panes: how the body was divided is
  // a thing about this place, and the place is the one we are folding into.
  return { v: SCHEMA_VERSION, tabs, activeId, layout: held.layout };
}

/** Serialize the slot you are leaving, then read the one you are entering back.
 *
 *  The same two-step the local surface does on a workspace switch, and the whole
 *  reason a machine's layout survives: the outgoing tabs are on disk before the
 *  incoming ones are read, so a switch can never be the thing that loses them.
 *
 *  Returns what the workspace should now be showing. */
export function switchRemoteSlot(
  from: RemoteSlot | null,
  outgoing: RemoteWorkspaceSnapshot,
  to: RemoteSlot | null,
): RemoteWorkspaceSnapshot {
  if (sameRemoteSlot(from, to)) return outgoing;

  if (learnedItsProject(from, to) && to) {
    // The project's own slot wins where it exists — you have worked in it
    // before and those tabs are the layout you are owed — and what you opened
    // while the box was still nameless is folded in rather than dropped.
    const held = loadRemoteSnapshot(to);
    const next = held ? carryInto(held, outgoing) : outgoing;
    saveRemoteSnapshot(to, next);
    // The nameless slot is emptied, not left behind: leaving it would hand
    // these same tabs to the next entry that arrives without a project, and one
    // list of tabs filed in two places comes back doubled.
    if (from) removeRemoteSnapshot(from);
    return next;
  }

  if (from) saveRemoteSnapshot(from, outgoing);
  if (!to) return emptyRemoteSnapshot();
  return loadRemoteSnapshot(to) ?? emptyRemoteSnapshot();
}

// ---------------------------------------------------------------------------
// What you can do to a strip
// ---------------------------------------------------------------------------

/** The tab in front. Falls back to the first, so a slot always draws something
 *  as long as it has a Chat tab — which `rehydrate` guarantees. */
export function activeTab(snap: RemoteWorkspaceSnapshot): RemoteTab | null {
  return snap.tabs.find((t) => t.id === snap.activeId) ?? snap.tabs[0] ?? null;
}

/** Join a session, and look at it.
 *
 *  Opening one you already have open is a focus plus a refresh, never a second
 *  view of the same pane — tmux would happily give us that, and the two clients
 *  would then fight each other for the keyboard. */
export function openSessionTab(
  snap: RemoteWorkspaceSnapshot,
  session: BoxSession,
  readOnly: boolean,
): RemoteWorkspaceSnapshot {
  const id = tabIdFor(session.name, readOnly);
  const open = snap.tabs.some((t) => t.id === id);
  const tabs = open
    ? snap.tabs.map((t) =>
        t.id === id && t.kind === "session" ? { ...t, session } : t,
      )
    : [...snap.tabs, { id, kind: "session" as const, session, readOnly }];
  return { ...snap, v: SCHEMA_VERSION, tabs, activeId: id };
}

/** Open a file to edit, and look at it. Already open is a focus. */
export function openFileTab(
  snap: RemoteWorkspaceSnapshot,
  path: string,
): RemoteWorkspaceSnapshot {
  const id = fileTabId(path);
  if (snap.tabs.some((t) => t.id === id)) return focusRemoteTab(snap, id);
  return {
    ...snap,
    v: SCHEMA_VERSION,
    tabs: [...snap.tabs, { id, kind: "file", path }],
    activeId: id,
  };
}

/** Open a scope's diff tab on `path`, and look at it. The scope's tab is
 *  re-pointed when it is already open, so a run of clicks down the Changes
 *  list reads in one tab rather than leaving a trail of them. */
export function openDiffTab(
  snap: RemoteWorkspaceSnapshot,
  sha: string | null,
  path: string | null,
): RemoteWorkspaceSnapshot {
  const id = diffTabId(sha);
  const tab: RemoteTab = { id, kind: "diff", sha, path };
  const open = snap.tabs.some((t) => t.id === id);
  return {
    ...snap,
    v: SCHEMA_VERSION,
    tabs: open ? snap.tabs.map((t) => (t.id === id ? tab : t)) : [...snap.tabs, tab],
    activeId: id,
  };
}

/** Close a *view*. The session keeps running on the box — that is the entire
 *  reason for putting work there, and a close button that quietly killed an
 *  agent mid-edit would be the worst button in the app. Ending it for real lives
 *  in the panel, where it says "Stop" and asks twice.
 *
 *  The conversation is the board's record and closing it here would imply
 *  otherwise, so it is not closable. */
export function closeRemoteTab(
  snap: RemoteWorkspaceSnapshot,
  id: string,
): RemoteWorkspaceSnapshot {
  if (id === CHAT_TAB_ID) return snap;
  const tabs = snap.tabs.filter((t) => t.id !== id);
  if (tabs.length === snap.tabs.length) return snap;
  // A pane of a closed tab is a pane with nothing behind it, so the
  // arrangement loses it here rather than on the next read. Closing one half of
  // a split leaves the other half as the body, which is what one pane means.
  const layout = snap.layout ? prunePanes(snap.layout, (t) => t !== id) : null;
  const nextLayout = layout && paneCount(layout) > 1 ? layout : null;
  // Focus follows the split before it follows the strip: closing a pane of an
  // arrangement you are working in should land you in the pane beside it, not
  // on whatever tab happens to be last in the list.
  const neighbour = nextLayout ? paneTabIds(nextLayout)[0] : null;
  const activeId =
    snap.activeId === id
      ? (neighbour ?? tabs[tabs.length - 1]?.id ?? CHAT_TAB_ID)
      : snap.activeId;
  return { v: SCHEMA_VERSION, tabs, activeId, layout: nextLayout };
}

/** The arrangement the body should draw right now, or null for the plain
 *  one-tab body.
 *
 *  A layout is only in view while you are standing in it. Focusing a tab that
 *  is not one of its panes shows that tab alone and LEAVES the arrangement
 *  recorded, so clicking back into any of its panes restores it — the same way
 *  a window you minimised is still arranged. Flattening it on every excursion
 *  would mean looking at the file tree costs you the split you just built. */
export function panesInView(
  snap: RemoteWorkspaceSnapshot,
): RemotePaneTree | null {
  if (!snap.layout) return null;
  return paneHolds(snap.layout, snap.activeId) ? snap.layout : null;
}

/** Put another open tab beside one that is on screen.
 *
 *  This is what "split" means on a machine that isn't yours. Locally, splitting
 *  makes a second terminal, because a shell is free. A session on a box is a
 *  thing someone started on purpose and it already has a tab, so splitting here
 *  cannot mean "make me another one" — ＋ does that, deliberately, with a
 *  project and an agent to choose. It means: show me these two at once.
 *
 *  `beside` is the pane doing the asking, named rather than taken from
 *  `activeId`: every pane of a split carries its own toolbar, and the one you
 *  opened the menu on is the one the new pane belongs next to.
 *
 *  Unchanged — the same object back — when there is nothing to do: an unknown
 *  tab, the tab it would sit beside, a tab already on screen, or a body that is
 *  already as divided as a laptop screen can usefully hold. */
export function showPaneBeside(
  snap: RemoteWorkspaceSnapshot,
  beside: string,
  tabId: string,
  direction: RemotePaneDirection,
): RemoteWorkspaceSnapshot {
  if (tabId === beside) return snap;
  if (!snap.tabs.some((t) => t.id === tabId)) return snap;
  const shown = panesInView(snap);
  const base = shown && paneHolds(shown, beside) ? shown : paneLeaf(beside);
  if (paneHolds(base, tabId)) return snap;
  if (paneCount(base) >= MAX_REMOTE_PANES) return snap;
  const layout = addPaneBeside(base, beside, tabId, direction);
  if (layout === base) return snap;
  // Focus moves to what you just asked for. Asking to see a build log beside
  // an agent and then having to click the log is a step with no decision in it.
  return { ...snap, v: SCHEMA_VERSION, layout, activeId: tabId };
}

/** Give the body back to the tab in front, dropping the arrangement.
 *
 *  Not a close: every pane of it is a tab on the strip and stays there, which
 *  is the whole reason the layout is allowed to be a view. */
export function showPaneAlone(
  snap: RemoteWorkspaceSnapshot,
): RemoteWorkspaceSnapshot {
  if (!snap.layout) return snap;
  return { ...snap, v: SCHEMA_VERSION, layout: null };
}

/** Which other open tabs could be put beside `beside` — the split menu's rows,
 *  in strip order. Panes already on screen are left out because they are
 *  already there, and the answer is empty when the body is as divided as it can
 *  be, so a full split says "no room" by having nothing to offer rather than by
 *  silently doing nothing. */
export function paneCandidates(
  snap: RemoteWorkspaceSnapshot,
  beside: string,
): RemoteTab[] {
  const shown = panesInView(snap);
  if (shown && paneCount(shown) >= MAX_REMOTE_PANES) return [];
  return snap.tabs.filter(
    (t) => t.id !== beside && !(shown && paneHolds(shown, t.id)),
  );
}

/** Look at a tab you already have open. Unknown ids change nothing. */
export function focusRemoteTab(
  snap: RemoteWorkspaceSnapshot,
  id: string,
): RemoteWorkspaceSnapshot {
  if (snap.activeId === id || !snap.tabs.some((t) => t.id === id)) return snap;
  return { ...snap, activeId: id };
}

/** What the strip actually says about a session: the words on the tab, the icon,
 *  and whether someone else is in there with you. Compared field by field rather
 *  than by identity because the box is re-read every few seconds and hands back
 *  a fresh object every time — treating each poll as a change would rewrite the
 *  slot on a timer for a strip that looks identical. */
function sameOnScreen(a: BoxSession, b: BoxSession): boolean {
  return (
    a.name === b.name &&
    a.title === b.title &&
    a.project === b.project &&
    a.agent === b.agent &&
    a.attached === b.attached
  );
}

/** Put the box's own answer back onto the tabs drawn from it.
 *
 *  A restored tab carries the session as it was last seen — its title, the
 *  directory it works in, how many people were attached. Those are facts about
 *  a machine this laptop has not spoken to since, and the strip states them as
 *  if they were current: an agent that finished overnight still reads as
 *  someone else's keyboard. Sessions the read doesn't mention are left alone
 *  rather than dropped, because a tab is a view you opened and closing it is
 *  yours to do. */
export function refreshSessions(
  snap: RemoteWorkspaceSnapshot,
  sessions: readonly BoxSession[],
): RemoteWorkspaceSnapshot {
  const live = new Map(sessions.map((s) => [s.name, s]));
  let changed = false;
  const tabs = snap.tabs.map((t) => {
    if (t.kind !== "session") return t;
    const fresh = live.get(t.session.name);
    if (!fresh || sameOnScreen(fresh, t.session)) return t;
    changed = true;
    return { ...t, session: fresh };
  });
  return changed ? { ...snap, tabs } : snap;
}

/** Has anything been opened here, or is it still just the machine's own
 *  conversation? What the first-look-in greeting turns on: a place you have
 *  tabs in is a place you are already standing in, and attaching another
 *  session on arrival would yank you off the one you left. */
export function hasSessionTabs(snap: RemoteWorkspaceSnapshot): boolean {
  return snap.tabs.some((t) => t.kind === "session");
}

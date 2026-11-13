// The tabs of a remote workspace — sessions, and the files and diffs the
// frame's right panel opens — the slot they are filed under when the place is
// a worktree on the box, and the arrangement that shows two of them at once.

import { describe, expect, test } from "bun:test";

import type { BoxSession } from "./api";
import { MAX_REMOTE_PANES, paneCount, paneTabIds } from "./remotePaneTree";
import {
  CHAT_TAB_ID,
  closeRemoteTab,
  diffTabId,
  diffTabLabel,
  emptyRemoteSnapshot,
  fileTabId,
  focusRemoteTab,
  learnedItsProject,
  loadRemoteSnapshot,
  openDiffTab,
  openFileTab,
  openSessionTab,
  paneCandidates,
  panesInView,
  remoteSlotFor,
  remoteSlotKey,
  showPaneAlone,
  showPaneBeside,
  tabIdFor,
} from "./remoteWorkspaceSnapshot";

const BOX = "ubuntu@203.0.113.42";
const HERE = "/Users/me/app";
const THERE = "/home/ubuntu/app-feat-x";

const session: BoxSession = {
  name: "files",
  title: "claude",
  project: THERE,
  agent: "claude",
  attached: 1,
} as unknown as BoxSession;

describe("tabs the frame opens", () => {
  test("a file opens once; opening it again only looks at it", () => {
    const a = openFileTab(emptyRemoteSnapshot(), `${HERE}/src/a.ts`);
    const b = openFileTab(focusRemoteTab(a, CHAT_TAB_ID), `${HERE}/src/a.ts`);
    expect(b.tabs.filter((t) => t.kind === "file")).toHaveLength(1);
    expect(b.activeId).toBe(fileTabId(`${HERE}/src/a.ts`));
  });

  test("a commit's diff is named by its short hash and re-pointed, not doubled", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const a = openDiffTab(emptyRemoteSnapshot(), sha, "src/a.ts");
    const b = openDiffTab(a, sha, "src/b.ts");
    const diffs = b.tabs.filter((t) => t.kind === "diff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ id: diffTabId(sha), path: "src/b.ts" });
    expect(diffTabLabel(sha)).toBe("Commit 0123456");
    expect(diffTabLabel(null)).toBe("Uncommitted changes");
  });

  test("the working tree's diff and a commit's are two tabs", () => {
    const sha = "89abcdef0123456789abcdef0123456789abcdef";
    const snap = openDiffTab(openDiffTab(emptyRemoteSnapshot(), null, "a"), sha, "a");
    expect(snap.tabs.filter((t) => t.kind === "diff").map((t) => t.id)).toEqual([
      diffTabId(null),
      diffTabId(sha),
    ]);
  });
});

describe("the slot a worktree is filed under", () => {
  test("a worktree on the box is its own slot", () => {
    const main = remoteSlotFor(BOX, HERE)!;
    const feat = remoteSlotFor(BOX, HERE, `${THERE}/`)!;
    expect(feat.remoteRoot).toBe(THERE);
    expect(remoteSlotKey(feat)).not.toBe(remoteSlotKey(main));
    // A blank worktree is the main checkout, with the key it always had.
    expect(remoteSlotKey(remoteSlotFor(BOX, HERE, " ")!)).toBe(remoteSlotKey(main));
  });

  test("learning the project is only that when the worktree is the same", () => {
    expect(learnedItsProject(remoteSlotFor(BOX, null), remoteSlotFor(BOX, HERE))).toBe(true);
    expect(
      learnedItsProject(remoteSlotFor(BOX, null), remoteSlotFor(BOX, HERE, THERE)),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Showing two tabs at once
// ---------------------------------------------------------------------------

/** A session tab for a name on the box, joined with the keyboard. */
const named = (name: string) => ({ ...session, name }) as BoxSession;
const id = (name: string) => tabIdFor(name, false);

/** A strip with three sessions joined, the last one in front. */
function joined(...names: string[]) {
  let snap = emptyRemoteSnapshot();
  for (const n of names) snap = openSessionTab(snap, named(n), false);
  return snap;
}

describe("showing two tabs at once", () => {
  test("it divides the body and moves the keyboard to what you asked for", () => {
    let snap = joined("agent", "build");
    snap = showPaneBeside(snap, id("agent"), id("build"), "row");
    expect(paneTabIds(panesInView(snap)!)).toEqual([id("agent"), id("build")]);
    // Asking to see the build log beside the agent and then having to click
    // the log would be a step with no decision in it.
    expect(snap.activeId).toBe(id("build"));
    // Nothing was opened or closed: a split is a view of the strip.
    expect(snap.tabs).toHaveLength(3);
  });

  test("the arrangement survives a look at another tab", () => {
    let snap = joined("agent", "build");
    snap = showPaneBeside(snap, id("agent"), id("build"), "row");

    snap = focusRemoteTab(snap, CHAT_TAB_ID);
    // The conversation fills the body on its own...
    expect(panesInView(snap)).toBeNull();
    // ...and the split is still there to come back to, the way a window you
    // minimised is still arranged.
    expect(snap.layout).not.toBeNull();

    snap = focusRemoteTab(snap, id("build"));
    expect(paneCount(panesInView(snap)!)).toBe(2);
  });

  test("a full body says so by having nothing left to offer", () => {
    let snap = joined("a", "b", "c", "d", "e");
    snap = showPaneBeside(snap, id("a"), id("b"), "row");
    snap = showPaneBeside(snap, id("b"), id("c"), "row");
    snap = showPaneBeside(snap, id("c"), id("d"), "column");
    expect(paneCount(panesInView(snap)!)).toBe(MAX_REMOTE_PANES);

    expect(paneCandidates(snap, id("d"))).toEqual([]);
    // And the operation itself is a no-op rather than a quiet fifth pane.
    expect(showPaneBeside(snap, id("d"), id("e"), "row")).toBe(snap);
  });

  test("a tab already on screen is not offered, and asking again changes nothing", () => {
    let snap = joined("agent", "build");
    snap = showPaneBeside(snap, id("agent"), id("build"), "row");
    // Both sessions are on screen already; the conversation is not, so it is
    // the one thing left to add.
    expect(paneCandidates(snap, id("build")).map((t) => t.id)).toEqual([CHAT_TAB_ID]);
    expect(showPaneBeside(snap, id("build"), id("agent"), "row")).toBe(snap);
  });

  test("closing a pane prunes it and lands you in the pane beside it", () => {
    let snap = joined("agent", "build");
    snap = showPaneBeside(snap, id("agent"), id("build"), "row");
    snap = showPaneBeside(snap, id("build"), CHAT_TAB_ID, "column");
    expect(paneCount(snap.layout!)).toBe(3);

    snap = focusRemoteTab(snap, id("build"));
    snap = closeRemoteTab(snap, id("build"));
    expect(paneTabIds(snap.layout!)).toEqual([id("agent"), CHAT_TAB_ID]);
    // Focus follows the split before it follows the strip.
    expect(paneTabIds(snap.layout!)).toContain(snap.activeId);
  });

  test("closing one half of a split gives the body back to the other", () => {
    let snap = joined("agent", "build");
    snap = showPaneBeside(snap, id("agent"), id("build"), "row");
    snap = closeRemoteTab(snap, id("build"));
    // One pane is not an arrangement.
    expect(snap.layout).toBeNull();
    expect(snap.tabs.map((t) => t.id)).toEqual([CHAT_TAB_ID, id("agent")]);
  });

  test("showing one alone closes nothing", () => {
    let snap = joined("agent", "build");
    snap = showPaneBeside(snap, id("agent"), id("build"), "row");
    const alone = showPaneAlone(snap);
    expect(alone.layout).toBeNull();
    expect(alone.tabs).toEqual(snap.tabs);
    expect(alone.activeId).toBe(snap.activeId);
  });
});

describe("a strip read back off disk", () => {
  const slot = remoteSlotFor(BOX, HERE)!;

  // bun's runner has no DOM, and the module reads storage through try/catch —
  // without a store every read would fall through to "no slot" and these would
  // pass while proving nothing about what is on disk.
  function store(blob: unknown) {
    const map = new Map<string, string>([
      [remoteSlotKey(slot), JSON.stringify(blob)],
    ]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    };
  }

  test("a blob written before splits existed keeps its tabs", () => {
    // v1 had no `layout` field at all. Discarding it would empty the strip of
    // everyone who had three agents open on a box the day they updated.
    store({
      v: 1,
      tabs: [
        { id: CHAT_TAB_ID, kind: "cloud", label: "Chat" },
        { id: id("agent"), kind: "session", session: named("agent"), readOnly: false },
      ],
      activeId: id("agent"),
    });
    const back = loadRemoteSnapshot(slot)!;
    expect(back.tabs.map((t) => t.id)).toEqual([CHAT_TAB_ID, id("agent")]);
    expect(back.activeId).toBe(id("agent"));
    expect(back.layout).toBeNull();
  });

  test("the files/changes/git tabs older builds opened are dropped, and focus falls to the chat", () => {
    // Their work is the frame's right panel and header now; a tab of that
    // kind has no body left to draw.
    store({
      v: 2,
      tabs: [
        { id: CHAT_TAB_ID, kind: "cloud", label: "Chat" },
        { id: id("agent"), kind: "session", session: named("agent"), readOnly: false },
        { id: "work:files", kind: "work", work: "files" },
      ],
      activeId: "work:files",
      layout: null,
    });
    const back = loadRemoteSnapshot(slot)!;
    expect(back.tabs.map((t) => t.id)).toEqual([CHAT_TAB_ID, id("agent")]);
    expect(back.activeId).toBe(CHAT_TAB_ID);
  });

  test("file and diff tabs come back; a diff with a bad hash comes back as the working tree", () => {
    store({
      v: 2,
      tabs: [
        { id: CHAT_TAB_ID, kind: "cloud", label: "Chat" },
        { id: "x", kind: "file", path: `${HERE}/a.ts` },
        { id: "y", kind: "diff", sha: "not a hash", path: "a.ts" },
        { id: "z", kind: "file", path: `${HERE}/a.ts` },
      ],
      activeId: "x",
      layout: null,
    });
    const back = loadRemoteSnapshot(slot)!;
    expect(back.tabs.map((t) => t.id)).toEqual([
      CHAT_TAB_ID,
      fileTabId(`${HERE}/a.ts`),
      diffTabId(null),
    ]);
  });

  test("a pane naming a tab that is gone is dropped, not drawn", () => {
    store({
      v: 2,
      tabs: [
        { id: CHAT_TAB_ID, kind: "cloud", label: "Chat" },
        { id: id("agent"), kind: "session", session: named("agent"), readOnly: false },
      ],
      activeId: id("agent"),
      layout: {
        kind: "split",
        direction: "row",
        children: [
          { kind: "leaf", tabId: id("agent") },
          { kind: "leaf", tabId: id("build") },
        ],
      },
    });
    // A pane with no tab behind it is a terminal with nothing in it, and what
    // is left is one pane — which is the plain body.
    expect(loadRemoteSnapshot(slot)!.layout).toBeNull();
  });

  test("a split of tabs that are both still open comes back whole", () => {
    store({
      v: 2,
      tabs: [
        { id: CHAT_TAB_ID, kind: "cloud", label: "Chat" },
        { id: id("agent"), kind: "session", session: named("agent"), readOnly: false },
        { id: id("build"), kind: "session", session: named("build"), readOnly: false },
      ],
      activeId: id("build"),
      layout: {
        kind: "split",
        direction: "column",
        children: [
          { kind: "leaf", tabId: id("agent") },
          { kind: "leaf", tabId: id("build") },
        ],
      },
    });
    const back = loadRemoteSnapshot(slot)!;
    expect(paneTabIds(back.layout!)).toEqual([id("agent"), id("build")]);
    expect(paneTabIds(panesInView(back)!)).toHaveLength(2);
  });
});

// The work tabs of a remote workspace — files, changes, git, PRs, run — and
// the slot they are filed under when the place is a worktree on the box.

import { describe, expect, test } from "bun:test";

import type { BoxSession } from "./api";
import {
  CHAT_TAB_ID,
  REMOTE_WORK_KINDS,
  activeTab,
  closeRemoteTab,
  emptyRemoteSnapshot,
  learnedItsProject,
  openSessionTab,
  openWorkTab,
  remoteSlotFor,
  remoteSlotKey,
  workTabId,
} from "./remoteWorkspaceSnapshot";

const BOX = "ubuntu@18.196.118.42";
const HERE = "/Users/me/app";
const THERE = "/home/ubuntu/app-feat-x";

const session: BoxSession = {
  name: "files",
  title: "claude",
  project: THERE,
  agent: "claude",
  attached: 1,
} as unknown as BoxSession;

describe("work tabs", () => {
  test("opening one appends it and looks at it; opening it again only looks", () => {
    let snap = openWorkTab(emptyRemoteSnapshot(), "files");
    expect(snap.tabs.map((t) => t.id)).toEqual([CHAT_TAB_ID, workTabId("files")]);
    expect(activeTab(snap)?.kind).toBe("work");

    snap = openWorkTab(snap, "changes");
    snap = openWorkTab(snap, "files");
    expect(snap.tabs).toHaveLength(3);
    expect(snap.activeId).toBe(workTabId("files"));
  });

  test("a session named like a surface is not that surface", () => {
    let snap = openSessionTab(emptyRemoteSnapshot(), session, false);
    snap = openWorkTab(snap, "files");
    expect(snap.tabs.map((t) => t.kind)).toEqual(["cloud", "session", "work"]);
  });

  test("every kind has its own tab, and each can be closed", () => {
    let snap = emptyRemoteSnapshot();
    for (const k of REMOTE_WORK_KINDS) snap = openWorkTab(snap, k);
    expect(snap.tabs).toHaveLength(1 + REMOTE_WORK_KINDS.length);
    snap = closeRemoteTab(snap, workTabId("run"));
    expect(snap.tabs.some((t) => t.id === workTabId("run"))).toBe(false);
    // Focus falls to the last tab, not to the chat.
    expect(snap.activeId).toBe(workTabId("prs"));
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

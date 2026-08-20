// Walking out of a machine and back into it used to cost you the machine.
//
//   bun test
//
// A remote workspace kept its tabs in a plain `useState` seeded with one Chat
// tab, and the window unmounts that workspace every time you look at anything
// else — a second box, a page, your own files. So three agents open on a runner
// became one Chat tab the moment you glanced at Trace, with nothing on screen
// to say anything had been lost. Switching machines inside the workspace was
// worse: the body was keyed on `machine.id`, so the picker remounted the whole
// subtree and threw the outgoing box's tabs away before anything could record
// them.
//
// The local surface solved this years ago — `workspaceSnapshot` writes one slot
// per place and reads it back on the way in — and the fix here is that same
// pattern rather than a second one, keyed by the identity a remote place
// actually has: a box AND a project. One runner holding two projects is two
// places you can stand in, and their strips must not pour into one slot.
//
// These are runtime tests against the real module, not source scans: the whole
// question is what comes back out of storage, and storage is easy to stand up.
// The component wiring is pinned by source at the end, since a .tsx that
// imports React and Tauri cannot be loaded under bun.

import { beforeEach, describe, expect, test } from "bun:test";

import type { BoxSession } from "../src/lib/api";
import {
  activeTab,
  closeRemoteTab,
  emptyRemoteSnapshot,
  focusRemoteTab,
  hasSessionTabs,
  learnedItsProject,
  loadRemoteSnapshot,
  openSessionTab,
  refreshSessions,
  remoteSlotFor,
  remoteSlotKey,
  removeRemoteSnapshot,
  saveRemoteSnapshot,
  sameRemoteSlot,
  switchRemoteSlot,
  tabIdFor,
  type RemoteSlot,
  type RemoteWorkspaceSnapshot,
} from "../src/lib/remoteWorkspaceSnapshot";
import { readSrc } from "./support/code";

/** Plain in-memory localStorage. The durability question — what happens when
 *  the origin is full — is `localStorageBudget.test.ts`'s; this file is about
 *  what is written and what comes back. */
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const BOX = "me@build-01";
const OTHER_BOX = "me@build-02";
const ALPHA = "/Users/me/projects/alpha";
const BETA = "/Users/me/projects/beta";

function session(name: string, over: Partial<BoxSession> = {}): BoxSession {
  return {
    name,
    project: `/home/me/${name}`,
    kind: "agent",
    agent: "claude",
    branch: null,
    title: name,
    created_at: 1_700_000_000,
    activity_at: 1_700_000_100,
    attached: 1,
    ...over,
  } as BoxSession;
}

/** The slot a workspace on `machine` standing in `root` files its tabs under.
 *  Every test goes through the real `remoteSlotFor` so a null slot is a test
 *  failure rather than a silently skipped write. */
function slot(machineId: string, root?: string): RemoteSlot {
  const s = remoteSlotFor(machineId, root);
  if (!s) throw new Error(`no slot for ${machineId}`);
  return s;
}

/** What a strip looks like, in the terms someone reading the failure cares
 *  about: which tabs, in order, and which one is in front. */
function layout(snap: RemoteWorkspaceSnapshot): {
  tabs: string[];
  active: string;
} {
  return { tabs: snap.tabs.map((t) => t.id), active: snap.activeId };
}

/** Open sessions on a strip, left to right. */
function withSessions(names: string[]): RemoteWorkspaceSnapshot {
  return names.reduce(
    (snap, n) => openSessionTab(snap, session(n), false),
    emptyRemoteSnapshot(),
  );
}

describe("a slot is a box AND a project", () => {
  test("two projects on one machine are two slots", () => {
    expect(remoteSlotKey(slot(BOX, ALPHA))).not.toBe(
      remoteSlotKey(slot(BOX, BETA)),
    );
  });

  test("one project on two machines is two slots", () => {
    expect(remoteSlotKey(slot(BOX, ALPHA))).not.toBe(
      remoteSlotKey(slot(OTHER_BOX, ALPHA)),
    );
  });

  test("the same box and project is the same slot, however the path is spelled", () => {
    // `/a/b` and `/a/b/` are one project. Two spellings of one identity is how
    // a machine grows a second, empty strip nobody asked for.
    expect(remoteSlotKey(slot(BOX, `${ALPHA}/`))).toBe(
      remoteSlotKey(slot(BOX, ALPHA)),
    );
    expect(sameRemoteSlot(slot(BOX, `${ALPHA}  `.trim()), slot(BOX, ALPHA))).toBe(
      true,
    );
  });

  test("a box with no project named is still a real slot", () => {
    const s = remoteSlotFor(BOX, undefined);
    expect(s).not.toBeNull();
    expect(s!.repoRoot).toBe("");
    expect(remoteSlotKey(s!)).not.toBe(remoteSlotKey(slot(BOX, ALPHA)));
  });

  test("no machine is no slot — an unresolved entry files nothing", () => {
    // Every entry opened from a cloud conversation would otherwise share one
    // wildcard slot, and the first box to resolve would inherit another box's
    // tabs.
    expect(remoteSlotFor(null, ALPHA)).toBeNull();
    expect(remoteSlotFor("   ", ALPHA)).toBeNull();
    expect(sameRemoteSlot(null, null)).toBe(true);
    expect(sameRemoteSlot(null, slot(BOX, ALPHA))).toBe(false);
  });

  test("its key space is its own, not the local surface's", () => {
    // `snapshotSlotKeys` sweeps every key under the local prefix and parses
    // each one as a WorkspaceSnapshot. A remote blob filed there would be read
    // as a workspace with no tabs at all.
    expect(remoteSlotKey(slot(BOX, ALPHA))).not.toStartWith(
      "aura.workspaceSnapshot.",
    );
  });
});

describe("two projects on one box, switch, both layouts return", () => {
  test("each project keeps the strip it was left with", () => {
    const a = slot(BOX, ALPHA);
    const b = slot(BOX, BETA);

    // Standing in alpha: two agents joined, looking at the first.
    let inAlpha = withSessions(["alpha-api", "alpha-web"]);
    inAlpha = focusRemoteTab(inAlpha, "alpha-api");

    // Switch to beta on the same box. Alpha is written out, beta is fresh.
    const inBeta0 = switchRemoteSlot(a, inAlpha, b);
    expect(layout(inBeta0)).toEqual({ tabs: ["cloud"], active: "cloud" });

    // Do different work in beta.
    let inBeta = openSessionTab(inBeta0, session("beta-migrate"), false);
    inBeta = openSessionTab(inBeta, session("beta-logs"), true);

    // Back to alpha: exactly what was left, down to which tab was in front.
    const backInAlpha = switchRemoteSlot(b, inBeta, a);
    expect(layout(backInAlpha)).toEqual({
      tabs: ["cloud", "alpha-api", "alpha-web"],
      active: "alpha-api",
    });

    // And beta is still beta — including the watch tab's own id.
    const backInBeta = switchRemoteSlot(a, backInAlpha, b);
    expect(layout(backInBeta)).toEqual({
      tabs: ["cloud", "beta-migrate", "watch:beta-logs"],
      active: "watch:beta-logs",
    });
  });

  test("neither project can see the other's sessions", () => {
    const a = slot(BOX, ALPHA);
    const b = slot(BOX, BETA);
    saveRemoteSnapshot(a, withSessions(["alpha-api"]));
    saveRemoteSnapshot(b, withSessions(["beta-migrate"]));

    expect(layout(loadRemoteSnapshot(a)!).tabs).toEqual(["cloud", "alpha-api"]);
    expect(layout(loadRemoteSnapshot(b)!).tabs).toEqual([
      "cloud",
      "beta-migrate",
    ]);
  });
});

describe("switching away and back", () => {
  test("a different machine hands the first one's strip straight back", () => {
    const here = slot(BOX, ALPHA);
    const there = slot(OTHER_BOX, ALPHA);

    const held = focusRemoteTab(withSessions(["build", "tail"]), "build");
    const away = switchRemoteSlot(here, held, there);
    expect(hasSessionTabs(away)).toBe(false);

    const back = switchRemoteSlot(there, away, here);
    expect(layout(back)).toEqual(layout(held));
  });

  test("leaving the window entirely is the same round trip", () => {
    // The workspace is unmounted, not paused: what survives is what reached
    // storage. Saved on the way out, read on the way in, nothing in memory
    // between them.
    const s = slot(BOX, ALPHA);
    const held = focusRemoteTab(withSessions(["build", "tail"]), "tail");
    saveRemoteSnapshot(s, held);

    expect(layout(loadRemoteSnapshot(s)!)).toEqual({
      tabs: ["cloud", "build", "tail"],
      active: "tail",
    });
  });

  test("a place never opened comes back as the machine's own conversation", () => {
    expect(loadRemoteSnapshot(slot(BOX, ALPHA))).toBeNull();
    expect(layout(switchRemoteSlot(null, emptyRemoteSnapshot(), slot(BOX, ALPHA))))
      .toEqual({ tabs: ["cloud"], active: "cloud" });
  });

  test("a switch that isn't one leaves the strip alone", () => {
    const s = slot(BOX, ALPHA);
    const held = withSessions(["build"]);
    expect(switchRemoteSlot(s, held, slot(BOX, `${ALPHA}/`))).toBe(held);
  });

  test("losing the machine doesn't lose what was open on it", () => {
    // The book stops naming the box mid-session (removed, or signed out). The
    // strip empties, because there is no machine to draw one for — but the
    // slot on disk still holds it, and reconnecting is a round trip like any
    // other.
    const s = slot(BOX, ALPHA);
    const held = withSessions(["build"]);
    const nowhere = switchRemoteSlot(s, held, null);
    expect(hasSessionTabs(nowhere)).toBe(false);
    expect(layout(loadRemoteSnapshot(s)!)).toEqual(layout(held));
  });
});

describe("a box learning which project it holds is not a switch", () => {
  test("tabs opened before the project was known come with it", () => {
    // Entering from the fleet page names no project; the box reports the one it
    // is a copy of a beat later. Treating that as a switch empties the strip in
    // front of someone who just attached a session.
    const nameless = slot(BOX);
    const named = slot(BOX, ALPHA);
    expect(learnedItsProject(nameless, named)).toBe(true);

    const held = focusRemoteTab(withSessions(["build"]), "build");
    const after = switchRemoteSlot(nameless, held, named);

    expect(layout(after)).toEqual(layout(held));
    expect(layout(loadRemoteSnapshot(named)!)).toEqual(layout(held));
    // And the nameless slot is emptied rather than left to hand these same
    // tabs to the next entry that arrives without a project.
    expect(loadRemoteSnapshot(nameless)).toBeNull();
  });

  test("a project you have worked in before keeps its own layout, plus what you just opened", () => {
    const nameless = slot(BOX);
    const named = slot(BOX, ALPHA);
    saveRemoteSnapshot(named, withSessions(["yesterday"]));

    const justOpened = withSessions(["today"]);
    const after = switchRemoteSlot(nameless, justOpened, named);

    expect(layout(after)).toEqual({
      tabs: ["cloud", "yesterday", "today"],
      active: "today",
    });
  });

  test("the other direction, and a different box, are ordinary switches", () => {
    expect(learnedItsProject(slot(BOX, ALPHA), slot(BOX))).toBe(false);
    expect(learnedItsProject(slot(BOX), slot(OTHER_BOX, ALPHA))).toBe(false);
    expect(learnedItsProject(null, slot(BOX, ALPHA))).toBe(false);
  });
});

describe("what a slot is allowed to come back as", () => {
  test("a blob from another schema is no snapshot at all", () => {
    const s = slot(BOX, ALPHA);
    localStorage.setItem(
      remoteSlotKey(s),
      JSON.stringify({ v: 99, tabs: [], activeId: "cloud" }),
    );
    expect(loadRemoteSnapshot(s)).toBeNull();
  });

  test("unreadable storage is no snapshot, not a crash", () => {
    const s = slot(BOX, ALPHA);
    localStorage.setItem(remoteSlotKey(s), "{not json");
    expect(loadRemoteSnapshot(s)).toBeNull();
  });

  test("the machine's conversation is always on the strip", () => {
    // It is not a tab you opened — it is the machine, seen from the board's
    // side. A slot that came back without it would be a workspace with no way
    // to talk to the box.
    const s = slot(BOX, ALPHA);
    localStorage.setItem(
      remoteSlotKey(s),
      JSON.stringify({ v: 1, tabs: [], activeId: "cloud" }),
    );
    expect(layout(loadRemoteSnapshot(s)!)).toEqual({
      tabs: ["cloud"],
      active: "cloud",
    });
  });

  test("the tab in front always names one that is there", () => {
    const s = slot(BOX, ALPHA);
    const snap = withSessions(["build"]);
    saveRemoteSnapshot(s, { ...snap, activeId: "a-session-since-closed" });
    expect(loadRemoteSnapshot(s)!.activeId).toBe("cloud");
  });

  test("half-written session tabs are dropped, the rest survive", () => {
    const s = slot(BOX, ALPHA);
    localStorage.setItem(
      remoteSlotKey(s),
      JSON.stringify({
        v: 1,
        tabs: [
          { id: "cloud", kind: "cloud", label: "Chat" },
          { id: "build", kind: "session", session: session("build"), readOnly: false },
          { id: "ghost", kind: "session", readOnly: false },
        ],
        activeId: "build",
      }),
    );
    expect(layout(loadRemoteSnapshot(s)!)).toEqual({
      tabs: ["cloud", "build"],
      active: "build",
    });
  });

  test("removing a slot removes it", () => {
    const s = slot(BOX, ALPHA);
    saveRemoteSnapshot(s, withSessions(["build"]));
    removeRemoteSnapshot(s);
    expect(loadRemoteSnapshot(s)).toBeNull();
  });
});

describe("what you can do to a strip", () => {
  test("joining a session you already have open focuses it, never doubles it", () => {
    // tmux would happily give us a second client on the same pane, and the two
    // would then fight each other for the keyboard.
    const first = openSessionTab(emptyRemoteSnapshot(), session("build"), false);
    const refocused = focusRemoteTab(first, "cloud");
    const again = openSessionTab(
      refocused,
      session("build", { title: "renamed", attached: 2 }),
      false,
    );
    expect(layout(again)).toEqual({ tabs: ["cloud", "build"], active: "build" });
    const tab = again.tabs[1]!;
    expect(tab.kind === "session" && tab.session.title).toBe("renamed");
  });

  test("watching and driving the same session are two tabs", () => {
    // Switching between them has to re-dial: a terminal already attached
    // read-only cannot be talked into accepting input.
    expect(tabIdFor("build", true)).toBe("watch:build");
    expect(tabIdFor("build", false)).toBe("build");
    let snap = openSessionTab(emptyRemoteSnapshot(), session("build"), false);
    snap = openSessionTab(snap, session("build"), true);
    expect(layout(snap).tabs).toEqual(["cloud", "build", "watch:build"]);
  });

  test("closing a tab falls back to the one beside it", () => {
    const snap = withSessions(["one", "two"]);
    expect(layout(closeRemoteTab(snap, "two"))).toEqual({
      tabs: ["cloud", "one"],
      active: "one",
    });
    // Closing a tab you aren't looking at doesn't move you.
    expect(layout(closeRemoteTab(snap, "one"))).toEqual({
      tabs: ["cloud", "two"],
      active: "two",
    });
  });

  test("the conversation can't be closed", () => {
    const snap = withSessions(["one"]);
    expect(closeRemoteTab(snap, "cloud")).toBe(snap);
    expect(closeRemoteTab(snap, "never-opened")).toBe(snap);
  });

  test("focusing a tab that isn't there changes nothing", () => {
    const snap = withSessions(["one"]);
    expect(focusRemoteTab(snap, "two")).toBe(snap);
    expect(focusRemoteTab(snap, snap.activeId)).toBe(snap);
    expect(activeTab(snap)?.id).toBe("one");
  });

  test("a restored tab stops lying once the box answers", () => {
    // It states what the machine looked like when you left: the title, the
    // directory, how many people were attached. An agent that finished
    // overnight still reads as someone else's keyboard until this runs.
    const stale = withSessions(["build"]);
    const fresh = refreshSessions(stale, [
      session("build", { title: "deploy", attached: 3 }),
    ]);
    const tab = fresh.tabs[1]!;
    expect(tab.kind === "session" && tab.session.attached).toBe(3);
    expect(tab.kind === "session" && tab.session.title).toBe("deploy");
  });

  test("a read the strip would draw identically is not a change", () => {
    // The box is re-read every few seconds and hands back a fresh object each
    // time. Treating each poll as a change would rewrite the slot on a timer.
    const snap = withSessions(["build"]);
    expect(refreshSessions(snap, [session("build")])).toBe(snap);
    expect(
      refreshSessions(snap, [session("build", { activity_at: 999_999_999 })]),
    ).toBe(snap);
  });

  test("a session the read doesn't mention keeps its tab", () => {
    // A tab is a view you opened, and closing it is yours to do — not
    // something a partial read gets to decide.
    const snap = withSessions(["build", "tail"]);
    const after = refreshSessions(snap, [session("build")]);
    expect(layout(after).tabs).toEqual(["cloud", "build", "tail"]);
  });

  test("a fresh place has no sessions, one with a tab has", () => {
    expect(hasSessionTabs(emptyRemoteSnapshot())).toBe(false);
    expect(hasSessionTabs(withSessions(["build"]))).toBe(true);
  });
});

const body = await readSrc("components/cloud/RemoteWorkspace.tsx");
const hook = await readSrc("components/cloud/useRemoteTabs.ts");

describe("the workspace is wired to the slot, not to its own lifetime", () => {
  test("the tabs come from the slot", () => {
    expect(body).toContain("useRemoteTabs(machine?.id ?? null, repoRoot)");
    // The `useState` that died with the mount is gone, in both halves.
    expect(body).not.toContain("useState<RemoteTab[]>");
    expect(body).not.toContain('useState<string>("cloud")');
  });

  test("switching machines no longer remounts the workspace", () => {
    // The body was keyed on the machine, so the picker threw the outgoing
    // box's tabs away before anything could record them.
    expect(body).not.toContain('key={machine?.id ?? "no-machine"}\n        entry');
    expect(body).toContain("<RemoteWorkspaceBody\n        entry={entry}");
    // The one thing that still resets per machine is the draft OF that machine.
    expect(body).toContain('key={machine?.id ?? "no-machine"}\n        machine={machine}');
  });

  test("the slot is both halves, so one mount serves several projects", () => {
    expect(hook).toContain("remoteSlotFor(machineId, repoRoot)");
    expect(body).toContain(
      "const repoRoot = entry.repoRoot ?? machine?.project_root ?? undefined;",
    );
  });

  test("the outgoing slot is written before the incoming one is read", () => {
    expect(hook).toContain("switchRemoteSlot(cur.slot, cur.snap, slot)");
    // Before paint: the commit that swaps the slot must not be the one that
    // draws the old box's strip under the new box's chrome.
    expect(hook).toContain("useLayoutEffect");
    // Written through on every change, not on the way out — an unmount handler
    // is the wrong place for the only copy of something.
    expect(hook).toContain("saveRemoteSnapshot(held.slot, held.snap)");
  });

  test("arriving somewhere you already have tabs doesn't move you off them", () => {
    expect(body).toContain("if (strip.hasSessions) return;");
  });
});

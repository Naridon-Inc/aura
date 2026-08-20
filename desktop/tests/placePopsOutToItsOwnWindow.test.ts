// "Open in its own window" used to be a thing you could do to a checkout.
//
//   bun test
//
// A whole-workspace popout carried one field — `root=<path>` — which describes
// a place perfectly right up until the place isn't on this laptop. A machine is
// a box AND a project; a cloud conversation is a place that hasn't resolved a
// box yet and may name no local checkout at all. Neither fits in a path, so the
// gesture existed for local copies and not for machines: a feature landed in one
// place-mode only, which is the thing this programme exists to stop.
//
// So a workspace popout carries a `PlaceRef` now, and these are the two halves
// of that being true:
//
//   • the URL round trip — what `openPopout` writes is what the new window
//     reads back, for both kinds of place, including a machine with no local
//     checkout at all;
//   • the window LABEL — two places must not share one window, and a place must
//     not share the local checkout's window either.
//
// Both are runtime tests against the real modules. `lib/popout` imports Tauri's
// `WebviewWindow`, which loads fine under bun as long as nothing calls it; the
// label and the query are pure functions and are exported for exactly this.
// Everything that needs React — where the window is booted, and the two doors
// the gesture is offered behind — is pinned by source scan at the end.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { BoxSession } from "../src/lib/api";
import {
  NO_REMOTE_PLACES,
  blurRemotePlaces,
  enterRemotePlace,
  isRemotePlaceEntered,
  leaveRemotePlace,
  remotePlaceKey,
} from "../src/lib/remotePlaces";
import {
  emptyRemoteSnapshot,
  loadRemoteSnapshot,
  openSessionTab,
  remoteSlotFor,
  saveRemoteSnapshot,
  switchRemoteSlot,
  type RemoteSlot,
  type RemoteWorkspaceSnapshot,
} from "../src/lib/remoteWorkspaceSnapshot";
import {
  localPlace,
  parsePlaceRef,
  placeKey,
  remotePlace,
  remotePlaceOf,
  type PlaceRef,
} from "../src/lib/placeRef";
import {
  placeFromPopoutQuery,
  placeToPopoutQuery,
  popoutPlaceParts,
} from "../src/lib/popoutPlace";
import {
  popoutQuery,
  popoutWindowLabel,
  readPopoutParams,
  type PopoutParams,
  type PopoutSpec,
} from "../src/lib/popout";
import { readSrc } from "./support/code";

const LOCAL = "/Users/me/code/aura";
const BOX = "me@build-01";
const OTHER_BOX = "me@build-02";

/** Read a URL back the way the popped window does — `readPopoutParams` reads
 *  the global `window`, so this is the whole of standing one up.
 *
 *  The listener pair is not decoration. Several modules in this codebase wire a
 *  cross-window listener at import time behind `typeof window !== "undefined"`,
 *  and bun runs every test file in one process: a bare `{ location }` left on
 *  the global takes those modules' guard and then has no method for them to
 *  call, which fails files that never mentioned a window. `afterAll` puts the
 *  global back for the same reason. */
const NO_WINDOW = Symbol("no window");
const realWindow =
  "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : NO_WINDOW;

function readAt(search: string): PopoutParams | null {
  (globalThis as { window?: unknown }).window = {
    location: { search },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return readPopoutParams();
}

afterAll(() => {
  if (realWindow === NO_WINDOW) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = realWindow;
});

/** Open a popout, then boot the window it opened. The one thing worth
 *  asserting about a detached place is that the far end of this trip is the
 *  place the near end asked for. */
function reopen(spec: PopoutSpec): PopoutParams | null {
  return readAt(`?${popoutQuery(spec).toString()}`);
}

/** A whole-window popout of `place`, spelled the way both callers spell it. */
function popOut(place: PlaceRef): PopoutSpec {
  return {
    kind: "workspace",
    root: place.repoRoot ?? "",
    place,
    title: "Aura",
  };
}

describe("a popped window comes up in the place it was popped out of", () => {
  test("a machine, with the project it is a copy of", () => {
    const place = remotePlace({ machineId: BOX, repoRoot: LOCAL });
    const params = reopen(popOut(place));
    expect(params?.kind).toBe("workspace");
    expect(params?.place).toEqual(place);
    // Both halves, or the window is standing somewhere else with the same name.
    expect(params?.place && placeKey(params.place)).toBe(placeKey(place));
  });

  test("a machine this laptop has no checkout of", () => {
    // Entered from the fleet page: a box, and no local project to file it
    // under. The old reader returned null for a rootless popout, which meant
    // this window booted as a second MAIN window — on the last workspace, with
    // no machine in it at all.
    const place = remotePlace({ machineId: BOX });
    const params = reopen(popOut(place));
    expect(params?.place).toEqual(place);
    expect(params?.root).toBe("");
  });

  test("a cloud conversation that hasn't resolved a box yet", () => {
    const place = remotePlace({ threadKey: "job-771", repoRoot: LOCAL });
    const params = reopen(popOut(place));
    expect(params?.place).toEqual(place);
  });

  test("a checkout on this laptop, exactly as before", () => {
    const params = reopen(popOut(localPlace(LOCAL)));
    expect(params?.place).toEqual(localPlace(LOCAL));
    expect(params?.root).toBe(LOCAL);
  });

  test("a caller who names only a root still gets the local place", () => {
    // Every "Open in new window" written before places existed. The place is
    // optional on the spec and inferred, so those callers keep working and
    // keep opening the same window.
    const params = reopen({ kind: "workspace", root: LOCAL });
    expect(params?.place).toEqual(localPlace(LOCAL));
  });

  test("a URL from a build that predates places reads as the local place", () => {
    expect(readAt(`?popout=workspace&root=${LOCAL}`)?.place).toEqual(
      localPlace(LOCAL),
    );
  });

  test("a workspace popout that names nowhere is not a window", () => {
    // `?place=remote` with no box, no conversation and no project keys as the
    // same wildcard place as every other such entry. A window that opens on
    // "whichever machine was used last" is a window lying about which one it
    // is, so it doesn't open.
    expect(readAt("?popout=workspace&place=remote&root=")).toBeNull();
    expect(readAt("?popout=workspace&root=")).toBeNull();
  });

  test("the main window is still the main window", () => {
    expect(readAt("")).toBeNull();
  });

  test("every other popout kind is untouched by the place field", () => {
    const params = reopen({ kind: "task", root: LOCAL, taskId: "AURA-211" });
    expect(params).toEqual({ kind: "task", root: LOCAL, taskId: "AURA-211" });
    expect(params?.place).toBeUndefined();
    // …and a surface with no root to load its data off is still nothing.
    expect(readAt("?popout=tasks")).toBeNull();
  });
});

describe("one window per place, and never two places in one", () => {
  const labelOf = (place: PlaceRef) => popoutWindowLabel(popOut(place));

  test("two boxes holding the same project are two windows", () => {
    expect(labelOf(remotePlace({ machineId: BOX, repoRoot: LOCAL }))).not.toBe(
      labelOf(remotePlace({ machineId: OTHER_BOX, repoRoot: LOCAL })),
    );
  });

  test("one box holding two projects is two windows", () => {
    expect(labelOf(remotePlace({ machineId: BOX, repoRoot: LOCAL }))).not.toBe(
      labelOf(remotePlace({ machineId: BOX, repoRoot: "/Users/me/code/web" })),
    );
  });

  test("the box and the local copy of the same project are two windows", () => {
    // The one that would bite hardest: popping out the machine would have
    // focused the window already showing the checkout, and looked like the
    // click did nothing.
    expect(labelOf(localPlace(LOCAL))).not.toBe(
      labelOf(remotePlace({ machineId: BOX, repoRoot: LOCAL })),
    );
  });

  test("a machine and a conversation with the same name are two windows", () => {
    expect(labelOf(remotePlace({ machineId: "x", repoRoot: LOCAL }))).not.toBe(
      labelOf(remotePlace({ threadKey: "x", repoRoot: LOCAL })),
    );
  });

  test("the same place twice is one window", () => {
    // What makes re-invoking a focus rather than a second copy of the box.
    expect(labelOf(remotePlace({ machineId: BOX, repoRoot: LOCAL }))).toBe(
      labelOf(remotePlace({ machineId: BOX, repoRoot: `${LOCAL}/` })),
    );
  });

  test("a local checkout's window is labelled exactly as it always was", () => {
    expect(labelOf(localPlace(LOCAL))).toBe(
      popoutWindowLabel({ kind: "workspace", root: LOCAL }),
    );
  });

  test("every label matches the capability glob and its charset", () => {
    for (const place of [
      localPlace(LOCAL),
      remotePlace({ machineId: BOX, repoRoot: LOCAL }),
      remotePlace({ machineId: BOX }),
      remotePlace({ threadKey: "job-771" }),
      remotePlace({ repoRoot: LOCAL }),
    ] as PlaceRef[]) {
      expect(labelOf(place)).toMatch(/^popout-[a-z0-9-]+$/);
    }
  });
});

describe("the codec answers to the same rules a club member does", () => {
  test("a local place spells itself entirely in the root", () => {
    expect(placeToPopoutQuery(localPlace(LOCAL))).toEqual({ root: LOCAL });
  });

  test("a remote place adds only what a path cannot say", () => {
    expect(
      placeToPopoutQuery(remotePlace({ machineId: BOX, repoRoot: LOCAL })),
    ).toEqual({ root: LOCAL, place: "remote", machineId: BOX });
  });

  test("what comes back out is what `parsePlaceRef` would have made", () => {
    const q = new URLSearchParams({
      root: LOCAL,
      place: "remote",
      machineId: BOX,
      threadKey: "job-771",
    });
    expect(placeFromPopoutQuery(q)).toEqual(
      parsePlaceRef({
        kind: "remote",
        machineId: BOX,
        threadKey: "job-771",
        repoRoot: LOCAL,
      }),
    );
  });

  test("the label part separates the two remote key spaces", () => {
    expect(popoutPlaceParts(localPlace(LOCAL))).toBeNull();
    expect(popoutPlaceParts(remotePlace({ machineId: "x" }))).toEqual({
      tag: "m",
      id: "x",
    });
    expect(popoutPlaceParts(remotePlace({ threadKey: "x" }))).toEqual({
      tag: "t",
      id: "x",
    });
  });

  test("the remote half hands back what the entered-places set is fed", () => {
    // `enterRemotePlace` takes a `RemotePlace`, not the tagged union, and a
    // stray `kind` on an entry is a field nothing reads and everything copies.
    expect(
      remotePlaceOf(remotePlace({ machineId: BOX, repoRoot: LOCAL })),
    ).toEqual({ machineId: BOX, threadKey: undefined, repoRoot: LOCAL });
  });
});

// ---------------------------------------------------------------------------
// Two windows, one origin
// ---------------------------------------------------------------------------

/** Plain in-memory localStorage. Two Aura windows are two module scopes over
 *  ONE origin, so the slots are shared and the live state is not — which is the
 *  whole question below. */
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

function session(name: string): BoxSession {
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
  } as BoxSession;
}

function slotOf(machineId: string, root?: string): RemoteSlot {
  const s = remoteSlotFor(machineId, root);
  if (!s) throw new Error(`no slot for ${machineId}`);
  return s;
}

function withSessions(names: string[]): RemoteWorkspaceSnapshot {
  return names.reduce(
    (snap, n) => openSessionTab(snap, session(n), false),
    emptyRemoteSnapshot(),
  );
}

const tabsOf = (snap: RemoteWorkspaceSnapshot | null) =>
  snap?.tabs.map((t) => t.id) ?? null;

describe("the popped window survives what the parent does next", () => {
  const P = slotOf(BOX, LOCAL);
  const OTHER = slotOf(OTHER_BOX, LOCAL);
  const key = remotePlaceKey({ machineId: BOX, repoRoot: LOCAL });

  test("the parent switching machines doesn't empty the popped window's place", () => {
    // The state the box was in when it was popped out.
    saveRemoteSnapshot(P, withSessions(["build", "tail"]));
    // The popped window reads it and gets on with its own work.
    const popped = openSessionTab(
      loadRemoteSnapshot(P) ?? emptyRemoteSnapshot(),
      session("review"),
      false,
    );
    // Meanwhile the parent, standing in the same place, walks to another box.
    switchRemoteSlot(P, withSessions(["build", "tail"]), OTHER);
    // The popped window's strip is its own value — the parent never held it —
    // and writing it back is what the slot holds.
    expect(tabsOf(popped)).toEqual(["cloud", "build", "tail", "review"]);
    saveRemoteSnapshot(P, popped);
    expect(tabsOf(loadRemoteSnapshot(P))).toEqual([
      "cloud",
      "build",
      "tail",
      "review",
    ]);
  });

  test("the parent LEAVING the machine leaves the popped window standing in it", () => {
    // Leaving is the one removal in the entered-places set, and it is the one
    // move that could plausibly be taken as "this place is done with". It is a
    // fact about one window's set: the slot on disk is untouched, so the
    // popped window re-reads exactly what it had.
    saveRemoteSnapshot(P, withSessions(["build"]));
    const parent = enterRemotePlace(NO_REMOTE_PLACES, {
      machineId: BOX,
      repoRoot: LOCAL,
    });
    const after = leaveRemotePlace(parent, key);
    expect(isRemotePlaceEntered(after, key)).toBe(false);
    expect(tabsOf(loadRemoteSnapshot(P))).toEqual(["cloud", "build"]);
  });

  test("the two windows' sets of places are two values", () => {
    // Popping out never calls `leaveRemotePlace` on the window you clicked (see
    // the source pins above), so the parent is still standing where it was —
    // and the popped window's set, seeded at boot, holds the same place without
    // either being able to reach into the other.
    const parent = enterRemotePlace(NO_REMOTE_PLACES, {
      machineId: BOX,
      repoRoot: LOCAL,
    });
    const popped = enterRemotePlace(
      NO_REMOTE_PLACES,
      remotePlaceOf(remotePlace({ machineId: BOX, repoRoot: LOCAL })),
    );
    expect(popped.focusedKey).toBe(key);
    // The popped window stepping off its machine to read a page — the move the
    // parent's own blur makes — changes nothing about the parent.
    expect(isRemotePlaceEntered(blurRemotePlaces(popped), key)).toBe(true);
    expect(parent.focusedKey).toBe(key);
    expect(isRemotePlaceEntered(parent, key)).toBe(true);
  });
});

const main = await readSrc("main.tsx");
const app = await readSrc("App.tsx");
const remote = await readSrc("components/cloud/RemoteWorkspace.tsx");
const roster = await readSrc("components/WorkspaceRoster.tsx");

describe("the popped window boots standing in its place", () => {
  test("main hands the place to App, not just the root", () => {
    expect(main).toContain("bootPlaceOverride={workspacePopout.place}");
    // Empty is not a root. A machine with no local checkout must fall through
    // to the persisted workspace for a project to file work under, not pin the
    // App to "".
    expect(main).toContain(
      "bootRootOverride={workspacePopout.root || undefined}",
    );
  });

  test("App enters it through the same door every other way in uses", () => {
    expect(app).toContain(
      "enterRemotePlace(NO_REMOTE_PLACES, remotePlaceOf(bootPlaceOverride))",
    );
    // Seeded, not applied by an effect after first paint: an effect would draw
    // the local workspace for a frame and then cover it with the machine.
    expect(app).toContain("useState<RemotePlaces>(() =>");
  });

  test("a detached window never moves the shared pointers", () => {
    // The guard used to be "has a boot root", which a popped-out machine with
    // no local checkout does not — so it would have written the MAIN window's
    // next boot target and published over its HUD channel.
    expect(app).toContain("if (!isDetachedRef.current) {");
    expect(app).toContain("{!isDetached && <HudPublisher");
    expect(app).toContain(
      "const isDetached = !!bootRootOverride || !!bootPlaceOverride;",
    );
  });
});

/** The slice of `src` between two markers — for asking what a specific handler
 *  does, rather than what the file mentions somewhere. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(-1);
  return src.slice(a, b);
}

describe("popping a place out does not take it off the window you clicked", () => {
  test("the workspace's own door opens a window and leaves nothing behind", () => {
    const body = between(remote, "const popOut = useCallback(", "}, [");
    expect(body).toContain("openPopout({");
    expect(body).toContain('kind: "workspace"');
    // Not the hand-over `agent` and `browser` do. Leaving is the row below it,
    // and it is the user's to press.
    expect(body).not.toContain("onClose");
  });

  test("it pops out the box it is standing on, not the one it asked for", () => {
    // `entry.machineId` is absent when you arrive from the fleet or from a
    // conversation, and a window opened on that would go and pick whichever
    // machine was used last — a second window claiming to be this one.
    expect(remote).toContain("const machineId = machine?.id ?? entry.machineId;");
    const body = between(remote, "const popOut = useCallback(", "}, [");
    expect(body).toContain("machineId,");
  });

  test("the menu row is a window, and Leave is still the only way out", () => {
    const row = between(remote, "{onPopOut && (", "Open in its own window");
    expect(row).toContain("onPopOut();");
    expect(row).not.toContain("onClose");
    expect(remote).toContain("Leave this machine");
  });
});

describe("both kinds of place are offered the same window", () => {
  test("a local copy's row still offers it", () => {
    expect(roster).toContain("Open in new window");
  });

  test("a machine's row and a conversation's row offer it too", () => {
    expect(roster).toContain("Open in its own window");
    // Reached the same two ways a copy's menu is: the hover ⋯, and right-click.
    // The address is built once as `at` and handed over — the row reads a
    // `Place` now, so `user@host` comes off its identity rather than off a
    // machine row the menu would have to be handed separately.
    expect(roster).toContain("const at = `${p.identity.user}@${p.identity.host}`");
    expect(roster).toContain("openPlaceMenu(e, place, work, at,");
    expect(roster).toContain("onContextMenu={openMenu}");
    expect(roster).toContain('aria-label="Machine actions"');
    expect(roster).toContain('aria-label="Cloud work actions"');
  });

  test("the row pops out the place it stands for, not a path near it", () => {
    const item = between(roster, 'menu.kind === "place" ? (', "Open in its own window");
    expect(item).toContain("place: menu.place");
    expect(item).toContain('kind: "workspace"');
    // Going there and opening a window are different rows, and the menu keeps
    // both — a menu with one item on a row that already opens on click is a
    // menu nobody would open.
    expect(item).toContain("openRemoteWorkspace(remotePlaceOf(menu.place))");
  });
});

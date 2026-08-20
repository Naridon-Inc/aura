// A club you can actually make, from the rail.
//
//   bun test
//
// B4 generalised the club STORE to N clubs over any set of places — local
// checkouts and machines alike — and it was green and committed. It was also
// unreachable: `createClub`, `clubWith`, `addToClub` and `enterClub` had zero
// callers in `src/`, and App knew only how to LEAVE a club. So "several
// workspaces at once, on different projects" was true of the store and absent
// from the product, which is the same as not having shipped it.
//
// This file is the gate on the GESTURE. What it runs for real is
// `clubGesture` — the pick that turns two rows into a club, entering one from
// a row, leaving it, and what a club row is called — over the real
// `workspaceClubStore`, `placeRef` and `workspaceSnapshot`. Those four are
// pure over `localStorage` and load fine under bun.
//
// What it pins by source is the wiring, for the two reasons pinning is ever
// the right answer: the rail components import React (and, through the roster,
// Tauri), so they cannot be loaded here; and the bug this file exists to
// prevent is precisely a NEW rail row, or a rewritten App, quietly not calling
// any of it again.

import { beforeEach, describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

// These modules write through `localStorage`, which the app has and this
// process does not. Installed before anything imports them, and complete
// rather than a two-method stub: bun runs every test file in ONE process, so a
// half-Storage here is read by whatever a later file imports.
if (
  typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined"
) {
  const cells = new Map<string, string>();
  (globalThis as { localStorage: unknown }).localStorage = {
    get length() {
      return cells.size;
    },
    key: (i: number) => [...cells.keys()][i] ?? null,
    getItem: (k: string) => cells.get(k) ?? null,
    setItem: (k: string, v: string) => void cells.set(k, String(v)),
    removeItem: (k: string) => void cells.delete(k),
    clear: () => cells.clear(),
  };
}

const {
  beginClubPick,
  canOpenClubPick,
  cancelClubPick,
  clubLabel,
  clubMembersLine,
  enterClubFromRail,
  getClubPick,
  isPickedPlace,
  leaveClub,
  openPickedClub,
  placeLabel,
  subscribeClubPick,
  toggleClubPick,
} = await import("../src/lib/clubGesture");

const {
  clubMemberKeys,
  getActiveClub,
  getClub,
  listClubs,
  reloadClubs,
  setActiveClub,
} = await import("../src/lib/workspaceClubStore");

const { localPlace, placeKey, remotePlace } = await import(
  "../src/lib/placeRef"
);

const {
  clubSlotKey,
  emptySnapshot,
  loadClubSnapshot,
  loadSnapshot,
  saveClubSnapshot,
  saveSnapshot,
  unionSnapshots,
} = await import("../src/lib/workspaceSnapshot");

// A laptop, a second project on it, and two boxes — the shape the acceptance
// criterion names ("a local checkout and a remote place behaves identically to
// two locals").
const BOX_A = "ubuntu@18.196.118.42";
const BOX_B = "ubuntu@3.122.52.150";
const LOCAL_ROOT = "/Users/mo/src/aura";
const OTHER_ROOT = "/Users/mo/src/aura-web";

const LOCAL = () => localPlace(LOCAL_ROOT);
const OTHER = () => localPlace(OTHER_ROOT);
const ON_A = () => remotePlace({ machineId: BOX_A, repoRoot: LOCAL_ROOT });
const ON_B = () => remotePlace({ machineId: BOX_B, repoRoot: OTHER_ROOT });

/** A fresh boot: nothing this feature owns is on disk, no pick in progress,
 *  and the store re-reads. Only our own keys — every test file shares one
 *  process and one Storage, so clearing it wholesale would reach into a
 *  neighbour's fixtures. */
function freshBoot(): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (
      k.startsWith("aura.workspaceClub") ||
      k.startsWith("aura.workspaceSnapshot")
    )
      doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
  cancelClubPick();
  reloadClubs();
}

beforeEach(() => {
  freshBoot();
});

/** The gesture, as a person performs it: turn picking on, click two rows,
 *  press the one command. Every test that needs a club goes through this
 *  rather than calling `createClub`, because a club the store can make and the
 *  rail cannot is the exact hole this file is here to close. */
function clubFromRows(...rows: ReturnType<typeof LOCAL>[]) {
  beginClubPick();
  for (const row of rows) toggleClubPick(row);
  return openPickedClub();
}

describe("two roster rows and one command make a club", () => {
  test("picking two rows yields one club with two members", () => {
    const club = clubFromRows(LOCAL(), OTHER());
    expect(club).not.toBeNull();
    expect(club!.members).toHaveLength(2);
    expect(clubMemberKeys(club!)).toEqual([LOCAL_ROOT, OTHER_ROOT]);
    expect(listClubs()).toHaveLength(1);
  });

  test("the pick is put away once the club is made", () => {
    clubFromRows(LOCAL(), OTHER());
    expect(getClubPick()).toEqual({ picking: false, places: [] });
  });

  test("one row is not a club — and the bar stays up asking for the second", () => {
    beginClubPick();
    toggleClubPick(LOCAL());
    expect(canOpenClubPick()).toBe(false);
    expect(openPickedClub()).toBeNull();
    // The answer to "you only chose one" is the gesture still asking, not the
    // gesture vanishing and the user starting over.
    expect(getClubPick().picking).toBe(true);
    expect(getClubPick().places).toHaveLength(1);
    expect(listClubs()).toHaveLength(0);
  });

  test("clicking a picked row again drops it — the mark is a checkbox", () => {
    beginClubPick();
    toggleClubPick(LOCAL());
    expect(isPickedPlace(LOCAL())).toBe(true);
    toggleClubPick(LOCAL());
    expect(isPickedPlace(LOCAL())).toBe(false);
    expect(getClubPick().places).toHaveLength(0);
  });

  test("a row is picked by its key, however the row spells it", () => {
    beginClubPick();
    toggleClubPick(localPlace(`${LOCAL_ROOT}/`));
    // Same checkout, trailing slash — the rail must not offer to club a place
    // with itself.
    expect(isPickedPlace(LOCAL())).toBe(true);
    expect(isPickedPlace(LOCAL_ROOT)).toBe(true);
    expect(isPickedPlace(OTHER())).toBe(false);
  });

  test("the gesture can start from the row you are on", () => {
    // The roster's "Put side by side…" — this copy is in, the bar comes up,
    // and the rail asks for the other place.
    beginClubPick(LOCAL());
    expect(getClubPick().picking).toBe(true);
    expect(getClubPick().places.map(placeKey)).toEqual([LOCAL_ROOT]);
    toggleClubPick(ON_A());
    expect(canOpenClubPick()).toBe(true);
  });

  test("cancelling makes nothing", () => {
    beginClubPick();
    toggleClubPick(LOCAL());
    toggleClubPick(OTHER());
    cancelClubPick();
    expect(getClubPick()).toEqual({ picking: false, places: [] });
    expect(listClubs()).toHaveLength(0);
  });

  test("picking the same two rows again is the club you already have", () => {
    const first = clubFromRows(LOCAL(), ON_A())!;
    const again = clubFromRows(ON_A(), LOCAL())!;
    expect(again.id).toBe(first.id);
    expect(listClubs()).toHaveLength(1);
  });

  test("a second arrangement does not cost the first", () => {
    const first = clubFromRows(LOCAL(), OTHER())!;
    const second = clubFromRows(LOCAL(), ON_A())!;
    expect(second.id).not.toBe(first.id);
    expect(listClubs().map((c) => c.id)).toEqual([first.id, second.id]);
    expect(clubSlotKey(first.id)).not.toBe(clubSlotKey(second.id));
  });

  test("the rail hears the pick move, row by row", () => {
    // What the bar subscribes to. A chip list that repaints on the first click
    // and not the second is a bar that lies about what it is about to open.
    const seen: number[] = [];
    const stop = subscribeClubPick(() => seen.push(getClubPick().places.length));
    beginClubPick();
    toggleClubPick(LOCAL());
    toggleClubPick(OTHER());
    openPickedClub();
    stop();
    toggleClubPick(ON_A());
    expect(seen).toEqual([0, 1, 2, 0]);
  });
});

describe("a rail row enters the club", () => {
  test("entering makes it the club being viewed", () => {
    const club = clubFromRows(LOCAL(), OTHER())!;
    expect(getActiveClub()).toBeNull();
    expect(enterClubFromRail(club.id)?.id).toBe(club.id);
    expect(getActiveClub()?.id).toBe(club.id);
  });

  test("entering a club puts away a pick you were in the middle of", () => {
    const club = clubFromRows(LOCAL(), OTHER())!;
    beginClubPick(ON_A());
    enterClubFromRail(club.id);
    expect(getClubPick().picking).toBe(false);
  });

  test("a row naming a club that is gone changes nothing", () => {
    const club = clubFromRows(LOCAL(), OTHER())!;
    enterClubFromRail(club.id);
    expect(enterClubFromRail("club-nope")).toBeNull();
    expect(getActiveClub()?.id).toBe(club.id);
  });

  test("entering the second club leaves the first standing", () => {
    const first = clubFromRows(LOCAL(), OTHER())!;
    const second = clubFromRows(ON_A(), ON_B())!;
    enterClubFromRail(first.id);
    enterClubFromRail(second.id);
    expect(getActiveClub()?.id).toBe(second.id);
    expect(getClub(first.id)).not.toBeNull();
  });
});

describe("leaving gives every member its own state back", () => {
  test("leaving stands the window in a single place again, club intact", () => {
    const club = clubFromRows(LOCAL(), ON_A())!;
    enterClubFromRail(club.id);
    leaveClub();
    expect(getActiveClub()).toBeNull();
    // Left, not dissolved — the arrangement is still on the rail to re-enter.
    expect(getClub(club.id)?.members).toHaveLength(2);
  });

  test("what you opened while clubbed lands in the club's own slot, not a member's", () => {
    saveSnapshot(LOCAL_ROOT, {
      ...emptySnapshot(),
      filePaths: ["src/App.tsx"],
    });
    saveSnapshot(placeKey(ON_A()), {
      ...emptySnapshot(),
      filePaths: ["crates/runner/src/main.rs"],
    });
    const club = clubFromRows(LOCAL(), ON_A())!;
    enterClubFromRail(club.id);

    // Standing in the club, the user opens a third file. editorStore parks it
    // under the club's key — see `clubPlaceKey` / `saveClubSnapshot`.
    saveClubSnapshot(club.id, {
      ...emptySnapshot(),
      filePaths: ["src/App.tsx", "crates/runner/src/main.rs", "deploy/stage.yaml"],
    });
    leaveClub();

    // Each member is exactly where it was left. This is the whole promise of
    // leaving: a club is a viewing mode, not a merge.
    expect(loadSnapshot(LOCAL_ROOT)?.filePaths).toEqual(["src/App.tsx"]);
    expect(loadSnapshot(placeKey(ON_A()))?.filePaths).toEqual([
      "crates/runner/src/main.rs",
    ]);
    expect(loadClubSnapshot(club.id)?.filePaths).toHaveLength(3);
  });

  test("re-entering picks the club up where it was left", () => {
    const club = clubFromRows(LOCAL(), OTHER())!;
    enterClubFromRail(club.id);
    saveClubSnapshot(club.id, {
      ...emptySnapshot(),
      filePaths: ["src/both.ts"],
    });
    leaveClub();
    enterClubFromRail(club.id);
    expect(loadClubSnapshot(club.id)?.filePaths).toEqual(["src/both.ts"]);
  });

  test("the club survives a relaunch, and so does the one you were in", () => {
    const club = clubFromRows(LOCAL(), ON_A())!;
    enterClubFromRail(club.id);
    reloadClubs(); // the relaunch
    expect(listClubs()).toHaveLength(1);
    expect(getActiveClub()?.id).toBe(club.id);
    setActiveClub(null);
  });
});

describe("a machine in the club is just another row", () => {
  test("a checkout plus a box makes a club the same way two checkouts do", () => {
    const locals = clubFromRows(LOCAL(), OTHER())!;
    const mixed = clubFromRows(LOCAL(), ON_A())!;
    // Same shape, made by the same three calls — the only difference is which
    // computer the second member is on.
    expect(mixed.members).toHaveLength(locals.members.length);
    expect(new Set(clubMemberKeys(mixed)).size).toBe(2);
    expect(clubMemberKeys(mixed)[1]).not.toBe(clubMemberKeys(locals)[1]);
  });

  test("entering unions the laptop's tabs with the box's, through one call per member", () => {
    saveSnapshot(placeKey(LOCAL()), {
      ...emptySnapshot(),
      filePaths: ["src/App.tsx"],
    });
    saveSnapshot(placeKey(ON_A()), {
      ...emptySnapshot(),
      filePaths: ["crates/runner/src/main.rs"],
    });
    const club = clubFromRows(LOCAL(), ON_A())!;
    // Exactly what editorStore's `enterClub` does with `clubMemberKeys`: read
    // each member's slot, union them. Both kinds go through the same two
    // calls, which is the claim.
    const parts = clubMemberKeys(club)
      .map((k) => loadSnapshot(k))
      .filter((s): s is NonNullable<typeof s> => !!s);
    expect(parts).toHaveLength(2);
    expect(unionSnapshots(parts).filePaths).toEqual([
      "src/App.tsx",
      "crates/runner/src/main.rs",
    ]);
  });

  test("two boxes need no local member at all", () => {
    const club = clubFromRows(ON_A(), ON_B());
    expect(club).not.toBeNull();
    expect(enterClubFromRail(club!.id)?.id).toBe(club!.id);
    leaveClub();
  });

  test("leaving a mixed club restores the box's tabs exactly as it restores the laptop's", () => {
    saveSnapshot(LOCAL_ROOT, { ...emptySnapshot(), filePaths: ["a.ts"] });
    saveSnapshot(placeKey(ON_B()), { ...emptySnapshot(), filePaths: ["b.rs"] });
    const club = clubFromRows(LOCAL(), ON_B())!;
    enterClubFromRail(club.id);
    saveClubSnapshot(club.id, { ...emptySnapshot(), filePaths: ["a.ts", "b.rs"] });
    leaveClub();
    expect(loadSnapshot(LOCAL_ROOT)?.filePaths).toEqual(["a.ts"]);
    expect(loadSnapshot(placeKey(ON_B()))?.filePaths).toEqual(["b.rs"]);
  });
});

describe("what a club row says", () => {
  test("a local place is called by its project", () => {
    expect(placeLabel(LOCAL())).toBe("aura");
  });

  test("a remote place says which computer it is on", () => {
    // The box is the whole reason it is in the club; the `ubuntu@` half is the
    // same on every machine and buys nothing in a 232px rail.
    expect(placeLabel(ON_A())).toBe("aura on 18.196.118.42");
    expect(placeLabel(remotePlace({ machineId: BOX_A }))).toBe(
      "18.196.118.42",
    );
  });

  test("a conversation with no box yet is still nameable", () => {
    expect(
      placeLabel(remotePlace({ threadKey: "thread-7", repoRoot: LOCAL_ROOT })),
    ).toBe("aura in the cloud");
    expect(placeLabel(remotePlace({ threadKey: "thread-7" }))).toBe(
      "a cloud conversation",
    );
  });

  test("the row names both places, and counts the rest", () => {
    const two = clubFromRows(LOCAL(), OTHER())!;
    expect(clubLabel(two)).toBe("aura · aura-web");
    const three = clubFromRows(LOCAL(), OTHER(), ON_A())!;
    expect(clubLabel(three)).toBe("aura · aura-web +1");
    // The tooltip has room for all of them.
    expect(clubMembersLine(three)).toBe(
      "aura · aura-web · aura on 18.196.118.42",
    );
  });
});

describe("the rail is wired to it", () => {
  test("every place row in the roster answers the pick", async () => {
    const src = await readSrc("components/WorkspaceRoster.tsx");
    // One helper, three row types — a row that opted out of the gesture would
    // make it "click two rows, unless one of them is a machine".
    expect(src).toContain("const { picking } = useClubPick();");
    expect(src).toContain("pickRow(localPlace(w.path))");
    // Both remote rows build their place ONCE and hand that one value to the
    // pick — the row's own menu pops the same place out into its own window, and
    // a second spelling of "which place is this row" is how the two would drift.
    // `machineId` rather than `m.id`: the row is handed a `Place` now, and the
    // id is pulled off it ONCE at the top — a row without an address is this
    // laptop and doesn't belong in this group at all.
    expect(src).toContain("const machineId = p.machineId;");
    expect(src).toContain("remotePlace({ machineId, repoRoot })");
    expect(src).toContain("threadKey: thread.key,");
    expect(src).toContain("repoRoot: thread.repoRoot,");
    expect(src.match(/pickRow\(place\)/g) ?? []).toHaveLength(2);
    expect(src).toContain("toggleClubPick(ref)");
    expect(src).toContain("isPickedPlace(ref)");
    // Three rows, three activations — clicking a row while picking must never
    // navigate away from the list you are picking in.
    const activations = src.match(/picking \? toggle\(\)/g) ?? [];
    expect(activations).toHaveLength(3);
  });

  test("the gesture is discoverable, not a shortcut you have to know", async () => {
    const rail = await readSrc("components/places/ClubRail.tsx");
    const roster = await readSrc("components/WorkspaceRoster.tsx");
    // The door is on the project row, where your finger already is. The rail
    // is where the result lands — it is not the advert for it.
    expect(roster).toContain("beginClubPick(localPlace(menu.path))");
    expect(roster).toContain("Put side by side…");
    // The rail still names itself, and still offers a control once it is on
    // screen at all — but only then.
    expect(rail).toContain("Side by side");
    expect(rail).toContain("onBeginPick");
  });

  test("an empty side-by-side group is not drawn at all", async () => {
    const rail = await readSrc("components/places/ClubRail.tsx");
    // A rail is a list of where you can stand. Standing nowhere side by side,
    // the honest length of that list is zero — not a three-line pitch and a
    // button sitting above the projects you actually use.
    expect(rail).toContain(
      "if (clubs.length === 0 && !pick.picking) return null;",
    );
    expect(rail).not.toContain("Nothing side by side yet.");
    expect(rail).not.toContain("Pick two places");
    // …and it comes straight back the moment a pick starts, so the row menu's
    // door still leads somewhere.
    expect(rail).toContain("pick.picking && (");
  });

  test("the rail draws the states that are real once it is on screen", async () => {
    const rail = await readSrc("components/places/ClubRail.tsx");
    // Loading: entering can mean opening a project off disk. One block loader
    // for the whole app.
    expect(rail).toContain("AsciiSpinner");
    // Error: what went wrong, and another go.
    expect(rail).toContain("Try again");
    expect(rail).toContain("Couldn’t open");
    // A club is not a wizard: no title bar, no surface header.
    expect(rail).not.toContain("SurfaceHeader");
  });

  test("the club is entered before the store says you are in it", async () => {
    const mount = await readSrc("components/places/ClubRailMount.tsx");
    // A row lit over a screen that never changed is the failure the loading +
    // error states exist to prevent, and the order is what enforces it.
    const awaited = mount.indexOf("await onEnter(clubId)");
    const marked = mount.indexOf("enterClubFromRail(clubId)");
    expect(awaited).toBeGreaterThan(-1);
    expect(marked).toBeGreaterThan(awaited);
    expect(mount).toContain("setEntering(clubId)");
    expect(mount).toContain("setError({");
    // Dissolving the club you are standing in leaves it first.
    expect(mount).toContain("if (clubId === activeClubId) onLeave();");
  });

  test("App enters the club and can still leave it", async () => {
    const app = await readSrc("App.tsx");
    expect(app).toContain("<ClubRailMount");
    expect(app).toContain("editorRef.current.enterClub(");
    expect(app).toContain("clubMemberKeys(club),");
    // Leaving, both ways in: the rail row's own leave…
    expect(app).toContain("editorRef.current.exitClub(back);");
    // …and the roster's, which is the path that predates this change.
    expect(app).toContain("editor.exitClub(id);");
    expect(app).toContain("setActiveClub(null);");
  });

  test("leaving hands each member back its own live state", async () => {
    const src = await readSrc("lib/editorStore.ts");
    // The claim the App calls rest on: exiting focuses the place being landed
    // in, and the club's tabs go to the club's own slot.
    expect(src).toContain("function exitClub(next: string): WorkspaceSwitch");
    expect(src).toContain("saveClubSnapshot(leaving, buildSnapshotFromState(state));");
    expect(src).toContain("const live = places.focus(next);");
  });

  test("the pick wears Aura's own green, and never the agent orange", async () => {
    const css = await readSrc("styles.css");
    expect(css).toContain(".ade-wrow.picked");
    expect(css).toContain(
      "background: color-mix(in srgb, var(--color-accent-green) 14%, transparent);",
    );
    // The block this feature owns, checked for the one colour it must not use:
    // orange is the agent brand.
    const block = css.slice(css.indexOf(".ade-wrow.picked"), css.indexOf(".club-dot.remote"));
    expect(block).not.toContain("orange");
    expect(block.toLowerCase()).not.toContain("#f");
  });
});

// Clubbing, for any set of places.
//
//   bun test
//
// A club is the escape hatch from one-place-at-a-time: two things you are
// genuinely working across, shown side by side, without paying the switch cost
// every time you look at the other one. v1 shipped it with two caps written
// into the store as if they were design:
//
//   1. "One club at a time in v1." Two-club scenarios were said to add UI
//      complexity — which club is active? what's the tile? — that didn't pay
//      off. Those questions have the same answers a second project has, and
//      the rest of the window had already answered them: the active one is the
//      one you clicked, and the tile is its own.
//
//   2. Members were a `Set<repoRoot>`. A machine cannot be a repo root, so a
//      machine could not join a club — and "my backend checkout beside the
//      runner it deploys to" is the request that makes clubbing worth having
//      at all. That is a feature landing in one place-mode only, which is the
//      one thing this programme does not allow.
//
// So this file is the gate on both, plus the third thing a club has to do to
// be real: survive a relaunch. It runs the actual modules — `placeRef`,
// `workspaceClubStore` and `workspaceSnapshot` are pure over `localStorage`
// and load fine under bun. `editorStore` cannot (it imports Tauri, React and
// xterm), so the part of the contract that lives there — one live-state key
// and one tab slot PER CLUB, not one for all of them — is pinned by source.

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
  MIN_CLUB_MEMBERS,
  addToClub,
  clubMemberKeys,
  clubWith,
  clubsForPlace,
  createClub,
  dissolveClub,
  getActiveClub,
  getClub,
  getClubState,
  listClubs,
  reloadClubs,
  removeFromClub,
  setActiveClub,
  subscribeClub,
} = await import("../src/lib/workspaceClubStore");

const {
  isLocalPlace,
  isRemotePlace,
  localPlace,
  parsePlaceRef,
  placeKey,
  placeMachineId,
  placeRepoRoot,
  remotePlace,
  samePlaceRef,
} = await import("../src/lib/placeRef");

const {
  clubSlotKey,
  emptySnapshot,
  loadClubSnapshot,
  loadSnapshot,
  saveClubSnapshot,
  saveSnapshot,
  unionSnapshots,
} = await import("../src/lib/workspaceSnapshot");

const { remotePlaceKey } = await import("../src/lib/remotePlaces");

// Two boxes and a laptop — the shape the acceptance criterion names.
const BOX_A = "ubuntu@18.196.118.42";
const BOX_B = "ubuntu@3.122.52.150";
const LOCAL_ROOT = "/Users/mo/src/aura";
const OTHER_ROOT = "/Users/mo/src/aura-web";

/** A fresh boot: nothing this feature owns is on disk, and the store re-reads.
 *  Only our own keys, because every test file shares one process and one
 *  Storage — clearing it wholesale would reach into a neighbour's fixtures. */
function freshBoot(): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.startsWith("aura.workspaceClub") || k.startsWith("aura.workspaceSnapshot"))
      doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
  reloadClubs();
}

const LOCAL = () => localPlace(LOCAL_ROOT);
const OTHER = () => localPlace(OTHER_ROOT);
const ON_A = () => remotePlace({ machineId: BOX_A, repoRoot: LOCAL_ROOT });
const ON_B = () => remotePlace({ machineId: BOX_B, repoRoot: LOCAL_ROOT });

beforeEach(() => {
  freshBoot();
});

describe("the one-club-at-a-time cap is gone", () => {
  test("two clubs exist at once, each with its own id", () => {
    const first = createClub([LOCAL(), OTHER()]);
    const second = createClub([LOCAL(), ON_A()]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
    expect(listClubs().map((c) => c.id)).toEqual([first!.id, second!.id]);
  });

  test("making a second club does not dissolve the first", () => {
    const first = createClub([LOCAL(), OTHER()])!;
    createClub([ON_A(), ON_B()]);
    expect(getClub(first.id)?.members).toHaveLength(2);
  });

  test("entering the second club leaves the first standing", () => {
    const first = createClub([LOCAL(), OTHER()])!;
    const second = createClub([ON_A(), ON_B()])!;
    setActiveClub(first.id);
    expect(getActiveClub()?.id).toBe(first.id);
    setActiveClub(second.id);
    expect(getActiveClub()?.id).toBe(second.id);
    // The point of the cap's removal: the one you stepped off is still there.
    expect(getClub(first.id)).not.toBeNull();
    expect(listClubs()).toHaveLength(2);
  });

  test("each club gets its own tab slot, so one never shows the other's tabs", () => {
    const first = createClub([LOCAL(), OTHER()])!;
    const second = createClub([ON_A(), ON_B()])!;
    expect(clubSlotKey(first.id)).not.toBe(clubSlotKey(second.id));
    saveClubSnapshot(first.id, {
      ...emptySnapshot(),
      filePaths: ["src/first.ts"],
    });
    saveClubSnapshot(second.id, {
      ...emptySnapshot(),
      filePaths: ["src/second.ts"],
    });
    expect(loadClubSnapshot(first.id)?.filePaths).toEqual(["src/first.ts"]);
    expect(loadClubSnapshot(second.id)?.filePaths).toEqual(["src/second.ts"]);
  });

  test("a place may belong to two clubs — frontend+backend and frontend+design", () => {
    const backend = createClub([LOCAL(), OTHER()])!;
    const runner = createClub([LOCAL(), ON_A()])!;
    const holding = clubsForPlace(LOCAL()).map((c) => c.id);
    expect(holding).toEqual([backend.id, runner.id]);
  });

  test("asking twice for the same arrangement is the same club, not a copy", () => {
    const first = createClub([LOCAL(), ON_A()])!;
    // Same set, other order — a set is a set.
    const again = createClub([ON_A(), LOCAL()])!;
    expect(again.id).toBe(first.id);
    expect(listClubs()).toHaveLength(1);
  });

  test("one place is not a club", () => {
    expect(createClub([LOCAL()])).toBeNull();
    expect(createClub([LOCAL(), localPlace(`${LOCAL_ROOT}/`)])).toBeNull();
    expect(MIN_CLUB_MEMBERS).toBe(2);
    expect(listClubs()).toHaveLength(0);
  });
});

describe("a club spans this laptop and the machines, together", () => {
  test("two machines and one local checkout are one club", () => {
    const club = createClub([ON_A(), ON_B(), LOCAL()]);
    expect(club).not.toBeNull();
    expect(club!.members).toHaveLength(3);
    // Three distinct places, not one machine row and a laptop row that
    // collapsed into each other.
    expect(new Set(clubMemberKeys(club!)).size).toBe(3);
  });

  test("a local member's key IS its repo root, so it finds tabs written before machines existed", () => {
    // The historic spelling. A club member that needed translating to find its
    // own snapshot is a club member whose tabs come back empty.
    expect(placeKey(LOCAL())).toBe(LOCAL_ROOT);
    saveSnapshot(LOCAL_ROOT, { ...emptySnapshot(), filePaths: ["src/App.tsx"] });
    expect(loadSnapshot(placeKey(LOCAL()))?.filePaths).toEqual(["src/App.tsx"]);
  });

  test("a remote member's key is the machine's own, and cannot collide with a path", () => {
    expect(placeKey(ON_A())).toBe(
      remotePlaceKey({ machineId: BOX_A, repoRoot: LOCAL_ROOT }),
    );
    expect(placeKey(ON_A())).not.toBe(placeKey(LOCAL()));
    // A repo root is an absolute path; a remote key names its kind first.
    expect(placeKey(LOCAL()).startsWith("/")).toBe(true);
    expect(placeKey(ON_A()).startsWith("machine")).toBe(true);
  });

  test("the same box holding two projects is two members", () => {
    const club = createClub([
      remotePlace({ machineId: BOX_A, repoRoot: LOCAL_ROOT }),
      remotePlace({ machineId: BOX_A, repoRoot: OTHER_ROOT }),
    ]);
    expect(club!.members).toHaveLength(2);
  });

  test("one checkout spelled two ways is one member", () => {
    const club = createClub([
      localPlace(LOCAL_ROOT),
      localPlace(`${LOCAL_ROOT}/`),
      OTHER(),
    ]);
    expect(clubMemberKeys(club!)).toEqual([LOCAL_ROOT, OTHER_ROOT]);
  });

  test("entering the club unions tabs from the laptop AND both boxes", () => {
    // This is what `enterClub` does with `clubMemberKeys`: read each member's
    // slot and union them. Every member goes through the SAME two calls,
    // whichever computer it is on — which is the whole claim of the task.
    const club = createClub([LOCAL(), ON_A(), ON_B()])!;
    saveSnapshot(placeKey(LOCAL()), {
      ...emptySnapshot(),
      filePaths: ["src/App.tsx"],
    });
    saveSnapshot(placeKey(ON_A()), {
      ...emptySnapshot(),
      filePaths: ["crates/runner/src/main.rs"],
    });
    saveSnapshot(placeKey(ON_B()), {
      ...emptySnapshot(),
      filePaths: ["deploy/stage.yaml"],
    });
    const parts = clubMemberKeys(club)
      .map((k) => loadSnapshot(k))
      .filter((s): s is NonNullable<typeof s> => !!s);
    expect(parts).toHaveLength(3);
    expect(unionSnapshots(parts).filePaths).toEqual([
      "src/App.tsx",
      "crates/runner/src/main.rs",
      "deploy/stage.yaml",
    ]);
  });

  test("a machine can be clubbed with a machine — no local member required", () => {
    const club = clubWith(ON_A(), ON_B());
    expect(club).not.toBeNull();
    expect(getActiveClub()?.id).toBe(club!.id);
  });
});

describe("clubs survive a restart", () => {
  test("every club, its members and the one being viewed come back", () => {
    const first = createClub([LOCAL(), OTHER()])!;
    const second = createClub([ON_A(), ON_B(), LOCAL()])!;
    setActiveClub(second.id);

    reloadClubs(); // the relaunch

    expect(listClubs().map((c) => c.id)).toEqual([first.id, second.id]);
    expect(getActiveClub()?.id).toBe(second.id);
    expect(clubMemberKeys(getClub(second.id)!)).toEqual([
      placeKey(ON_A()),
      placeKey(ON_B()),
      placeKey(LOCAL()),
    ]);
  });

  test("a remote member comes back re-openable, not as an opaque key", () => {
    const club = createClub([ON_A(), LOCAL()])!;
    reloadClubs();
    const back = getClub(club.id)!.members[0]!;
    expect(back.kind).toBe("remote");
    // The box is still nameable — a key you can't parse back is a club member
    // you can't walk into after a relaunch.
    expect(back.kind === "remote" ? back.machineId : null).toBe(BOX_A);
    expect(back.repoRoot).toBe(LOCAL_ROOT);
  });

  test("the tabs opened while standing in a club come back with it", () => {
    const club = createClub([LOCAL(), ON_A()])!;
    saveClubSnapshot(club.id, {
      ...emptySnapshot(),
      filePaths: ["src/App.tsx", "crates/runner/src/main.rs"],
    });
    reloadClubs();
    expect(loadClubSnapshot(getClub(club.id)!.id)?.filePaths).toEqual([
      "src/App.tsx",
      "crates/runner/src/main.rs",
    ]);
  });

  test("the v1 club is carried forward — members and tabs", () => {
    freshBoot();
    // Exactly what v1 wrote: one club, bare roots, one un-suffixed tab slot.
    localStorage.setItem(
      "aura.workspaceClub.v1",
      JSON.stringify({ members: [LOCAL_ROOT, OTHER_ROOT], active: true }),
    );
    localStorage.setItem(
      "aura.workspaceSnapshot.__club__",
      JSON.stringify({ ...emptySnapshot(), filePaths: ["src/legacy.ts"] }),
    );

    reloadClubs();

    const clubs = listClubs();
    expect(clubs).toHaveLength(1);
    expect(clubMemberKeys(clubs[0]!)).toEqual([LOCAL_ROOT, OTHER_ROOT]);
    expect(clubs[0]!.members.every((m) => m.kind === "local")).toBe(true);
    expect(getActiveClub()?.id).toBe(clubs[0]!.id);
    // Its tabs moved onto the migrated id rather than being stranded.
    expect(loadClubSnapshot(clubs[0]!.id)?.filePaths).toEqual(["src/legacy.ts"]);
    // And the migration is idempotent — a second boot doesn't mint a twin.
    reloadClubs();
    expect(listClubs()).toHaveLength(1);
  });

  test("a v1 club of fewer than two roots doesn't come back as a club", () => {
    freshBoot();
    localStorage.setItem(
      "aura.workspaceClub.v1",
      JSON.stringify({ members: [LOCAL_ROOT], active: true }),
    );
    reloadClubs();
    expect(listClubs()).toHaveLength(0);
  });

  test("a club whose members no longer parse doesn't come back one-legged", () => {
    freshBoot();
    localStorage.setItem(
      "aura.workspaceClub.v2",
      JSON.stringify({
        seq: 4,
        activeClubId: "club-4",
        clubs: [
          {
            id: "club-4",
            members: [{ kind: "local", repoRoot: LOCAL_ROOT }, { kind: "nonsense" }],
          },
        ],
      }),
    );
    reloadClubs();
    expect(listClubs()).toHaveLength(0);
    expect(getActiveClub()).toBeNull();
  });

  test("a corrupt blob is no clubs, not a crash", () => {
    freshBoot();
    localStorage.setItem("aura.workspaceClub.v2", "{not json");
    reloadClubs();
    expect(listClubs()).toEqual([]);
  });
});

describe("membership", () => {
  test("dropping to one member auto-dissolves — a club of one is just that place", () => {
    const club = createClub([LOCAL(), ON_A()])!;
    setActiveClub(club.id);
    removeFromClub(club.id, ON_A());
    expect(listClubs()).toHaveLength(0);
    expect(getActiveClub()).toBeNull();
  });

  test("dropping a member from a club of three keeps the club", () => {
    const club = createClub([LOCAL(), ON_A(), ON_B()])!;
    removeFromClub(club.id, placeKey(ON_B()));
    expect(clubMemberKeys(getClub(club.id)!)).toEqual([
      placeKey(LOCAL()),
      placeKey(ON_A()),
    ]);
  });

  test("a dissolved club takes its tab slot with it", () => {
    const club = createClub([LOCAL(), ON_A()])!;
    saveClubSnapshot(club.id, { ...emptySnapshot(), filePaths: ["src/x.ts"] });
    dissolveClub(club.id);
    expect(loadClubSnapshot(club.id)).toBeNull();
  });

  test("ids are never recycled, so a new club can't inherit a stranger's tabs", () => {
    const first = createClub([LOCAL(), OTHER()])!;
    dissolveClub(first.id);
    const second = createClub([ON_A(), ON_B()])!;
    expect(second.id).not.toBe(first.id);
  });

  test("adding a place twice doesn't reshuffle the rail", () => {
    const club = createClub([LOCAL(), ON_A()])!;
    addToClub(club.id, ON_B());
    addToClub(club.id, localPlace(`${LOCAL_ROOT}/`));
    expect(clubMemberKeys(getClub(club.id)!)).toEqual([
      placeKey(LOCAL()),
      placeKey(ON_A()),
      placeKey(ON_B()),
    ]);
  });

  test("activating a club that doesn't exist changes nothing", () => {
    const club = createClub([LOCAL(), ON_A()])!;
    setActiveClub(club.id);
    setActiveClub("club-nope");
    expect(getActiveClub()?.id).toBe(club.id);
  });

  test("the drag gesture extends the club the place is already in", () => {
    const club = clubWith(LOCAL(), ON_A())!;
    const same = clubWith(LOCAL(), ON_B())!;
    expect(same.id).toBe(club.id);
    expect(clubMemberKeys(same)).toHaveLength(3);
    expect(listClubs()).toHaveLength(1);
  });

  test("dragging the same pair together twice just re-enters that club", () => {
    const club = clubWith(LOCAL(), ON_A())!;
    setActiveClub(null);
    const again = clubWith(ON_A(), LOCAL())!;
    expect(again.id).toBe(club.id);
    expect(getActiveClub()?.id).toBe(club.id);
  });

  test("dragging a place onto itself is not a club", () => {
    expect(clubWith(LOCAL(), localPlace(`${LOCAL_ROOT}/`))).toBeNull();
    expect(listClubs()).toHaveLength(0);
  });

  test("the rail hears every move — creating, joining and entering", () => {
    // What App subscribes to. A tile that repaints on membership but not on
    // entry is the tile that stays lit on the club you just left.
    const seen: Array<[number, string | null]> = [];
    const stop = subscribeClub(() => {
      const s = getClubState();
      seen.push([s.clubs.length, s.activeClubId]);
    });
    const club = createClub([LOCAL(), ON_A()])!;
    addToClub(club.id, ON_B());
    setActiveClub(club.id);
    stop();
    createClub([OTHER(), ON_B()]);
    expect(seen).toEqual([
      [1, null],
      [1, null],
      [1, club.id],
    ]);
  });
});

describe("a place off disk", () => {
  test("a bare string is v1's local root, not a dropped member", () => {
    expect(parsePlaceRef(LOCAL_ROOT)).toEqual(localPlace(LOCAL_ROOT));
  });

  test("a remote place naming nothing at all is dropped", () => {
    // `remotePlaceKey` hands every such member the same wildcard key, so a
    // club of them would collapse into one row.
    expect(parsePlaceRef({ kind: "remote" })).toBeNull();
    expect(parsePlaceRef({ kind: "remote", machineId: "  " })).toBeNull();
  });

  test("a conversation with no box yet is still a place", () => {
    const ref = parsePlaceRef({ kind: "remote", threadKey: "thread-7" });
    expect(ref).not.toBeNull();
    expect(placeKey(ref!)).toBe(remotePlaceKey({ threadKey: "thread-7" }));
  });
});

describe("what a club row can ask a member", () => {
  // A club draws one row per member, and the row has to say what it is
  // WITHOUT knowing which of the two kinds it got — that branch existing in
  // the rail is how the local half and the remote half drift apart again.
  test("a member says which computer it is on — null meaning this laptop", () => {
    expect(placeMachineId(LOCAL())).toBeNull();
    expect(placeMachineId(ON_A())).toBe(BOX_A);
  });

  test("both kinds name the project their board and intent log belong to", () => {
    expect(placeRepoRoot(LOCAL())).toBe(LOCAL_ROOT);
    expect(placeRepoRoot(ON_A())).toBe(LOCAL_ROOT);
    // Entered from the fleet, no project resolved yet — a place, with nothing
    // to point a board at.
    expect(placeRepoRoot(remotePlace({ machineId: BOX_A }))).toBeNull();
  });

  test("the two kinds are told apart by the ref, not by guessing at the key", () => {
    expect(isLocalPlace(LOCAL())).toBe(true);
    expect(isRemotePlace(LOCAL())).toBe(false);
    expect(isRemotePlace(ON_A())).toBe(true);
    expect(isLocalPlace(ON_A())).toBe(false);
  });

  test("the same place spelled two ways is one place", () => {
    expect(samePlaceRef(LOCAL(), localPlace(`${LOCAL_ROOT}/`))).toBe(true);
    expect(
      samePlaceRef(ON_A(), remotePlace({ machineId: BOX_A, repoRoot: `${LOCAL_ROOT}/` })),
    ).toBe(true);
    expect(samePlaceRef(LOCAL(), ON_A())).toBe(false);
    expect(samePlaceRef(ON_A(), ON_B())).toBe(false);
  });
});

describe("editorStore gives each club its own place, not one club-shaped hole", () => {
  test("the live-state key and the tab slot are per club", async () => {
    const src = await readSrc("lib/editorStore.ts");
    // A single module-level constant was the shape that made two clubs
    // impossible: both would have parked under it.
    expect(src).not.toContain("const CLUB_PLACE");
    expect(src).toContain("function clubPlaceKey(clubId: string): string");
    expect(src).toContain("let clubbedId: string | null = null;");
    expect(src).toContain("places.focus(clubPlaceKey(clubId))");
    expect(src).toContain("saveClubSnapshot(clubId, club)");
  });

  test("entering names which club, and takes place keys as members", async () => {
    const src = await readSrc("lib/editorStore.ts");
    expect(src).toContain(
      "function enterClub(prev: string | null, clubId: string, members: string[])",
    );
    expect(src).toContain("let club = loadClubSnapshot(clubId);");
    // `members` are place keys, so the member read is one call for both kinds.
    expect(src).toContain(".map((m) => loadSnapshot(m))");
  });

  test("leaving parks the club it was actually in", async () => {
    const src = await readSrc("lib/editorStore.ts");
    expect(src).toContain("const leaving = clubbedId;");
    expect(src).toContain("saveClubSnapshot(leaving, buildSnapshotFromState(state));");
  });
});

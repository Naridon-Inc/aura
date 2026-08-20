// Opening a second project used to cost you the first one.
//
//   bun test
//
// `editorStore` kept ONE module-level `state`. `switchWorkspace` wiped it to
// defaults and rebuilt from the incoming place's on-disk snapshot. A snapshot
// is a summary — tab identities, paths, which pane was active — so everything
// that isn't summarisable did not survive the round trip:
//
//   - unsaved buffers, because the snapshot stores a path and openFile
//     re-reads disk;
//   - the diff baseline, for the same reason;
//   - agent tabs' liveness, because a restore can only assume "off disk,
//     therefore cold" and stamps every one of them dormant.
//
// And it happened in both directions: switching back to the first project ran
// the same wipe against the second. Two projects open meant neither of them
// was really open.
//
// The fix is a registry of live states keyed by place, and a switch that
// FOCUSES one. This file pins the registry's behaviour directly (it is
// generic and free of React/Tauri, so it can actually be run rather than
// scanned) and pins the store + App wiring by source, since neither can be
// imported under bun.

import { describe, expect, test } from "bun:test";

import { createPlaceRegistry, DEFAULT_LIVE_PLACE_LIMIT } from "../src/lib/placeStates";
import { readSrc } from "./support/code";

/** A stand-in for the store's `State`: the parts a snapshot loses. */
type Doc = { path: string; baseline: string; current: string };
type Place = { files: Doc[]; activePath: string | null };

const clean = (path: string, text: string): Doc => ({
  path,
  baseline: text,
  current: text,
});
const edited = (path: string, was: string, now: string): Doc => ({
  path,
  baseline: was,
  current: now,
});
const dirty = (p: Place) => p.files.some((f) => f.current !== f.baseline);

const A = "/Users/me/projects/alpha";
const B = "/Users/me/projects/beta";

const store = await readSrc("lib/editorStore.ts");
const app = await readSrc("App.tsx");

describe("two places, both open", () => {
  test("switching back hands the same state back, not a rebuild of it", () => {
    const places = createPlaceRegistry<Place>();

    // Edit in A, switch to B, edit in B, switch back to A.
    const inA: Place = {
      files: [edited(`${A}/src/main.rs`, "fn main() {}", "fn main() { work() }")],
      activePath: `${A}/src/main.rs`,
    };
    places.park(A, inA);

    const inB: Place = {
      files: [edited(`${B}/README.md`, "# beta", "# beta\n\nnotes")],
      activePath: `${B}/README.md`,
    };
    places.park(B, inB);

    const backToA = places.focus(A);
    // Identity, not equality: a focus returns the live object. Anything that
    // merely LOOKS the same is a rebuild, and a rebuild is what lost the edit.
    expect(backToA).toBe(inA);
    expect(backToA?.files[0].current).toBe("fn main() { work() }");
    expect(backToA?.activePath).toBe(`${A}/src/main.rs`);

    // …and B is untouched by A's return trip. The old wipe ran in both
    // directions; this is the second half of the regression.
    expect(places.focus(B)).toBe(inB);
    expect(places.peek(B)?.files[0].current).toBe("# beta\n\nnotes");
  });

  test("a place never opened this session is a miss — hydrate it", () => {
    // The rehydrate path stays: first entry has no live state to focus, and
    // the snapshot is the only thing that knows what was open last time.
    const places = createPlaceRegistry<Place>();
    expect(places.focus(A)).toBeNull();
    expect(places.has(A)).toBe(false);
  });

  test("parking the focused place again keeps one slot, not two", () => {
    // Every store change re-parks the focused place. If that appended, a long
    // session would hold a thousand copies of one project.
    const places = createPlaceRegistry<Place>();
    for (let i = 0; i < 50; i++) {
      places.park(A, { files: [clean(`${A}/f`, `v${i}`)], activePath: null });
    }
    expect(places.size()).toBe(1);
    expect(places.peek(A)?.files[0].current).toBe("v49");
  });
});

describe("closing is the only wipe", () => {
  test("forget drops the live state so the next entry rebuilds", () => {
    const places = createPlaceRegistry<Place>();
    places.park(A, { files: [clean(`${A}/f`, "x")], activePath: null });

    expect(places.forget(A)).toBe(true);
    expect(places.has(A)).toBe(false);
    expect(places.focus(A)).toBeNull();
    // Idempotent — closing an already-closed place is not an error.
    expect(places.forget(A)).toBe(false);
  });

  test("closing one place leaves the others open", () => {
    const places = createPlaceRegistry<Place>();
    const beta: Place = { files: [clean(`${B}/f`, "b")], activePath: null };
    places.park(A, { files: [], activePath: null });
    places.park(B, beta);

    places.forget(A);
    expect(places.focus(B)).toBe(beta);
  });
});

describe("holding many places without holding everything", () => {
  test("past the cap the least-recently-focused place is dropped", () => {
    const places = createPlaceRegistry<Place>({ limit: 3 });
    for (const p of ["p1", "p2", "p3"]) {
      places.park(p, { files: [], activePath: null });
    }
    // Touch p1 so p2 is the coldest.
    places.focus("p1");

    const evicted = places.park("p4", { files: [], activePath: null });
    expect(evicted).toEqual(["p2"]);
    expect(places.places()).toEqual(["p3", "p1", "p4"]);
  });

  test("a place holding an unsaved edit is never dropped to make room", () => {
    // An evicted place comes back through its snapshot, which is fine for
    // everything a snapshot can describe. An unsaved buffer is not one of
    // those things — dropping it would destroy work with no way back, so the
    // cap yields to it rather than the other way round.
    const places = createPlaceRegistry<Place>({ limit: 2, pinned: dirty });
    places.park(A, {
      files: [edited(`${A}/src/main.rs`, "was", "now")],
      activePath: null,
    });
    places.park("p2", { files: [], activePath: null });

    const evicted = places.park("p3", { files: [], activePath: null });
    expect(evicted).toEqual(["p2"]);
    expect(places.peek(A)?.files[0].current).toBe("now");
  });

  test("when every place is pinned the cap is exceeded, not the work lost", () => {
    const places = createPlaceRegistry<Place>({ limit: 1, pinned: dirty });
    places.park(A, { files: [edited(`${A}/f`, "was", "now")], activePath: null });
    const evicted = places.park(B, {
      files: [edited(`${B}/f`, "was", "now")],
      activePath: null,
    });
    expect(evicted).toEqual([]);
    expect(places.size()).toBe(2);
    expect(places.peek(A)).not.toBeNull();
  });

  test("the default cap is generous enough for a real desk", () => {
    expect(DEFAULT_LIVE_PLACE_LIMIT).toBeGreaterThanOrEqual(8);
  });
});

describe("the store switches by focusing", () => {
  test("state is a map keyed by place, not a singleton", () => {
    expect(store).toContain("createPlaceRegistry<State>");
    // One funnel for every assignment to `state`, so the registry can't go
    // stale under the place the user is standing in.
    expect(store).toContain("function adoptState(next: State)");
    expect(store).toContain("places.park(key, next)");
  });

  test("switchWorkspace returns the live state before it considers a wipe", () => {
    const body = store.slice(
      store.indexOf("function switchWorkspace("),
      store.indexOf("function carryWorkSurface("),
    );
    const focus = body.indexOf("places.focus(next)");
    const wipe = body.indexOf("const wiped: State");
    expect(focus).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(-1);
    // The order IS the fix. A wipe computed first is a wipe that ran.
    expect(focus).toBeLessThan(wipe);
    expect(body).toContain('return "focused"');
    expect(body).toContain('return "hydrated"');
  });

  test("the snapshot rehydrate is kept for a place seen for the first time", () => {
    // The registry is a session-lifetime cache; the snapshot is what a restart
    // reads. Dropping the rehydrate would make every cold start empty.
    const body = store.slice(
      store.indexOf("function switchWorkspace("),
      store.indexOf("function carryWorkSurface("),
    );
    expect(body).toContain("loadSnapshot(next)");
    expect(body).toContain("saveSnapshot(prev, buildSnapshotFromState(state))");
  });

  test("closing a place is what drops its live state", () => {
    expect(store).toContain("function closeWorkspace(root: string): void");
    expect(store).toContain("places.forget(root)");
  });

  test("leaving the club lands the same way a switch does", () => {
    // No feature lands in one place-mode only: the club is a place too, so
    // exiting it focuses a live workspace rather than always rehydrating.
    const body = store.slice(store.indexOf("function exitClub("));
    expect(body.slice(0, 1400)).toContain("places.focus(next)");
    // …and each club keeps its OWN slot, so parking one can't overwrite a
    // member place's live state — nor another club's. One key per club, not
    // one for all of them: the window holds as many clubs as the work needs
    // (see tests/clubbingAnyPlaces).
    expect(store).toContain("function clubPlaceKey(clubId: string): string");
    expect(store).toContain("places.focus(clubPlaceKey(clubId))");
  });
});

describe("the app does not replay a focused place", () => {
  test("the snapshot's file paths are replayed only on a hydrate", () => {
    // Replaying over a live buffer means openFile re-reading disk under an
    // unsaved edit. The guard is the difference between "instant and lossless"
    // and "instant and quietly lossy".
    expect(app).toContain(
      "const switched = editor.switchWorkspace(previousRoot, root);",
    );
    expect(app).toMatch(
      /if \(switched === "hydrated"\) \{[\s\S]{0,600}?pendingFilePaths\(root\)/,
    );
  });

  test("the legacy agent restore does not undo tabs the user closed", () => {
    expect(app).toContain(
      'if (switched === "hydrated" && editor.agentTabs.length === 0)',
    );
  });

  test("closing a project drops its live state, after the fallback switch", () => {
    const close = app.slice(app.indexOf("onCloseProject={(id) => {"));
    expect(close.slice(0, 1200)).toContain(
      ".finally(() => editorRef.current.closeWorkspace(id))",
    );
    expect(close.slice(0, 1200)).toContain("editor.closeWorkspace(id)");
  });
});

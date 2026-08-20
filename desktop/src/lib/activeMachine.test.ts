import { afterEach, describe, expect, test } from "bun:test";

import {
  clearMachines,
  getActiveMachine,
  getEnteredMachines,
  machineIdForRoot,
  resolveMachine,
  subscribeActiveMachine,
  syncMachines,
} from "./activeMachine";

// The store is a module singleton — one window — so each test puts it back
// where it found it.
afterEach(() => clearMachines());

const BOX = "ubuntu@18.196.118.42";
const OTHER = "ubuntu@3.122.52.150";

describe("the machine this window is standing in", () => {
  test("nothing synced means you are on this laptop", () => {
    expect(getActiveMachine()).toEqual({ machineId: null, threadKey: null });
    expect(getEnteredMachines()).toEqual([]);
  });

  test("entering a machine names it", () => {
    syncMachines([{ key: "a", machineId: BOX }], "a");
    expect(getActiveMachine()).toEqual({ machineId: BOX, threadKey: null });
  });

  test("arriving through a cloud conversation keeps both halves", () => {
    syncMachines([{ key: "a", machineId: BOX, threadKey: "thread-7" }], "a");
    expect(getActiveMachine()).toEqual({
      machineId: BOX,
      threadKey: "thread-7",
    });
  });

  test("blank is not a machine", () => {
    // A request can carry an empty string. An empty string must not light a row.
    syncMachines([{ key: "a", machineId: "   ", threadKey: "" }], "a");
    expect(getActiveMachine()).toEqual({ machineId: null, threadKey: null });
  });

  test("a thread with no resolved machine still marks its row", () => {
    // Opening from a cloud conversation while the book is still being read:
    // the box isn't known yet, but the row you clicked is.
    syncMachines([{ key: "a", threadKey: "thread-7" }], "a");
    expect(getActiveMachine()).toEqual({
      machineId: null,
      threadKey: "thread-7",
    });
  });

  test("a member without a key is not a member", () => {
    syncMachines([{ key: "  ", machineId: BOX }], "a");
    expect(getEnteredMachines()).toEqual([]);
    expect(getActiveMachine().machineId).toBeNull();
  });
});

describe("holding more than one machine", () => {
  test("entering a second does not evict the first", () => {
    syncMachines([{ key: "a", machineId: BOX }], "a");
    syncMachines(
      [
        { key: "a", machineId: BOX },
        { key: "b", machineId: OTHER },
      ],
      "b",
    );

    expect(getEnteredMachines().map((m) => m.machineId)).toEqual([BOX, OTHER]);
    // One focused member — the one you just walked into.
    expect(getActiveMachine().machineId).toBe(OTHER);
  });

  test("stepping off keeps every machine, and says you are here", () => {
    // Going to Trace, Pages or the fleet blurs the set rather than dropping it.
    syncMachines(
      [
        { key: "a", machineId: BOX },
        { key: "b", machineId: OTHER },
      ],
      "b",
    );
    syncMachines(
      [
        { key: "a", machineId: BOX },
        { key: "b", machineId: OTHER },
      ],
      null,
    );

    expect(getEnteredMachines()).toHaveLength(2);
    expect(getActiveMachine()).toEqual({ machineId: null, threadKey: null });
  });

  test("going back to one you already hold focuses it, not a copy", () => {
    syncMachines(
      [
        { key: "a", machineId: BOX },
        { key: "b", machineId: OTHER },
      ],
      "b",
    );
    syncMachines(
      [
        { key: "b", machineId: OTHER },
        { key: "a", machineId: BOX },
      ],
      "a",
    );

    expect(getEnteredMachines()).toHaveLength(2);
    expect(getActiveMachine().machineId).toBe(BOX);
  });

  test("leaving one leaves the others where they were", () => {
    syncMachines(
      [
        { key: "a", machineId: BOX },
        { key: "b", machineId: OTHER },
      ],
      "b",
    );
    syncMachines([{ key: "a", machineId: BOX }], null);

    expect(getEnteredMachines().map((m) => m.machineId)).toEqual([BOX]);
    expect(getActiveMachine().machineId).toBeNull();
  });

  test("focusing a member the window is not in focuses nothing", () => {
    // Belt and braces against a stale key outliving its place.
    syncMachines([{ key: "a", machineId: BOX }], "gone");
    expect(getActiveMachine()).toEqual({ machineId: null, threadKey: null });
  });
});

describe("what the workspace resolves, and what App may not overwrite", () => {
  test("a thread-only entry becomes a box once the book is read", () => {
    syncMachines([{ key: "a", threadKey: "thread-7" }], "a");
    resolveMachine("a", BOX, "thread-7");

    expect(getActiveMachine()).toEqual({
      machineId: BOX,
      threadKey: "thread-7",
    });
  });

  test("re-syncing the set does not undo a resolution", () => {
    // App only ever knows what was ASKED for. Re-publishing membership because
    // some other place moved must not put a resolved box back to "unknown".
    syncMachines([{ key: "a", threadKey: "thread-7" }], "a");
    resolveMachine("a", BOX, "thread-7");
    syncMachines(
      [
        { key: "a", threadKey: "thread-7" },
        { key: "b", machineId: OTHER },
      ],
      "b",
    );

    expect(getEnteredMachines()[0]!.machineId).toBe(BOX);
  });

  test("a resolution for a place the window has left is ignored", () => {
    // A workspace unmounting as the user leaves must not put the place back.
    syncMachines([{ key: "a", machineId: BOX }], "a");
    syncMachines([], null);
    resolveMachine("a", BOX);

    expect(getEnteredMachines()).toEqual([]);
    expect(getActiveMachine().machineId).toBeNull();
  });
});

describe("what subscribers are woken for", () => {
  test("publishing the same set twice changes nothing and wakes nobody", () => {
    syncMachines([{ key: "a", machineId: BOX, threadKey: "thread-7" }], "a");
    const first = getActiveMachine();
    const firstSet = getEnteredMachines();
    let wakeups = 0;
    const off = subscribeActiveMachine(() => {
      wakeups += 1;
    });

    syncMachines([{ key: "a", machineId: BOX, threadKey: "thread-7" }], "a");

    // Identity, not equality: the roster subscribes through
    // useSyncExternalStore, so a fresh object would re-render it on every
    // minute tick for a value that did not move.
    expect(getActiveMachine()).toBe(first);
    expect(getEnteredMachines()).toBe(firstSet);
    expect(wakeups).toBe(0);
    off();
  });

  test("a different box wakes them", () => {
    syncMachines([{ key: "a", machineId: BOX }], "a");
    const first = getActiveMachine();
    let wakeups = 0;
    const off = subscribeActiveMachine(() => {
      wakeups += 1;
    });

    syncMachines([{ key: "b", machineId: OTHER }], "b");

    expect(wakeups).toBe(1);
    expect(getActiveMachine()).not.toBe(first);
    expect(getActiveMachine().machineId).toBe(OTHER);
    off();
  });

  test("the same box through a different conversation wakes them", () => {
    syncMachines([{ key: "a", machineId: BOX, threadKey: "thread-7" }], "a");
    let wakeups = 0;
    const off = subscribeActiveMachine(() => {
      wakeups += 1;
    });

    resolveMachine("a", BOX, "thread-8");

    expect(wakeups).toBe(1);
    expect(getActiveMachine().threadKey).toBe("thread-8");
    off();
  });

  test("holding a second machine wakes them without moving where you are", () => {
    syncMachines([{ key: "a", machineId: BOX }], "a");
    const here = getActiveMachine();
    let wakeups = 0;
    const off = subscribeActiveMachine(() => {
      wakeups += 1;
    });

    syncMachines(
      [
        { key: "a", machineId: BOX },
        { key: "b", machineId: OTHER },
      ],
      "a",
    );

    // The set changed, so the rail must redraw; where you are standing did not,
    // so the value that says so keeps its identity and nothing reading only it
    // re-renders.
    expect(wakeups).toBe(1);
    expect(getActiveMachine()).toBe(here);
    expect(getEnteredMachines()).toHaveLength(2);
    off();
  });

  test("blurring wakes them, and an unsubscribed reader stays asleep", () => {
    syncMachines([{ key: "a", machineId: BOX }], "a");
    let wakeups = 0;
    const off = subscribeActiveMachine(() => {
      wakeups += 1;
    });

    syncMachines([{ key: "a", machineId: BOX }], null);
    expect(wakeups).toBe(1);

    off();
    syncMachines([{ key: "a", machineId: BOX }], "a");
    expect(wakeups).toBe(1);
  });
});

describe("which place a new thing runs in", () => {
  const HERE = "/Users/mo/naridon";
  const OTHER_PROJECT = "/Users/mo/pomodoro";

  test("no machine anywhere means new work runs on this laptop", () => {
    expect(machineIdForRoot(HERE)).toBeNull();
  });

  test("standing in a box, work on its project runs there", () => {
    syncMachines([{ key: "a", machineId: BOX, repoRoot: HERE }], "a");
    expect(machineIdForRoot(HERE)).toBe(BOX);
  });

  test("a second project in the same window is not on that box", () => {
    // The whole reason this is asked per project rather than per window: you
    // can be standing in a machine holding project A with project B's chat one
    // click away, and B's next message must not run on A's machine.
    syncMachines([{ key: "a", machineId: BOX, repoRoot: HERE }], "a");
    expect(machineIdForRoot(OTHER_PROJECT)).toBeNull();
  });

  test("the same project either side of a trailing slash is one project", () => {
    syncMachines([{ key: "a", machineId: BOX, repoRoot: `${HERE}/` }], "a");
    expect(machineIdForRoot(HERE)).toBe(BOX);
  });

  test("a box you are holding but not looking at does not claim your work", () => {
    // It is still open and one click away. You are reading Trace, and what you
    // start from there starts where you are looking.
    syncMachines([{ key: "a", machineId: BOX, repoRoot: HERE }], null);
    expect(machineIdForRoot(HERE)).toBeNull();
  });

  test("the machine you are looking at wins over one you left behind", () => {
    syncMachines(
      [
        { key: "a", machineId: BOX, repoRoot: HERE },
        { key: "b", machineId: OTHER, repoRoot: HERE },
      ],
      "b",
    );
    expect(machineIdForRoot(HERE)).toBe(OTHER);
  });

  test("a machine that has not named a project yet is taken at its word", () => {
    // Entered from the fleet, or through a conversation whose repo the book
    // hasn't answered for. You are in it and it is the only place you are in;
    // refusing would send the work to a laptop the user isn't looking at.
    syncMachines([{ key: "a", machineId: BOX }], "a");
    expect(machineIdForRoot(HERE)).toBe(BOX);
  });

  test("a place learns its project from a later sync", () => {
    syncMachines([{ key: "a", machineId: BOX }], "a");
    syncMachines([{ key: "a", machineId: BOX, repoRoot: HERE }], "a");
    expect(machineIdForRoot(HERE)).toBe(BOX);
    expect(machineIdForRoot(OTHER_PROJECT)).toBeNull();
  });

  test("what the workspace resolves is what new work follows", () => {
    // Opened from a cloud conversation: no machine and no project until the
    // workspace reads the book. Both arrive through the resolution.
    syncMachines([{ key: "a", threadKey: "thread-7" }], "a");
    expect(machineIdForRoot(HERE)).toBeNull();

    resolveMachine("a", BOX, "thread-7", HERE);
    expect(machineIdForRoot(HERE)).toBe(BOX);
    expect(machineIdForRoot(OTHER_PROJECT)).toBeNull();
  });

  test("no project named means nowhere to run it but here", () => {
    syncMachines([{ key: "a", machineId: BOX, repoRoot: HERE }], "a");
    expect(machineIdForRoot(null)).toBeNull();
    expect(machineIdForRoot("  ")).toBeNull();
  });
});

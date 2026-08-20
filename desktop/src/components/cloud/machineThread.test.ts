// Landing back in the conversation you were having with a box.
//
// The whole point of this decision is continuity, and every way it goes wrong
// is silent: you get a blank thread and assume you never had one, or a spinner
// that never resolves because the id it is loading died with the machine. None
// of that raises an error, so none of it gets reported — it just makes the
// feature feel unreliable in a way nobody can quite describe.

import { describe, expect, test } from "bun:test";

import {
  objectiveFor,
  openThread,
  rememberedKey,
  type ThreadStore,
} from "./machineThread";

/** A store that records what was written to it, so "remembered" is a claim
 *  that can be checked rather than assumed. */
function store(seed: Record<string, string> = {}) {
  const kept = new Map(Object.entries(seed));
  const s: ThreadStore & { kept: Map<string, string> } = {
    kept,
    getItem: (k) => kept.get(k) ?? null,
    setItem: (k, v) => void kept.set(k, v),
    removeItem: (k) => void kept.delete(k),
  };
  return s;
}

const BOX = { id: "ubuntu@10.0.0.1:/srv/aura", name: "aura-runner", repoRoot: "/Users/mo/aura" };

/** A conversation that can be started, counting how often it was. */
function starter(id = "sess-new") {
  const calls: Array<[string, string, string]> = [];
  return {
    calls,
    start: async (root: string, objective: string, machineId: string) => {
      calls.push([root, objective, machineId]);
      return id;
    },
  };
}

const dead = async () => false;
const living = async () => true;

describe("opening a machine's conversation", () => {
  test("the remembered one is picked up where it left off", async () => {
    const s = store({ [rememberedKey(BOX.id)]: "sess-old" });
    const fresh = starter();
    const thread = await openThread(BOX, false, {
      store: s,
      alive: living,
      start: fresh.start,
    });
    expect(thread).toEqual({ sessionId: "sess-old", resumed: true });
    // And nothing new was started. A second session per visit would leave the
    // real conversation buried under a list of empty ones.
    expect(fresh.calls).toEqual([]);
  });

  test("a remembered conversation that no longer exists is forgotten, not resumed", async () => {
    // The spinner-forever case. Resuming a dead id mounts a surface that loads
    // nothing and never says why.
    const s = store({ [rememberedKey(BOX.id)]: "sess-gone" });
    const thread = await openThread(BOX, false, {
      store: s,
      alive: dead,
      start: starter("sess-new").start,
    });
    expect(thread).toEqual({ sessionId: "sess-new", resumed: false });
    // Forgotten, not merely stepped over: left in place it would be re-checked
    // and re-fail on every visit for as long as the machine exists.
    expect(s.kept.get(rememberedKey(BOX.id))).toBe("sess-new");
  });

  test("with nothing remembered, one is started and then remembered", async () => {
    const s = store();
    await openThread(BOX, false, {
      store: s,
      alive: living,
      start: starter("sess-1").start,
    });
    expect(s.kept.get(rememberedKey(BOX.id))).toBe("sess-1");
  });

  test("asking for a fresh thread does not resume the one you just left", async () => {
    // What "New thread" and "Try again" mean. Looking at the remembered id
    // first would hand back the exact conversation the user asked to leave.
    const s = store({ [rememberedKey(BOX.id)]: "sess-old" });
    const thread = await openThread(BOX, true, {
      store: s,
      alive: living,
      start: starter("sess-2").start,
    });
    expect(thread).toEqual({ sessionId: "sess-2", resumed: false });
    expect(s.kept.get(rememberedKey(BOX.id))).toBe("sess-2");
  });

  test("two boxes keep two conversations", async () => {
    // One key for both would mean walking into the second machine and finding
    // the first machine's chat, about a different body of code.
    const s = store();
    const other = { ...BOX, id: "ubuntu@10.0.0.2:/srv/aura", name: "ci-box" };
    await openThread(BOX, false, { store: s, alive: living, start: starter("sess-a").start });
    await openThread(other, false, { store: s, alive: living, start: starter("sess-b").start });
    expect(s.kept.get(rememberedKey(BOX.id))).toBe("sess-a");
    expect(s.kept.get(rememberedKey(other.id))).toBe("sess-b");
    expect(rememberedKey(BOX.id)).not.toBe(rememberedKey(other.id));
  });
});

describe("what the new conversation is called and where it is filed", () => {
  test("it is named after the machine, so a list of them reads", async () => {
    const fresh = starter();
    await openThread(BOX, true, { store: store(), alive: living, start: fresh.start });
    expect(fresh.calls).toEqual([["/Users/mo/aura", "Working on aura-runner", BOX.id]]);
    expect(objectiveFor("ci-box")).toBe("Working on ci-box");
  });

  test("it is filed under the local checkout, not the machine", async () => {
    // This is what lets the chat outlive the box. The transcript, the board and
    // the intent log stay on this laptop; the hands are what reach across.
    const fresh = starter();
    await openThread(BOX, true, { store: store(), alive: living, start: fresh.start });
    expect(fresh.calls[0]![0]).toBe(BOX.repoRoot);
  });
});

describe("when starting one fails", () => {
  test("nothing is remembered, so the next visit is not haunted by it", async () => {
    // Writing the id before the call is the tempting order and the wrong one:
    // a failed start would leave behind a thread every later visit tries and
    // fails to resume.
    const s = store();
    const boom = openThread(BOX, false, {
      store: s,
      alive: living,
      start: async () => {
        throw new Error("You're not signed in to cloud.");
      },
    });
    await expect(boom).rejects.toThrow("not signed in");
    expect(s.kept.size).toBe(0);
  });

  test("the reason comes back intact, because it is what the user is shown", async () => {
    const boom = openThread(BOX, false, {
      store: store(),
      alive: living,
      start: async () => {
        throw new Error("That project has no checkout on this laptop.");
      },
    });
    await expect(boom).rejects.toThrow("no checkout on this laptop");
  });
});

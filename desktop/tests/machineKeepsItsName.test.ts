// A machine that moves keeps everything that points at it.
//
// The bug: a machine row was named by its address, so when the connect wizard
// was pointed at a box on a new address the row came back under a new id, and
// every workspace, chat and tab strip still holding the old one showed the
// machine as missing. Rows now have ids of their own, an edit to the address
// keeps the id (asserted on the backend, in `cmd_machines`), and an id a row
// had before — the address key it was renamed from, or the id it was
// reconnected as — is listed in its `aliases` and still finds it.
//
// These are the window's halves of that: the workspace that names the
// machine, the conversation remembered for it, the project's chat pointer,
// the tab strip and the remembered destination.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Machine } from "../src/lib/api";
import type { WhereOption } from "../src/lib/place/where";

// Every module below reads `localStorage`, which this process does not have.
// A complete one per test, put back afterwards: bun runs every file in one
// process, and whatever is left installed is what the next file reads.
type Cells = Map<string, string>;
let cells: Cells = new Map();
let previous: unknown;
beforeEach(() => {
  previous = (globalThis as { localStorage?: unknown }).localStorage;
  cells = new Map();
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
});

const { forgetLearnedMachineIds, knownIdsOf, learnMachineIds } = await import(
  "../src/lib/machineRef"
);
const { machineToOpen, missingMachine } = await import(
  "../src/components/cloud/machineWorkspace"
);
const { openThread, rememberedKey } = await import("../src/components/cloud/machineThread");
const { ambientKey, readAmbientSid, samePlace, writeAmbientSid } = await import(
  "../src/lib/ambientSession"
);
const { emptyRemoteSnapshot, loadRemoteSnapshot, remoteSlotFor, remoteSlotKey, saveRemoteSnapshot } =
  await import("../src/lib/remoteWorkspaceSnapshot");
const { chosenWhere } = await import("../src/lib/place/where");

afterEach(() => {
  forgetLearnedMachineIds();
  (globalThis as { localStorage: unknown }).localStorage = previous;
});

const PROJECT = "/Users/me/projects/naridon";
/** The id a workspace saved before rows had ids of their own. */
const OLD = "ubuntu@10.0.0.1:/srv/aura";
/** The id the same row goes by now. */
const NOW = "m-0123456789abcdef";

const box = (over: Partial<Machine> = {}): Machine => ({
  id: NOW,
  name: "aura-runner",
  host: "10.0.0.1",
  user: "ubuntu",
  key_path: "/keys/aura.pem",
  box_kind: "mine",
  repo_path: "/srv/aura",
  project_root: PROJECT,
  repo_branch: null,
  added_at: 1,
  last_used_at: 2,
  ...over,
});

/** Open the machine's conversation the way `MachineChat` does. */
async function chatOn(machineId: string) {
  const started: string[] = [];
  const thread = await openThread(
    { id: machineId, formerIds: knownIdsOf(machineId).slice(1), name: "aura-runner", repoRoot: PROJECT },
    false,
    {
      store: localStorage,
      alive: async () => true,
      start: async () => {
        started.push(machineId);
        return "sess-new";
      },
    },
  );
  return { thread, started };
}

describe("a machine reconnected at a new host", () => {
  test("keeps its workspaces and its chat", async () => {
    // Before: the workspace names the machine, and its chat is remembered.
    const before = [box()];
    learnMachineIds(before);
    localStorage.setItem(rememberedKey(NOW), "sess-1");
    writeAmbientSid(PROJECT, NOW, "sess-ambient");
    expect(missingMachine(before, NOW)).toBeNull();

    // The wizard points it at a new address; the row keeps its id.
    const after = [box({ host: "10.0.0.2", last_used_at: 3 })];
    learnMachineIds(after);

    expect(missingMachine(after, NOW)).toBeNull();
    expect(machineToOpen(NOW, after)).toBe(NOW);
    const { thread, started } = await chatOn(NOW);
    expect(thread).toEqual({ sessionId: "sess-1", resumed: true });
    expect(started).toEqual([]);
    expect(readAmbientSid(PROJECT, NOW)).toBe("sess-ambient");
  });
});

describe("a book renamed from address keys", () => {
  // What the backend hands back after renaming an old book once: the row's
  // new id, and the address key it was renamed from among its aliases.
  const book = [box({ aliases: [OLD] })];

  test("a workspace holding the old id still finds its machine, under the new one", () => {
    learnMachineIds(book);
    expect(missingMachine(book, OLD)).toBeNull();
    expect(machineToOpen(OLD, book)).toBe(NOW);
  });

  test("the conversation remembered under the old id is resumed, and filed under the new", async () => {
    localStorage.setItem(rememberedKey(OLD), "sess-1");
    learnMachineIds(book);
    const { thread, started } = await chatOn(NOW);
    expect(thread).toEqual({ sessionId: "sess-1", resumed: true });
    expect(started).toEqual([]);
    expect(localStorage.getItem(rememberedKey(NOW))).toBe("sess-1");
    expect(localStorage.getItem(rememberedKey(OLD))).toBeNull();
  });

  test("the project's chat pointer follows it, and a session saved under the old id is still in the same place", () => {
    localStorage.setItem(ambientKey(PROJECT, OLD), "sess-ambient");
    learnMachineIds(book);
    expect(readAmbientSid(PROJECT, NOW)).toBe("sess-ambient");
    expect(localStorage.getItem(ambientKey(PROJECT, NOW))).toBe("sess-ambient");
    // `resolveAmbientSession` drops a session found in a different place; one
    // saved before the rename is in this one.
    expect(samePlace(OLD, NOW)).toBe(true);
    expect(samePlace(OLD, null)).toBe(false);
    // New pointers are written under the id the machine goes by now.
    writeAmbientSid(PROJECT, OLD, "sess-2");
    expect(localStorage.getItem(ambientKey(PROJECT, NOW))).toBe("sess-2");
  });

  test("the tab strip saved under the old id is restored", () => {
    const oldSlot = remoteSlotFor(OLD, PROJECT)!;
    saveRemoteSnapshot(oldSlot, emptyRemoteSnapshot());
    // Read as it was, before the window has seen the renamed book.
    const saved = loadRemoteSnapshot(oldSlot);
    expect(saved).not.toBeNull();

    learnMachineIds(book);
    expect(loadRemoteSnapshot(remoteSlotFor(NOW, PROJECT)!)).toEqual(saved);
    expect(localStorage.getItem(remoteSlotKey(oldSlot))).toBeNull();
  });

  test("a destination remembered as the old id still picks the machine", () => {
    learnMachineIds(book);
    const options = [
      { id: "here", machineId: null },
      { id: NOW, machineId: NOW },
    ] as WhereOption[];
    expect(chosenWhere(options, OLD).id).toBe(NOW);
    expect(chosenWhere(options, "m-9999999999999999").id).toBe("here");
  });
});

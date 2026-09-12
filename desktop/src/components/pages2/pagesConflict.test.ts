// Run with: bun test src/components/pages2/pagesConflict.test.ts
//
// AURA-268: a desktop Page wrote its stale cached copy over a newer revision.
// The backend now refuses that write and answers with a `note-conflict:` marker
// plus the two timestamps. These tests pin the client half of that contract —
// a refused save must be readable as a conflict (so the reader gets a choice),
// an ordinary failure must NOT be (so a disk error isn't mistaken for one), and
// adopting someone else's revision must drop the local CRDT cache, which is the
// second store that kept resurrecting the stale body.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";

import { asNoteConflict } from "./pagesApi";
import { forgetPersistedDoc } from "../../lib/pages_collab";

describe("asNoteConflict", () => {
  it("reads a refused save as a conflict, with both revisions", () => {
    const err =
      'note-conflict:{"id":"note_abc","disk_updated_at":"2026-08-24T10:05:00Z","base_updated_at":"2026-08-24T09:00:00Z"}';
    expect(asNoteConflict(err)).toEqual({
      id: "note_abc",
      diskUpdatedAt: "2026-08-24T10:05:00Z",
      baseUpdatedAt: "2026-08-24T09:00:00Z",
    });
  });

  it("finds the marker when Tauri has wrapped it in an Error", () => {
    // invoke() rejects with an Error whose message carries the command's string.
    const err = new Error(
      'invoke error: note-conflict:{"id":"n1","disk_updated_at":"2026-08-24T10:05:00Z","base_updated_at":null}',
    );
    expect(asNoteConflict(err)?.id).toBe("n1");
  });

  it("still reports a conflict when the payload is unreadable", () => {
    // The marker is the load-bearing part. Reporting a generic save failure
    // here would put us straight back to silently losing the newer copy.
    expect(asNoteConflict("note-conflict:{not json")).toEqual({
      id: "",
      diskUpdatedAt: null,
      baseUpdatedAt: null,
    });
  });

  it("leaves an ordinary failure alone", () => {
    expect(asNoteConflict("Permission denied (os error 13)")).toBeNull();
    expect(asNoteConflict(new Error("No space left on device"))).toBeNull();
    expect(asNoteConflict(undefined)).toBeNull();
    expect(asNoteConflict(null)).toBeNull();
  });
});

// bun's test runner has no DOM, and pages_collab reads localStorage through
// try/catch wrappers — so without a store the helper would silently no-op and
// the tests below would pass while proving nothing. Give it a real one.
function installStore() {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  (globalThis as { localStorage?: unknown }).localStorage = store;
  return store;
}

describe("forgetPersistedDoc", () => {
  const PREFIX = "aura.pages2.ydoc.";
  const LRU = "aura.pages2.ydoc.__lru";

  beforeEach(() => {
    installStore();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("drops the cached CRDT state for one page and nothing else", () => {
    // Without this, taking their version replays the stale body straight back
    // out of localStorage the moment the editor remounts.
    localStorage.setItem(PREFIX + "team|general|mine", "AAA");
    localStorage.setItem(PREFIX + "team|general|theirs", "BBB");
    localStorage.setItem(LRU, JSON.stringify(["team|general|mine", "team|general|theirs"]));

    forgetPersistedDoc("team|general|mine");

    expect(localStorage.getItem(PREFIX + "team|general|mine")).toBeNull();
    expect(localStorage.getItem(PREFIX + "team|general|theirs")).toBe("BBB");
  });

  it("takes the page out of the eviction list too, so it can't be re-evicted", () => {
    localStorage.setItem(PREFIX + "a", "x");
    localStorage.setItem(LRU, JSON.stringify(["a", "b"]));

    forgetPersistedDoc("a");

    expect(JSON.parse(localStorage.getItem(LRU) ?? "[]")).toEqual(["b"]);
  });

  it("is safe on a page that was never cached", () => {
    expect(() => forgetPersistedDoc("never-opened")).not.toThrow();
    expect(JSON.parse(localStorage.getItem(LRU) ?? "[]")).toEqual([]);
  });
});

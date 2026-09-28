// Run with: bun test src/lib/modelFavorites.test.ts
//
// Starred models are shared by every model picker. The agent chat's picker
// used to keep stars in component state, so a star vanished when its popup
// closed; these pin the one store every picker now reads and writes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MODEL_FAVORITES_KEY,
  loadModelFavorites,
  saveModelFavorites,
  toggleModelFavorite,
} from "./modelFavorites";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("model favorites", () => {
  test("uses the key the Aura chat has always persisted under", () => {
    // Changing it would silently drop every star users already have.
    expect(MODEL_FAVORITES_KEY).toBe("aura.manager.modelFavorites");
  });

  test("round-trips through storage", () => {
    saveModelFavorites(["cli_wrapper:claude::opus", "cli_wrapper:codex::gpt"]);
    expect(loadModelFavorites()).toEqual([
      "cli_wrapper:claude::opus",
      "cli_wrapper:codex::gpt",
    ]);
  });

  test("an empty list removes the key", () => {
    saveModelFavorites(["a"]);
    saveModelFavorites([]);
    expect(store.has(MODEL_FAVORITES_KEY)).toBe(false);
    expect(loadModelFavorites()).toEqual([]);
  });

  test("ignores junk in storage", () => {
    store.set(MODEL_FAVORITES_KEY, "{not json");
    expect(loadModelFavorites()).toEqual([]);
    store.set(MODEL_FAVORITES_KEY, JSON.stringify(["ok", 3, null]));
    expect(loadModelFavorites()).toEqual(["ok"]);
  });

  test("survives storage that throws", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadModelFavorites()).toEqual([]);
    expect(() => saveModelFavorites(["a"])).not.toThrow();
  });

  test("toggle stars, unstars, and keeps star order", () => {
    const one = toggleModelFavorite([], "a");
    const two = toggleModelFavorite(one, "b");
    expect(two).toEqual(["a", "b"]);
    expect(toggleModelFavorite(two, "a")).toEqual(["b"]);
    expect(two).toEqual(["a", "b"]);
  });
});

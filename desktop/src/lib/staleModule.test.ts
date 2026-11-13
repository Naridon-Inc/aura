import { describe, expect, test } from "bun:test";
import {
  STALE_RELOAD_KEY,
  STALE_RELOAD_WINDOW_MS,
  isStaleModuleError,
  reloadForStaleModule,
} from "./staleModule";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe("isStaleModuleError", () => {
  test("knows each engine's wording", () => {
    expect(isStaleModuleError("Importing a module script failed.")).toBe(true);
    expect(
      isStaleModuleError(
        "Failed to fetch dynamically imported module: http://localhost:1420/src/x.tsx",
      ),
    ).toBe(true);
    expect(isStaleModuleError("error loading dynamically imported module")).toBe(true);
    expect(isStaleModuleError("Unable to preload CSS for /assets/a.css")).toBe(true);
  });

  test("leaves every other error to the error screen", () => {
    expect(isStaleModuleError("Cannot read properties of undefined")).toBe(false);
    expect(isStaleModuleError("")).toBe(false);
  });
});

describe("reloadForStaleModule", () => {
  test("reloads the first time and remembers when", () => {
    const store = memory();
    let reloads = 0;
    expect(reloadForStaleModule(store, 1_000_000, () => reloads++)).toBe(true);
    expect(reloads).toBe(1);
    expect(store.getItem(STALE_RELOAD_KEY)).toBe("1000000");
  });

  test("a second failure inside the window shows the screen instead of looping", () => {
    const store = memory();
    let reloads = 0;
    reloadForStaleModule(store, 1_000_000, () => reloads++);
    expect(reloadForStaleModule(store, 1_000_000 + 5_000, () => reloads++)).toBe(false);
    expect(reloads).toBe(1);
  });

  test("after the window it may reload again", () => {
    const store = memory();
    let reloads = 0;
    reloadForStaleModule(store, 1_000_000, () => reloads++);
    expect(
      reloadForStaleModule(store, 1_000_000 + STALE_RELOAD_WINDOW_MS + 1, () => reloads++),
    ).toBe(true);
    expect(reloads).toBe(2);
  });

  test("blocked storage still allows the reload", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    let reloads = 0;
    expect(reloadForStaleModule(blocked, 1, () => reloads++)).toBe(true);
    expect(reloads).toBe(1);
  });
});

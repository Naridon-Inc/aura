import { describe, expect, test } from "bun:test";

import { forgetMovedToCloud, movedToCloudOf, readMovedToCloud, rememberMovedToCloud, type MovedToCloud } from "./movedToCloud";

function memory(): Pick<Storage, "getItem" | "setItem"> & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => void raw.set(k, v),
  };
}

const moved = (over: Partial<MovedToCloud> = {}): MovedToCloud => ({
  workspaceId: "ws-1",
  machine: "team-box",
  branch: "fix/login",
  at: 1_000,
  ...over,
});

describe("movedToCloud", () => {
  test("a folder remembers where its work went, whatever its trailing slash", () => {
    const store = memory();
    rememberMovedToCloud("/w/fix-login/", moved(), store);
    expect(movedToCloudOf("/w/fix-login", store)).toEqual(moved());
    expect(movedToCloudOf("/w/other", store)).toBeNull();
  });

  test("forgetting it clears the row's mark", () => {
    const store = memory();
    rememberMovedToCloud("/w/fix-login", moved(), store);
    forgetMovedToCloud("/w/fix-login", store);
    expect(movedToCloudOf("/w/fix-login", store)).toBeNull();
  });

  test("broken or foreign entries read as nothing, not a crash", () => {
    const store = memory();
    store.setItem("aura.movedToCloud.v1", JSON.stringify({ "/a": { workspaceId: "" }, "/b": moved(), "/c": 3 }));
    expect(Object.keys(readMovedToCloud(store))).toEqual(["/b"]);
    store.setItem("aura.movedToCloud.v1", "{not json");
    expect(readMovedToCloud(store)).toEqual({});
  });

  test("keeps the newest two hundred", () => {
    const store = memory();
    for (let i = 0; i < 205; i++) rememberMovedToCloud(`/w/${i}`, moved({ at: i }), store);
    const all = readMovedToCloud(store);
    expect(Object.keys(all).length).toBe(200);
    expect(all["/w/0"]).toBeUndefined();
    expect(all["/w/204"]).toBeDefined();
  });
});

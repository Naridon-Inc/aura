import { describe, expect, test } from "bun:test";

import {
  FOLDERS_MAX,
  folderLabel,
  folderParent,
  forgetFolder,
  rememberFolder,
} from "./terminalFolders";

const HOME = "/Users/me";

describe("naming a folder in the menu", () => {
  test("a folder is called by its own name", () => {
    expect(folderLabel("/Users/me/Documents/aura")).toBe("aura");
  });

  test("a trailing slash doesn't blank the name", () => {
    expect(folderLabel("/Users/me/Documents/aura/")).toBe("aura");
  });

  test("the root is called the root", () => {
    expect(folderLabel("/")).toBe("/");
  });

  test("where a folder sits tells two same-named ones apart", () => {
    expect(folderParent(`${HOME}/Documents/aura`)).toBe("/Users/me/Documents");
    expect(folderParent(`${HOME}/aura/`)).toBe("/Users/me");
  });

  test("a top-level folder's parent is the root", () => {
    expect(folderParent("/opt")).toBe("/");
  });
});

describe("remembering folders", () => {
  test("the newest pick leads", () => {
    const a = rememberFolder([], "/a");
    expect(rememberFolder(a, "/b")).toEqual(["/b", "/a"]);
  });

  test("picking a folder again moves it up instead of duplicating it", () => {
    const list = rememberFolder(rememberFolder([], "/a"), "/b");
    expect(rememberFolder(list, "/a")).toEqual(["/a", "/b"]);
  });

  test("the same place written two ways is one entry", () => {
    expect(rememberFolder(["/a"], "/a/")).toEqual(["/a"]);
  });

  test("the list is capped so the menu stays glanceable", () => {
    let list: string[] = [];
    for (let i = 0; i < FOLDERS_MAX + 4; i += 1) list = rememberFolder(list, `/p${i}`);
    expect(list).toHaveLength(FOLDERS_MAX);
    expect(list[0]).toBe(`/p${FOLDERS_MAX + 3}`);
    expect(list).not.toContain("/p0");
  });

  test("an empty path is not remembered", () => {
    expect(rememberFolder(["/a"], "")).toEqual(["/a"]);
  });

  test("forgetting drops exactly one folder", () => {
    expect(forgetFolder(["/a", "/b", "/c"], "/b")).toEqual(["/a", "/c"]);
    expect(forgetFolder(["/a", "/b"], "/b/")).toEqual(["/a"]);
    expect(forgetFolder(["/a"], "/zzz")).toEqual(["/a"]);
  });
});

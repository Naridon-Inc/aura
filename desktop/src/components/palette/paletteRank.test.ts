import { describe, expect, test } from "bun:test";

import { CATALOG_GROUP_ORDER, catalogGroupsFor, matchCatalog, rankCatalogGroups } from "./paletteRank";

describe("palette group ranking", () => {
  test("with nothing typed the groups keep their order", () => {
    expect(rankCatalogGroups("", [])).toEqual(CATALOG_GROUP_ORDER);
  });

  test("the group naming more of the query moves up", () => {
    expect(rankCatalogGroups("toggle theme", [])[0]).toBe("actions");
    expect(rankCatalogGroups("docs", [])[0]).toBe("navigation");
    expect(rankCatalogGroups("changes", [])[0]).toBe("workspace-actions");
  });

  test("the open-in group's words are the app names", () => {
    expect(rankCatalogGroups("cursor", ["Cursor", "Finder"])[0]).toBe("open-in");
  });

  test("ties keep the original order", () => {
    expect(rankCatalogGroups("zzz", [])).toEqual(CATALOG_GROUP_ORDER);
  });

  test("each tab draws its own groups", () => {
    expect(catalogGroupsFor("actions")).toEqual(["workspace-actions", "actions", "open-in"]);
    expect(catalogGroupsFor("settings")).toEqual(["settings"]);
    expect(catalogGroupsFor("workspaces")).toEqual([]);
  });
});

describe("palette row matching", () => {
  const rows = [
    { label: "Toggle theme", keywords: ["toggle", "theme", "dark", "light"] },
    { label: "Show keyboard shortcuts", keywords: ["show", "keyboard", "shortcuts", "keys", "hotkeys"] },
    { label: "Check for updates", keywords: ["check", "update", "updates", "version"] },
  ];

  test("every row when nothing is typed", () => {
    expect(matchCatalog(rows, "  ")).toHaveLength(3);
  });

  test("a keyword finds a row its label doesn't name", () => {
    expect(matchCatalog(rows, "dark").map((r) => r.label)).toEqual(["Toggle theme"]);
    expect(matchCatalog(rows, "hotkeys").map((r) => r.label)).toEqual(["Show keyboard shortcuts"]);
  });

  test("a query nothing scores keeps nothing", () => {
    expect(matchCatalog(rows, "qqqq")).toEqual([]);
  });
});

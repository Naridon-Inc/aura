import { describe, expect, test } from "bun:test";

import { catalogRows, type CatalogPlace } from "./paletteCatalog";

const local: CatalogPlace = { kind: "local", hasWorkspace: true, canArchive: true, theme: "dark", editors: [{ id: "cursor", name: "Cursor" }] };
const cloud: CatalogPlace = { ...local, kind: "cloud" };
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("palette catalog per place", () => {
  test("this computer offers the workspace's own actions", () => {
    expect(ids(catalogRows("workspace-actions", local, ""))).toEqual([
      "quick-open",
      "search-in-files",
      "show-changes",
      "show-all-files",
      "show-checks",
      "create-pull-request",
      "archive-workspace",
    ]);
  });

  test("the main checkout can't be archived", () => {
    expect(ids(catalogRows("workspace-actions", { ...local, canArchive: false }, ""))).not.toContain("archive-workspace");
  });

  test("the cloud has no checkout actions, no repository to add, and has Routines", () => {
    expect(catalogRows("workspace-actions", cloud, "")).toEqual([]);
    expect(catalogRows("open-in", cloud, "")).toEqual([]);
    expect(ids(catalogRows("actions", cloud, ""))).not.toContain("add-repository");
    expect(ids(catalogRows("navigation", cloud, ""))).toContain("routines");
    expect(ids(catalogRows("navigation", local, ""))).not.toContain("routines");
  });

  test("creating a workspace in the cloud opens the cloud's own create", () => {
    expect(catalogRows("actions", cloud, "")[0].run).toEqual({ kind: "cloud-create" });
    expect(catalogRows("actions", local, "")[0].run).toEqual({
      kind: "event",
      name: "aura:new-workspace",
      detail: { createFrom: true },
    });
  });

  test("the theme row is found by the theme in use", () => {
    expect(catalogRows("actions", local, "").find((r) => r.id === "toggle-theme")?.keywords).toContain("dark");
  });

  test("settings lists folded parts only once something is typed", () => {
    const bare = catalogRows("settings", local, "");
    const typed = catalogRows("settings", local, "hud");
    expect(typed.length).toBeGreaterThan(bare.length);
    expect(ids(typed)).toContain("settings-hud");
    expect(catalogRows("settings", local, "")[0].run).toEqual({
      kind: "event",
      name: "aura:open-settings",
      detail: { pane: "general" },
    });
  });

  test("open-in lists the apps on this computer", () => {
    expect(catalogRows("open-in", local, "")[0]).toMatchObject({ label: "Cursor", run: { kind: "open-in", app: "cursor" } });
  });
});

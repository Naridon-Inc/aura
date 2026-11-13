import { describe, expect, test } from "bun:test";

import type { PaletteEntry } from "../CommandPalette";
import type { CatalogPlace } from "./paletteCatalog";
import { NO_LANE_HITS } from "./paletteHits";
import { buildPaletteSections, sectionKeys, type SectionInput } from "./paletteSections";
import { CLEARED_WORKSPACE_FILTERS, DEFAULT_WORKSPACE_FILTERS, type PaletteWorkspace } from "./paletteWorkspaces";

function row(id: string, over: Partial<PaletteWorkspace> = {}): PaletteWorkspace {
  return {
    id,
    title: id,
    branch: `feat/${id}`,
    project: "aura",
    projectId: "/r/aura",
    stage: "in-progress",
    updatedAt: 0,
    timeLabel: "",
    archived: false,
    unread: false,
    live: false,
    repo: { kind: "local", root: "/r/aura" },
    fields: [id],
    ...over,
  };
}

const local: CatalogPlace = { kind: "local", hasWorkspace: true, canArchive: false, theme: "dark", editors: [] };
const more: PaletteEntry[] = [{ kind: "action", id: "toggle_terminal", label: "Toggle Terminal", hint: "⌘J" }];

function input(over: Partial<SectionInput> = {}): SectionInput {
  return {
    tab: "all",
    query: "",
    place: local,
    more,
    workspaces: [row("alpha", { updatedAt: 2 }), row("beta", { updatedAt: 1 })],
    activeId: null,
    repositories: [{ id: "/r/aura", name: "aura", repo: { kind: "local", root: "/r/aura" } }],
    lanes: NO_LANE_HITS,
    filters: DEFAULT_WORKSPACE_FILTERS,
    ...over,
  };
}

const headings = (s: ReturnType<typeof buildPaletteSections>) => s.map((x) => x.heading ?? null);

describe("palette sections", () => {
  test("All opens on the recent workspaces, the fixed groups, then Aura's own", () => {
    expect(headings(buildPaletteSections(input()))).toEqual([
      "Recent workspaces",
      "Workspace actions",
      "Actions",
      "Navigation",
      "Settings",
      "Aura",
    ]);
  });

  test("typing adds repositories and workspaces, and says when no workspace matched", () => {
    const found = buildPaletteSections(input({ query: "alpha" }));
    const ws = found.find((s) => s.key === "workspaces");
    expect(ws?.rows.map((r) => r.key)).toEqual(["workspace:alpha"]);

    const none = buildPaletteSections(input({ query: "zzzz" }));
    const empty = none.find((s) => s.key === "workspaces");
    expect(empty?.rows.map((r) => r.type)).toEqual(["none"]);
    expect(sectionKeys(none)).not.toContain("no-results");
  });

  test("the cloud lists no repositories of yours", () => {
    const cloud = buildPaletteSections(
      input({ query: "aura", place: { ...local, kind: "cloud" }, repositories: null }),
    );
    expect(cloud.some((s) => s.key === "repositories")).toBe(false);
  });

  test("Settings draws the settings only", () => {
    expect(headings(buildPaletteSections(input({ tab: "settings" })))).toEqual(["Settings"]);
  });

  test("Repositories draws its rows with no heading", () => {
    const repos = buildPaletteSections(input({ tab: "repositories" }));
    expect(repos.map((s) => [s.heading, s.rows.map((r) => r.key)])).toEqual([[undefined, ["repository:/r/aura"]]]);
  });

  test("Workspaces splits active from archived under its filters", () => {
    const rows = [row("alpha"), row("old", { archived: true })];
    expect(headings(buildPaletteSections(input({ tab: "workspaces", workspaces: rows })))).toEqual(["Workspaces"]);
    expect(
      headings(buildPaletteSections(input({ tab: "workspaces", workspaces: rows, filters: CLEARED_WORKSPACE_FILTERS }))),
    ).toEqual(["Workspaces", "Archived"]);
  });
});

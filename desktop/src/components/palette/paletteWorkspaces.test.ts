import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WORKSPACE_FILTERS,
  filterWorkspaces,
  filtersActive,
  recentWorkspaces,
  repositoriesOf,
  searchWorkspaces,
  toggleId,
  workspaceMatches,
  type PaletteWorkspace,
} from "./paletteWorkspaces";

function row(id: string, over: Partial<PaletteWorkspace> = {}): PaletteWorkspace {
  const base: PaletteWorkspace = {
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
    fields: [],
    ...over,
  };
  return { ...base, fields: over.fields ?? [base.title, base.branch, base.project, base.id] };
}

describe("palette workspace rows", () => {
  test("every word typed must be somewhere in the row", () => {
    const r = row("login", { branch: "feat/oauth", project: "web" });
    expect(workspaceMatches(r, "oauth web")).toBe(true);
    expect(workspaceMatches(r, "oauth mobile")).toBe(false);
    expect(workspaceMatches(r, "  ")).toBe(true);
  });

  test("recent: latest five active, without the one in front", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(`w${n}`, { updatedAt: n }));
    rows.push(row("old", { updatedAt: 99, archived: true }));
    expect(recentWorkspaces(rows, "w7").map((r) => r.id)).toEqual(["w6", "w5", "w4", "w3", "w2"]);
  });

  test("search splits active from archived, latest first", () => {
    const rows = [row("a", { updatedAt: 1 }), row("b", { updatedAt: 2 }), row("c", { updatedAt: 3, archived: true })];
    const { active, archived } = searchWorkspaces(rows, "feat");
    expect(active.map((r) => r.id)).toEqual(["b", "a"]);
    expect(archived.map((r) => r.id)).toEqual(["c"]);
  });

  test("the Workspaces tab hides archived by default and narrows by repository and owner", () => {
    const rows = [
      row("a", { projectId: "x", owner: "me" }),
      row("b", { projectId: "y", owner: "you" }),
      row("c", { projectId: "x", archived: true }),
    ];
    expect(filterWorkspaces(rows, "", DEFAULT_WORKSPACE_FILTERS).total).toBe(2);
    expect(filterWorkspaces(rows, "", { owners: [], projects: ["x"], archive: "all" }).total).toBe(2);
    expect(filterWorkspaces(rows, "", { owners: ["you"], projects: [], archive: "all" }).active.map((r) => r.id)).toEqual(["b"]);
    expect(filterWorkspaces(rows, "", { owners: [], projects: [], archive: "archived" }).archived.map((r) => r.id)).toEqual(["c"]);
  });

  test("hiding archived counts as a filter you can clear", () => {
    expect(filtersActive(DEFAULT_WORKSPACE_FILTERS)).toBe(true);
    expect(filtersActive({ owners: [], projects: [], archive: "all" })).toBe(false);
  });

  test("repositories are listed once each, by name", () => {
    const rows = [row("a", { projectId: "2", project: "web" }), row("b", { projectId: "1", project: "api" }), row("c", { projectId: "2", project: "web" })];
    expect(repositoriesOf(rows).map((r) => r.name)).toEqual(["api", "web"]);
  });

  test("a multi-pick toggles one id", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });
});

import { describe, expect, test } from "bun:test";

import type { Workspace, WorktreeRef } from "../../../../lib/workspaceRef";
import { layoutRoster, type RosterLayoutInput } from "../rosterLayout";
import { sectionKey, type RosterSectionDef } from "./sectionModel";

// A workspace you put in a section is listed there, between "Pinned" and the
// repositories, and nowhere else.

const ROOT = "/code/app";
const A = "/code/app-a";
const B = "/code/app-b";

const ref = (path: string, over: Partial<WorktreeRef> = {}): WorktreeRef => ({
  path,
  branch: path.slice(-1),
  head: "abc",
  is_main: false,
  locked: false,
  ...over,
});

const ws = {
  id: ROOT,
  worktrees: [ref(ROOT, { is_main: true, branch: "main" }), ref(A), ref(B)],
} as Workspace;

const sections: RosterSectionDef[] = [
  { id: "s", name: "Review", paths: [B, A, "/gone"] },
  { id: "t", name: "Empty", paths: [] },
];

const lay = (over: Partial<RosterLayoutInput> = {}) =>
  layoutRoster({
    workspaces: [ws],
    sort: "updated",
    custom: {},
    activePath: A,
    now: Date.now(),
    agentCount: () => 0,
    visited: {},
    collapsed: {},
    expanded: {},
    workingRoots: new Set(),
    sections,
    ...over,
  });

const paths = (rows: { w: WorktreeRef }[]) => rows.map((r) => r.w.path);

describe("sections in the workspace list", () => {
  test("a sectioned workspace leaves its repository", () => {
    const out = lay();
    expect(paths(out.sections[0].rows)).toEqual([B, A]);
    expect(out.rest[0].rows.map((w) => w.path)).toEqual([]);
    expect(out.sections[1].rows).toEqual([]);
  });

  test("pinned wins over a section", () => {
    const out = lay({ custom: { [A]: { pinned: true } } });
    expect(paths(out.sections[0].rows)).toEqual([B]);
    expect(paths(out.pinnedRows)).toEqual([A]);
  });

  test("sections number between pinned and the repositories", () => {
    expect(lay().switchPaths).toEqual([B, A]);
  });

  test("a folded section still numbers the open workspace", () => {
    const out = lay({ collapsed: { [sectionKey("s")]: true } });
    expect(out.sections[0].collapsed).toBe(true);
    expect(out.switchPaths).toEqual([A]);
  });

  test("the main checkout is never taken into a section", () => {
    const out = lay({
      activePath: ROOT,
      sections: [{ id: "s", name: "S", paths: [ROOT] }],
    });
    expect(out.sections[0].rows).toEqual([]);
    expect(out.rest[0].rows.map((w) => w.path)).toContain(ROOT);
  });
});

// A repository dragged in by its header is listed whole inside the section,
// with its own header, and leaves "My workspaces".

const OTHER = "/code/site";
const OTHER_COPY = "/code/site-x";
const other = {
  id: OTHER,
  worktrees: [ref(OTHER, { is_main: true, branch: "main" }), ref(OTHER_COPY)],
} as Workspace;

const filed = (over: Partial<RosterLayoutInput> = {}) =>
  lay({
    workspaces: [ws, other],
    activePath: "/nowhere",
    // Every workspace painted, quiet ones too, so the numbers show the order.
    expanded: { [ROOT]: true, [OTHER]: true },
    sections: [
      { id: "s", name: "Review", paths: [B], repos: [OTHER] },
      { id: "t", name: "Later", paths: [] },
    ],
    ...over,
  });

describe("repositories filed in sections", () => {
  test("a filed repository is drawn in its section and not under My workspaces", () => {
    const out = filed();
    expect(out.sections[0].repos.map((r) => r.ws.id)).toEqual([OTHER]);
    expect(out.sections[0].repos[0].rows.map((w) => w.path)).toEqual([OTHER_COPY]);
    expect(out.rest.map((r) => r.ws.id)).toEqual([ROOT]);
    expect(out.sections[1].repos).toEqual([]);
  });

  test("numbers follow the painted order: section rows, its repositories, then the rest", () => {
    expect(filed().switchPaths).toEqual([B, OTHER_COPY, A]);
  });

  test("a folded section paints none of its repositories", () => {
    const out = filed({ collapsed: { [sectionKey("s")]: true } });
    expect(out.switchPaths).toEqual([A]);
  });

  test("a folded repository inside a section numbers nothing of its own", () => {
    const out = filed({ collapsed: { [OTHER]: true } });
    expect(out.sections[0].repos[0].collapsed).toBe(true);
    expect(out.switchPaths).toEqual([B, A]);
  });

  test("pinned wins over a section for a repository too", () => {
    const out = filed({ custom: { [OTHER]: { pinned: true } } });
    expect(out.pinned.map((r) => r.ws.id)).toEqual([OTHER]);
    expect(out.sections[0].repos).toEqual([]);
    expect(out.rest.map((r) => r.ws.id)).toEqual([ROOT]);
  });

  test("an archived repository leaves its section for the archive", () => {
    const out = filed({ custom: { [OTHER]: { archived: 1 } } });
    expect(out.sections[0].repos).toEqual([]);
    expect(out.archived.map((w) => w.id)).toEqual([OTHER]);
  });

  test("a repository named by two sections is drawn once, in the first", () => {
    const out = filed({
      sections: [
        { id: "s", name: "S", paths: [], repos: [OTHER] },
        { id: "t", name: "T", paths: [], repos: [OTHER] },
      ],
    });
    expect(out.sections[0].repos.map((r) => r.ws.id)).toEqual([OTHER]);
    expect(out.sections[1].repos).toEqual([]);
  });

  test("a workspace of a filed repository can still be pinned on its own", () => {
    const out = filed({ custom: { [OTHER_COPY]: { pinned: true } } });
    expect(paths(out.pinnedRows)).toEqual([OTHER_COPY]);
    expect(out.sections[0].repos[0].rows).toEqual([]);
  });

  test("a repository that is gone is skipped", () => {
    const out = filed({ workspaces: [ws] });
    expect(out.sections[0].repos).toEqual([]);
  });
});

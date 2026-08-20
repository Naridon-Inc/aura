// Clicking a project in the sidebar means "take me to this project".
//
// Tasks, Team, Pages, Workspaces, Aura and Trace render as an opaque cover
// *over* the work surface. So switching the open project while one of them is
// up changed which project the code underneath belonged to and left the cover
// exactly where it was — the user asked to go somewhere and stayed put. Worse,
// clicking the project you were already in did nothing at all: the handler's
// only statement was a `root !== project.root` guard, so the click was dead.
//
// Each of those pages carries its own project picker in its own rail
// (PlaceRailScope → setProjectScope). That is the deliberate way to ask a page
// about a different project, and it still works. The sidebar roster is the
// other question, and its answer is: leave.
//
// This is scanned rather than rendered because the bug lives in the wiring —
// which handler calls which function — not in what any component draws.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const app = await readSrc("App.tsx");

/** The body of a `const <name> = useCallback(` declaration in App.tsx. */
function callbackBody(name: string): string {
  const body = app.match(
    new RegExp(`const ${name} = useCallback\\(([\\s\\S]*?)\\n  \\);`),
  )?.[1];
  return body ?? "";
}

describe("goToProject", () => {
  it("exists as one named door rather than a leavePages sprinkled per call site", () => {
    expect(callbackBody("goToProject")).not.toBe("");
  });

  it("leaves the covering page", () => {
    expect(callbackBody("goToProject")).toContain("leavePages()");
  });

  it("leaves it before the same-root guard, so the click is never dead", () => {
    // The guard is about not reloading a workspace you are already in. It is
    // not about whether to navigate — clicking your current project from
    // Tasks still means "show me its code".
    const body = callbackBody("goToProject");
    const left = body.indexOf("leavePages()");
    const guard = body.indexOf("projectRootRef.current");
    expect(left).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(left);
  });

  it("still avoids reloading the workspace you are already in", () => {
    expect(callbackBody("goToProject")).toMatch(
      /if \(root === projectRootRef\.current\) return;/,
    );
  });
});

describe("the sidebar roster", () => {
  it("routes a project click through goToProject", () => {
    // WorkspaceRoster's project row, its worktree/copy rows and ⌘1–⌘9 all
    // arrive on these two props.
    expect(app).toMatch(/onOpenWorktree=\{\(p\) => goToProject\(p\)\}/);
    const select = app.match(/onSelectProject=\{\(id\) => \{[\s\S]*?\n {18}\}\}/)?.[0] ?? "";
    expect(select).toContain("goToProject(id)");
    // The bare switch was the bug: it changed the project and nothing else.
    expect(select).not.toContain("loadProjectAt(");
  });
});

describe("the command palette", () => {
  it("makes a workspace jump mean the same thing as a roster click", () => {
    const arm = app.match(/if \(entry\.kind === "workspace"\) \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(arm).toContain("goToProject(entry.root)");
  });

  it("uncovers the work surface before opening a conversation into it", () => {
    // openManager opens a workpane. A workpane opened under a page cover does
    // open — focused, in the tab strip, entirely invisible.
    const arm = app.match(/if \(entry\.kind === "chat"\) \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(arm).toContain("leavePages()");
  });
});

describe("loadProjectAt", () => {
  it("does not navigate, because boot and auto-followed worktrees use it too", () => {
    // Hoisting leavePages() into loadProjectAt looks like the tidier fix and
    // is not: it would yank the view on app start and whenever an agent's
    // worktree is auto-followed. Deciding where to stand belongs to callers.
    const body = app.match(
      /const loadProjectAt = useCallback\(([\s\S]*?)\n {2}\}, \[editor\]\);/,
    )?.[1];
    expect(body).toBeTruthy();
    expect(body).not.toContain("leavePages()");
    expect(body).not.toContain("setPlace(");
    expect(body).not.toContain("setWsOpen(");
    expect(body).not.toContain("setTracePage(");
  });
});

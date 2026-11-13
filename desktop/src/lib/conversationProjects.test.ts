import { describe, expect, test } from "bun:test";
import { conversationProjects, projectsCaption, projectsTooltip } from "./conversationProjects";

describe("conversationProjects", () => {
  test("lists every bound root when the row carries them", () => {
    const s = { repo_root: "/w/alpha", project_count: 2, projects: ["/w/alpha", "/w/beta"] };
    expect(conversationProjects(s)).toEqual(["/w/alpha", "/w/beta"]);
    expect(projectsCaption(s)).toBe("alpha +1");
    expect(projectsTooltip(s)).toBe("/w/alpha\n/w/beta");
  });

  test("a single-project conversation is shown, named by its folder", () => {
    const s = { repo_root: "/w/alpha/", project_count: 1, projects: ["/w/alpha/"] };
    expect(projectsCaption(s)).toBe("alpha");
  });

  test("an older backend's row falls back to the first root and the count", () => {
    const s = { repo_root: "/w/alpha", project_count: 3 };
    expect(conversationProjects(s)).toEqual(["/w/alpha"]);
    expect(projectsCaption(s)).toBe("alpha +2");
    expect(projectsTooltip(s)).toBe("/w/alpha\nand 2 more");
  });

  test("a conversation bound to nothing says nothing", () => {
    const s = { repo_root: null, project_count: 0, projects: [] };
    expect(conversationProjects(s)).toEqual([]);
    expect(projectsCaption(s)).toBe("");
    expect(projectsTooltip(s)).toBe("");
  });

  test("blank roots never become a project", () => {
    const s = { repo_root: "/w/alpha", projects: ["", "  "] };
    expect(conversationProjects(s)).toEqual(["/w/alpha"]);
  });
});

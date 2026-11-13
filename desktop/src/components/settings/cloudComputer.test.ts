import { describe, expect, test } from "bun:test";
import type { BoxProject, Machine } from "../../lib/api";
import { computerRepos, groupComputers, installScript, placeOfRepo } from "./cloudComputer";

function row(over: Partial<Machine>): Machine {
  return {
    id: "m-0000000000000001",
    name: "aura-runner",
    host: "box.example",
    user: "ubuntu",
    key_path: "~/.ssh/box",
    box_kind: "mine",
    repo_path: "/home/ubuntu/aura",
    project_root: "/Users/me/aura",
    repo_branch: "main",
    ...over,
  } as Machine;
}

function held(path: string, over: Partial<BoxProject> = {}): BoxProject {
  return { path, name: path.split("/").filter(Boolean).pop() ?? path, remote: null, branch: "main", dirty: 0, ...over };
}

describe("groupComputers", () => {
  test("folds rows on one box into one computer, shared first", () => {
    const list = groupComputers([
      row({ id: "a", host: "one" }),
      row({ id: "b", host: "one", repo_path: "/home/ubuntu/web", project_root: "/Users/me/web" }),
      row({ id: "c", host: "two", box_kind: "shared" }),
    ]);
    expect(list.map((c) => c.key)).toEqual(["ubuntu@two", "ubuntu@one"]);
    expect(list[1].repos.map((r) => r.label)).toEqual(["aura", "web"]);
    expect(list[1].repos.every((r) => r.booked)).toBe(true);
  });

  test("two folders with the same name keep apart by path", () => {
    const [c] = groupComputers([
      row({ id: "a", repo_path: "/home/ubuntu/aura" }),
      row({ id: "b", repo_path: "/home/ubuntu/workspaces/aura" }),
    ]);
    expect(c.repos.map((r) => r.label)).toEqual(["aura", "/home/ubuntu/workspaces/aura"]);
  });
});

describe("computerRepos", () => {
  const [computer] = groupComputers([row({ id: "a" })]);

  test("without the box's answer the list is the book's", () => {
    expect(computerRepos(computer, null)).toBe(computer.repos);
  });

  test("lists every repository the box holds, not just the booked one", () => {
    const list = computerRepos(computer, [
      held("/home/ubuntu/aura", { branch: "release" }),
      held("/home/ubuntu/web"),
      held("/home/ubuntu/aura-workspaces/acme__api", { name: "api" }),
    ]);
    expect(list.map((r) => r.label)).toEqual(["aura", "web", "api"]);
    expect(list.map((r) => r.booked)).toEqual([true, false, false]);
    // The booked one keeps its own row and takes the box's fresher branch.
    expect(list[0].row.id).toBe("a");
    expect(list[0].branch).toBe("release");
    // Box-only ones are reached through the same box, at their own folder.
    expect(list[1].row.id).toBe("a");
    expect(list[1].path).toBe("/home/ubuntu/web");
    expect(list[2].path).toBe("/home/ubuntu/aura-workspaces/acme__api");
  });

  test("matches book and box paths through a trailing slash", () => {
    const list = computerRepos(computer, [held("/home/ubuntu/aura/")]);
    expect(list).toHaveLength(1);
    expect(list[0].booked).toBe(true);
  });

  test("keeps a booked row the box no longer lists", () => {
    const list = computerRepos(computer, [held("/home/ubuntu/web")]);
    expect(list.map((r) => [r.label, r.booked])).toEqual([
      ["web", false],
      ["aura", true],
    ]);
  });

  test("two held folders with one name keep apart", () => {
    const list = computerRepos(computer, [held("/home/ubuntu/aura"), held("/home/ubuntu/workspaces/aura")]);
    expect(list.map((r) => r.label)).toEqual(["aura", "/home/ubuntu/workspaces/aura"]);
  });

  test("a box that answers with nothing still shows the book's row", () => {
    const list = computerRepos(computer, []);
    expect(list.map((r) => r.label)).toEqual(["aura"]);
  });
});

describe("placeOfRepo", () => {
  test("a booked repository is its own row; one only on the box borrows the row at its own folder", () => {
    const [computer] = groupComputers([row({ id: "a" })]);
    const [booked, boxOnly] = computerRepos(computer, [held("/home/ubuntu/aura"), held("/home/ubuntu/web")]);
    expect(placeOfRepo(booked).project).toEqual({ root: "/Users/me/aura", path: "/home/ubuntu/aura", branch: "main" });
    const there = placeOfRepo(boxOnly);
    expect(there.machineId).toBe("a");
    // No folder on this laptop stands in for it.
    expect(there.project).toEqual({ root: null, path: "/home/ubuntu/web", branch: "main" });
  });
});

describe("installScript", () => {
  test("says what each repository declares, and doesn't guess for one only on the box", () => {
    const text = installScript([
      { label: "aura", text: "[env]\nnode = \"20\"" },
      { label: "web", text: null },
      { label: "api", text: undefined },
    ]);
    expect(text).toContain("# aura\n[env]");
    expect(text).toContain("# web\n# declares no [env] block");
    expect(text).toContain("# api\n# only on the computer");
    expect(text).not.toContain("# api\n# declares no");
  });
});

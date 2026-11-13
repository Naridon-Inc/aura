// Linked workspaces: what a workspace saved before links existed reads as,
// linking and unlinking, what a launch is handed, which engines can use a
// link (in step with the Rust side that builds the flags), how the dialog
// groups and filters, and the wiring from the composer to each launch.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { api, type ProjectEntry, type WorktreeEntry } from "./api";
import {
  getLinkedDirectoryPaths,
  getLinkedWorkspaceIds,
  linkDirectory,
  linkedDirsForLaunch,
  linkWorkspace,
  setWorkspaceArchived,
  setWorkspaceName,
  unlinkDirectory,
  unlinkWorkspace,
} from "./workspaceCustomization";
import {
  agentReadsLinkedDirs,
  groupLinkable,
  isMissing,
  LINKED_DIR_AGENTS,
  loadLinkableWorkspaces,
  UNKNOWN_REPOSITORY,
  withGoneLinks,
  type LinkableWorkspace,
} from "./workspaceLinks";
import { unsupportedLinkNote } from "../components/manager/useLinkWorkspaces";

const SRC = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const RUST = join(import.meta.dir, "..", "..", "src-tauri", "src");
const readRust = (rel: string) => readFileSync(join(RUST, rel), "utf8");

// Roots no other suite uses, so the shared store can't cross-talk.
const HERE = "/tmp/links-test/here";
const OTHER = "/tmp/links-test/other";
const THIRD = "/tmp/links-test/third";

describe("stored links", () => {
  test("a workspace saved before links existed has none", () => {
    setWorkspaceName(HERE, "Here");
    expect(getLinkedWorkspaceIds(HERE)).toEqual([]);
    expect(getLinkedDirectoryPaths(HERE)).toEqual([]);
    expect(linkedDirsForLaunch(HERE)).toEqual([]);
    expect(getLinkedWorkspaceIds("/never/seen")).toEqual([]);
  });

  test("link and unlink, once each, never to itself", () => {
    linkWorkspace(HERE, OTHER);
    linkWorkspace(HERE, OTHER);
    linkWorkspace(HERE, HERE);
    linkDirectory(HERE, "/tmp/links-test/notes");
    linkDirectory(HERE, "  ");
    expect(getLinkedWorkspaceIds(HERE)).toEqual([OTHER]);
    expect(getLinkedDirectoryPaths(HERE)).toEqual(["/tmp/links-test/notes"]);
    unlinkWorkspace(HERE, OTHER);
    unlinkDirectory(HERE, "/tmp/links-test/notes");
    expect(getLinkedWorkspaceIds(HERE)).toEqual([]);
    expect(getLinkedDirectoryPaths(HERE)).toEqual([]);
  });

  test("the last unlink removes the setting instead of storing an empty list", () => {
    linkWorkspace(THIRD, OTHER);
    unlinkWorkspace(THIRD, OTHER);
    // The entry had nothing else, so it is gone: renaming starts from scratch.
    expect(getLinkedWorkspaceIds(THIRD)).toEqual([]);
  });

  test("a launch gets linked workspaces that aren't archived, then folders", () => {
    linkWorkspace(HERE, OTHER);
    linkWorkspace(HERE, THIRD);
    linkDirectory(HERE, OTHER);
    linkDirectory(HERE, "/tmp/links-test/notes");
    expect(linkedDirsForLaunch(HERE)).toEqual([OTHER, THIRD, "/tmp/links-test/notes"]);
    setWorkspaceArchived(THIRD, true);
    expect(linkedDirsForLaunch(HERE)).toEqual([OTHER, "/tmp/links-test/notes"]);
    setWorkspaceArchived(THIRD, false);
    expect(linkedDirsForLaunch("")).toEqual([]);
  });

  afterAll(() => {
    for (const root of [HERE, THIRD]) {
      for (const id of getLinkedWorkspaceIds(root)) unlinkWorkspace(root, id);
      for (const p of getLinkedDirectoryPaths(root)) unlinkDirectory(root, p);
    }
    setWorkspaceName(HERE, undefined);
  });
});

describe("which engines read linked folders", () => {
  test("agents with a real flag, by id, alias or wrapped as a chat brain", () => {
    for (const id of ["claude", "cc", "cli_wrapper:claude_code", "codex", "cx", "gemini", "cli_wrapper:gemini", "kimi", "agy", "antigravity"]) {
      expect(agentReadsLinkedDirs(id)).toBe(true);
    }
  });

  test("agents without one, and brains that run their own tools, don't", () => {
    for (const id of ["cursor", "opencode", "pi", "acp:opencode", "anthropic", "gemini_native", "cli_wrapper:cursor", null, undefined, ""]) {
      expect(agentReadsLinkedDirs(id)).toBe(false);
    }
  });

  test("the list matches the agents the launch builds flags for", () => {
    const rust = readRust("manager/brain/linked_dirs.rs");
    const built = [...rust.matchAll(/^\s*"([a-z]+)" => Some\(\("--/gm)].map((m) => m[1]).sort();
    expect(built).toEqual([...LINKED_DIR_AGENTS].sort());
  });

  test("the dialog says so, quietly, only for an engine it knows can't", () => {
    expect(unsupportedLinkNote("acp:opencode", "OpenCode")).toBe("OpenCode can't read linked folders.");
    expect(unsupportedLinkNote("anthropic", null)).toBe("This agent can't read linked folders.");
    expect(unsupportedLinkNote("cli_wrapper:claude_code", "Claude Code")).toBeNull();
    expect(unsupportedLinkNote(null, null)).toBeNull();
  });
});

function ws(id: string, repo: string, extra: Partial<LinkableWorkspace> = {}): LinkableWorkspace {
  return {
    id,
    name: id.split("/").pop() ?? id,
    directoryName: id.split("/").pop() ?? id,
    branch: null,
    repoId: `/repos/${repo}`,
    repoName: repo,
    archived: false,
    ...extra,
  };
}

describe("the dialog's list", () => {
  const all = [
    ws("/repos/app", "app", { branch: "main" }),
    ws("/repos/app/.aura/worktrees/kyoto", "app", { branch: "feat/login" }),
    ws("/repos/api", "api", { branch: "main" }),
    ws("/repos/api/.aura/worktrees/old", "api", { archived: true }),
    ws("/repos/web", "web", { branch: "main" }),
  ];

  test("groups by project and leaves out the current one", () => {
    const groups = groupLinkable(all, "/repos/web", "");
    expect(groups.map((g) => g.repoName)).toEqual(["app", "api"]);
    expect(groups[0].rows.map((r) => r.directoryName)).toEqual(["app", "kyoto"]);
  });

  test("filters by folder, branch or project name", () => {
    expect(groupLinkable(all, null, "kyo").flatMap((g) => g.rows.map((r) => r.id))).toEqual([
      "/repos/app/.aura/worktrees/kyoto",
    ]);
    expect(groupLinkable(all, null, "LOGIN").flatMap((g) => g.rows.map((r) => r.directoryName))).toEqual(["kyoto"]);
    expect(groupLinkable(all, null, "api").map((g) => g.repoName)).toEqual(["api"]);
    expect(groupLinkable(all, null, "nothing like it")).toEqual([]);
  });

  test("an archived or deleted workspace shows only while linked, as missing", () => {
    const old = "/repos/api/.aura/worktrees/old";
    const deleted = "/gone/copy";
    expect(groupLinkable(all, null, "").flatMap((g) => g.rows.map((r) => r.id))).not.toContain(old);
    const linked = new Set([old, deleted]);
    const groups = groupLinkable(withGoneLinks(all, [old, deleted]), null, "", linked);
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.filter(isMissing).map((r) => r.id)).toEqual([old, deleted]);
    expect(groups[groups.length - 1].repoName).toBe(UNKNOWN_REPOSITORY);
  });

  test("reads every project's checkouts and finds the current project", async () => {
    const projects: ProjectEntry[] = [
      { id: "1", label: "app", root: "/repos/app", last_opened_at: 0 },
      { id: "2", label: "api", root: "/repos/api", last_opened_at: 0 },
    ];
    const lists: Record<string, WorktreeEntry[]> = {
      "/repos/app": [
        { path: "/repos/app", branch: "main", head: "a", is_main: true, locked: false },
        { path: "/repos/app/.aura/worktrees/kyoto", branch: "feat/login", head: "b", is_main: false, locked: false },
      ],
    };
    const realProjects = api.projectsList;
    const realList = api.gitWorktreeList;
    api.projectsList = async () => projects;
    api.gitWorktreeList = async (root: string) => {
      const list = lists[root];
      if (!list) throw new Error("not a repository");
      return list;
    };
    try {
      const result = await loadLinkableWorkspaces("/repos/app/.aura/worktrees/kyoto");
      expect(result.currentRepoId).toBe("/repos/app");
      expect(result.workspaces.map((w) => [w.id, w.repoName])).toEqual([
        ["/repos/app", "app"],
        ["/repos/app/.aura/worktrees/kyoto", "app"],
        // A project whose checkouts can't be read still offers its main one.
        ["/repos/api", "api"],
      ]);
    } finally {
      api.projectsList = realProjects;
      api.gitWorktreeList = realList;
    }
  });
});

describe("wiring", () => {
  test("each launch from this laptop carries the links; a machine gets none", () => {
    const src = read("lib/api.ts");
    expect(src).toContain("linkedDirs: machineId ? null : launchLinks(repoRoot),");
    expect(src).toContain("linkedDirs: launchLinks(repoRoot),");
    expect(src).toContain("contextJson: withLaunchLinks(contextJson ?? null, repoRoot),");
    expect(src).toContain('invoke<string[]>("linked_dirs_missing", { paths })');
  });

  test("the launch hands links over only for an agent started here", () => {
    const wrapper = readRust("manager/brain/cli_wrapper.rs");
    const local = wrapper.slice(wrapper.indexOf("None => {"), wrapper.indexOf("spawn_here(&invocation"));
    expect(local).toContain("linked_dirs::apply(&agent_id, &mut invocation.args, &dirs)");
    const pty = readRust("cmd_agent_pty.rs");
    const here = pty.slice(pty.indexOf("let (bin, args) = match &place {"), pty.indexOf("Some(p) => {", pty.indexOf("let (bin, args) = match &place {")));
    expect(here).toContain("linked_dirs::apply(&agent_id, &mut args, &dirs)");
    const stream = readRust("cmd_agent_stream.rs");
    expect(stream).toContain("linked_dirs::acp_args(&agent_id, &linked_dirs)");
    expect(stream).toContain("linked_dirs::apply(&agent_id, &mut inv.args, &linked_dirs)");
    expect(readRust("chat_acp.rs")).toContain(".args(&spec.extra_args)");
  });

  test("the add menu opens the dialog when the chat has a workspace", () => {
    const composer = read("components/manager/ManagerComposer.tsx");
    expect(composer).toContain("onWorkspace={repoRoot ? workspaceLinks.toggle : undefined}");
    expect(composer).toContain("<LinkWorkspacesDialog {...workspaceLinks.dialog} />");
    expect(read("components/manager/ManagerChatView.tsx")).toContain("linkAgentId={turnBrainId}");
    const menu = read("components/ui/composer-tools.tsx");
    expect(menu).toMatch(/<FolderSymlink \/>\s*<span className="ui-menu-text">Link workspaces<\/span>/);
  });
});

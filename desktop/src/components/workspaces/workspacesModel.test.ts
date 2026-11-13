import { describe, expect, test } from "bun:test";

import { buildCopies, type ProjectMeta } from "./workspacesModel";
import { copyOverview } from "./workspacesOverview";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";

// Everything the Workspaces page knows about a copy is read out of the local
// checkout, which is fine until a runner starts holding branches: then the one
// copy a machine is actively changing is also the one that looks most idle on
// this disk. These cover the two ways that used to go wrong — the fact being
// dropped on the way into the view model, and the way the row then reads.

const PROJECT: ProjectMeta = {
  id: "/repo",
  name: "Repo",
  letter: "R",
};

const NOW = 1_700_000_000_000;

function copiesWith(badge: WorktreeBadge) {
  return buildCopies({
    projects: [PROJECT],
    worktreesByRoot: {
      "/repo": [
        {
          path: "/repo/wt",
          branch: "feat/thing",
          head: "abc",
          is_main: false,
          locked: false,
          head_committed_at: 1_700_000_000,
          created_at: 1_699_000_000,
        },
      ],
    },
    badgeByPath: { "/repo/wt": badge },
    agentsByPath: new Map(),
    activePath: "/other",
  });
}

function rowOf(badge: WorktreeBadge) {
  const [copy] = copiesWith(badge);
  return copyOverview({ copy: copy!, nowMs: NOW, pr: null, git: null, archived: false });
}

const CLEAN = { added: 0, removed: 0, changedFiles: 0 };

describe("a copy running on a machine", () => {
  test("carries the placement into the view model", () => {
    const [copy] = copiesWith({
      ...CLEAN,
      cloud: { branch: "feat/thing", id: "j1", status: "working", agent: "claude" },
    });
    expect(copy!.cloud?.agent).toBe("claude");
  });

  test("reads as being worked on, not at rest", () => {
    // Nothing local says anything is happening: no agent on this disk, no
    // uncommitted diff, not the open copy. Before the placement was read, the
    // honest-looking answer was "at rest" — the row you skip.
    const row = rowOf({
      ...CLEAN,
      cloud: { branch: "feat/thing", id: "j1", status: "working", agent: "codex" },
    });
    expect(row.workflow.state).toBe("working");
    expect(row.stage).toBe("in-progress");
    expect(row.summary).toBe("Running on another machine");
  });

  test("a queued job does not claim a machine is on it", () => {
    // `submitted` means nobody has picked it up. Drawing the working mark
    // would put a spinner on a copy with no agent running.
    const row = rowOf({
      ...CLEAN,
      cloud: { branch: "feat/thing", id: "j1", status: "submitted", agent: "codex" },
    });
    expect(row.workflow.state).not.toBe("working");
    // The stage is the PR's alone (no PR: in progress); only the mark and
    // the summary speak to the queue.
    expect(row.stage).toBe("in-progress");
    expect(row.summary).toBe("Waiting for a machine");
  });

  test("local work still outranks it. An agent waiting on you comes first", () => {
    const copies = buildCopies({
      projects: [PROJECT],
      worktreesByRoot: {
        "/repo": [
          {
            path: "/repo/wt",
            branch: "feat/thing",
            head: "abc",
            is_main: false,
            locked: false,
            head_committed_at: 1_700_000_000,
          },
        ],
      },
      badgeByPath: {
        "/repo/wt": {
          ...CLEAN,
          cloud: { branch: "feat/thing", id: "j1", status: "working", agent: "codex" },
        },
      },
      agentsByPath: new Map([
        ["/repo/wt", [{ agentId: "claude", label: "Claude", attention: true }]],
      ]),
      activePath: "/other",
    });
    const row = copyOverview({
      copy: copies[0]!,
      nowMs: NOW,
      pr: null,
      git: null,
      archived: false,
    });
    expect(row.summary).toBe("Claude needs you");
    expect(row.unread).toBe(true);
  });
});

describe("the copy's own dates", () => {
  test("creation time comes from the checkout, in milliseconds", () => {
    const row = rowOf(CLEAN);
    expect(row.createdAt).toBe(1_699_000_000_000);
    expect(row.updatedAt).toBe(1_700_000_000_000);
  });

  test("a main checkout with no listed worktrees has no creation time", () => {
    const [copy] = buildCopies({
      projects: [PROJECT],
      worktreesByRoot: {},
      badgeByPath: {},
      agentsByPath: new Map(),
      activePath: "/repo",
    });
    expect(copy!.createdAt).toBeNull();
    expect(copy!.isMain).toBe(true);
  });
});

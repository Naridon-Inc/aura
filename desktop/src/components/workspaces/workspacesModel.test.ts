import { describe, expect, test } from "bun:test";

import { buildCopies, groupByStatus, type ProjectMeta } from "./workspacesModel";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";

// Everything the fleet views know about a copy is read out of the local
// checkout, which is fine until a runner starts holding branches: then the one
// copy a machine is actively changing is also the one that looks most idle on
// this disk. These cover the two ways that used to go wrong — the fact being
// dropped on the way into the view model, and the lane it lands in.

const PROJECT: ProjectMeta = {
  id: "/repo",
  name: "Repo",
  letter: "R",
};

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
        },
      ],
    },
    badgeByPath: { "/repo/wt": badge },
    agentsByPath: new Map(),
    activePath: "/other",
  });
}

describe("a copy running on a machine", () => {
  test("carries the placement into the view model", () => {
    const [copy] = copiesWith({
      added: 0,
      removed: 0,
      changedFiles: 0,
      cloud: { branch: "feat/thing", id: "j1", status: "working", agent: "claude" },
    });
    expect(copy.cloud?.agent).toBe("claude");
  });

  test("lands in 'Agent on it', not 'Resting'", () => {
    // Nothing local says anything is happening: no agent on this disk, no
    // uncommitted diff, not the open copy. Before the placement was read, the
    // honest-looking answer was "Resting" — the lane you skip.
    const columns = groupByStatus(
      copiesWith({
        added: 0,
        removed: 0,
        changedFiles: 0,
        cloud: { branch: "feat/thing", id: "j1", status: "working", agent: "codex" },
      }),
    );
    expect(columns.map((c) => c.status)).toEqual(["working"]);
  });

  test("a queued job does not claim a machine is on it", () => {
    // `submitted` means nobody has picked it up. Promoting it to "Agent on it"
    // would put a copy in the running lane with no agent running.
    const columns = groupByStatus(
      copiesWith({
        added: 0,
        removed: 0,
        changedFiles: 0,
        cloud: { branch: "feat/thing", id: "j1", status: "submitted", agent: "codex" },
      }),
    );
    expect(columns.map((c) => c.status)).toEqual(["idle"]);
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
          added: 0,
          removed: 0,
          changedFiles: 0,
          cloud: { branch: "feat/thing", id: "j1", status: "working", agent: "codex" },
        },
      },
      agentsByPath: new Map([
        ["/repo/wt", [{ agentId: "claude", label: "Claude", attention: true }]],
      ]),
      activePath: "/other",
    });
    expect(copies[0].status).toBe("attn");
  });
});

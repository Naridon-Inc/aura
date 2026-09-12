// What the sidebar shows for a project with many parallel copies.
//
// The bug these pin: "New Git" has 58 worktrees on disk and the rail showed
// one row, because the only copies it surfaced were the active one, the home
// checkout, and whatever had a live agent — a copy made minutes ago from the
// CLI matched none of those and fell into a collapsed disclosure.

import { describe, expect, it } from "bun:test";
import {
  FRESH_CAP,
  splitCopies,
  touchedAt,
  type CopySplitInput,
} from "../src/lib/rosterCopies";
import type { WorktreeRef } from "../src/lib/workspaceRef";

const NOW = 1_788_000_000_000; // fixed epoch ms
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function wt(path: string, over: Partial<WorktreeRef> = {}): WorktreeRef {
  return {
    path,
    branch: "feat/x",
    head: "abc",
    is_main: false,
    locked: false,
    ...over,
  };
}

function split(rows: WorktreeRef[], over: Partial<CopySplitInput> = {}) {
  return splitCopies({
    rows,
    activePath: "/repo",
    now: NOW,
    agentCount: () => 0,
    ...over,
  });
}

const secs = (ms: number) => Math.floor(ms / 1000);

describe("splitCopies — the copies that stay on screen", () => {
  it("keeps the home checkout and the active copy surfaced", () => {
    const { primary, inactive } = split([
      wt("/repo", { is_main: true, branch: "feat/cloud-parity" }),
      wt("/copies/old"),
    ]);
    expect(primary.map((w) => w.path)).toEqual(["/repo"]);
    expect(inactive.map((w) => w.path)).toEqual(["/copies/old"]);
  });

  it("surfaces a copy made minutes ago, with no agent and no visit", () => {
    const fresh = wt("/copies/just-made", { created_at: secs(NOW - 10 * 60_000) });
    const { primary, inactive } = split([wt("/repo", { is_main: true }), fresh]);
    expect(primary.map((w) => w.path)).toContain("/copies/just-made");
    expect(inactive).toHaveLength(0);
  });

  it("surfaces a copy cut today off a branch nobody has touched", () => {
    // The real shape of the bug: birth is an hour old, HEAD is a week old
    // because the copy inherited the old tip. Ranking by commit alone hides it.
    const cut = wt("/copies/stale-tip", {
      created_at: secs(NOW - HOUR),
      head_committed_at: secs(NOW - 7 * DAY),
    });
    expect(touchedAt(cut)).toBe(NOW - HOUR);
    expect(split([wt("/repo", { is_main: true }), cut]).primary).toHaveLength(2);
  });

  it("surfaces a week-old copy that was just committed to", () => {
    const worked = wt("/copies/in-use", {
      created_at: secs(NOW - 7 * DAY),
      head_committed_at: secs(NOW - 5 * 60_000),
    });
    expect(split([worked]).primary.map((w) => w.path)).toEqual(["/copies/in-use"]);
  });

  it("folds a copy away once it is a day cold", () => {
    const cold = wt("/copies/cold", { created_at: secs(NOW - DAY - HOUR) });
    const { primary, inactive } = split([wt("/repo", { is_main: true }), cold]);
    expect(primary.map((w) => w.path)).toEqual(["/repo"]);
    expect(inactive.map((w) => w.path)).toEqual(["/copies/cold"]);
  });

  it("caps a batch of fresh copies so ten don't become the rail", () => {
    const batch = Array.from({ length: 10 }, (_, i) =>
      wt(`/copies/crew-${i}`, { created_at: secs(NOW - (i + 1) * 60_000) }),
    );
    const { primary, inactive } = split([wt("/repo", { is_main: true }), ...batch]);
    expect(primary).toHaveLength(1 + FRESH_CAP);
    expect(inactive).toHaveLength(10 - FRESH_CAP);
    // Newest first: crew-0 is a minute old, crew-9 is ten.
    expect(primary.map((w) => w.path)).toContain("/copies/crew-0");
    expect(inactive.map((w) => w.path)).toContain("/copies/crew-9");
  });

  it("never drops a copy from both lists", () => {
    const rows = [
      wt("/repo", { is_main: true }),
      wt("/copies/agent", { branch: "worktree-agent-a1" }),
      wt("/copies/idle"),
      wt("/copies/fresh", { created_at: secs(NOW - 60_000) }),
      wt("/repo-work-thing", { branch: "work/thing" }),
    ];
    const { primary, workSessions, inactive } = split(rows);
    const seen = [...primary, ...workSessions, ...inactive].map((w) => w.path);
    expect(seen.sort()).toEqual(rows.map((w) => w.path).sort());
  });
});

describe("splitCopies — the rules that were already there", () => {
  it("surfaces a copy with a live agent", () => {
    const { primary } = split([wt("/repo", { is_main: true }), wt("/copies/busy")], {
      agentCount: (p) => (p === "/copies/busy" ? 1 : 0),
    });
    expect(primary.map((w) => w.path)).toContain("/copies/busy");
  });

  it("surfaces a copy opened within the hour, and folds one opened before that", () => {
    const rows = [wt("/copies/seen"), wt("/copies/forgotten")];
    const { primary, inactive } = split(rows, {
      visited: {
        "/copies/seen": NOW - 10 * 60_000,
        "/copies/forgotten": NOW - 2 * HOUR,
      },
    });
    expect(primary.map((w) => w.path)).toEqual(["/copies/seen"]);
    expect(inactive.map((w) => w.path)).toEqual(["/copies/forgotten"]);
  });

  it("keeps `aura work` sessions out of the disclosure count", () => {
    const { workSessions, inactive } = split([
      wt("/repo-work-login", { branch: "work/login" }),
      wt("/copies/idle"),
    ]);
    expect(workSessions.map((w) => w.path)).toEqual(["/repo-work-login"]);
    expect(inactive.map((w) => w.path)).toEqual(["/copies/idle"]);
  });

  it("counts work in flight on another machine as work", () => {
    const { inactive } = split([wt("/copies/remote"), wt("/copies/scratch", {
      branch: "worktree-agent-zz",
    })], {
      badgeByPath: {
        "/copies/remote": {
          added: 0,
          removed: 0,
          changedFiles: 0,
          cloud: { machine: "box-1" } as never,
        },
      },
    });
    // Has-work sorts above scratch inside the disclosure.
    expect(inactive.map((w) => w.path)).toEqual(["/copies/remote", "/copies/scratch"]);
  });

  it("leaves surfaced copies in git's own order", () => {
    const rows = [
      wt("/repo", { is_main: true }),
      wt("/copies/b", { created_at: secs(NOW - 3 * 60_000) }),
      wt("/copies/a", { created_at: secs(NOW - 60_000) }),
    ];
    expect(split(rows).primary.map((w) => w.path)).toEqual([
      "/repo",
      "/copies/b",
      "/copies/a",
    ]);
  });
});

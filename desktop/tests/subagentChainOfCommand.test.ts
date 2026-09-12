// The chain of command, pinned.
//
//   bun test tests/subagentChainOfCommand.test.ts
//
// The Workers lane exists to answer one question a flat list cannot: which of
// the nine things running did this, and who sent it. Every case below is a way
// that answer could quietly become wrong — a nested worker flattened, a run
// dropped because its parent's record never arrived, an empty read that reads
// as "there were none", a file count of null printed as zero.
//
// The tree is a pure function precisely so these can be stated as rules rather
// than clicked through in an app that needs a signed-in cloud to show anything.

import { describe, expect, test } from "bun:test";

import {
  chainOfCommand,
  countRuns,
  nestedCount,
  parseSubagentRuns,
  subagentRunsPath,
  type SubagentRun,
} from "../src/components/workpanes/subagentRuns";

function run(over: Partial<SubagentRun> & { agent_id: string }): SubagentRun {
  return {
    agent_type: "general-purpose",
    description: "Do the thing",
    spawn_depth: 1,
    is_fork: false,
    parent_agent_id: null,
    model: null,
    worktree_branch: null,
    last_write: null,
    last_message: null,
    files: null,
    ...over,
  };
}

const ids = (nodes: { run: SubagentRun }[]) => nodes.map((n) => n.run.agent_id);

describe("a worker that spawned workers reads as nested", () => {
  test("a three-deep chain keeps its shape", () => {
    // The case the feature is for: the session spawned one worker, that worker
    // spawned another, and that one spawned a third. Printed flat this is four
    // rows that all look like they answered to the session.
    const roots = chainOfCommand([
      run({ agent_id: "a", last_write: 10 }),
      run({ agent_id: "b", parent_agent_id: "a", spawn_depth: 2, last_write: 20 }),
      run({ agent_id: "c", parent_agent_id: "b", spawn_depth: 3, last_write: 30 }),
      run({ agent_id: "d", last_write: 40 }),
    ]);

    expect(ids(roots)).toEqual(["a", "d"]);
    expect(ids(roots[0].children)).toEqual(["b"]);
    expect(ids(roots[0].children[0].children)).toEqual(["c"]);
    expect(roots[1].children).toHaveLength(0);
  });

  test("every run is in the tree exactly once", () => {
    const runs = [
      run({ agent_id: "a" }),
      run({ agent_id: "b", parent_agent_id: "a" }),
      run({ agent_id: "c", parent_agent_id: "a" }),
      run({ agent_id: "d", parent_agent_id: "c" }),
    ];
    const roots = chainOfCommand(runs);
    expect(countRuns(roots)).toBe(runs.length);
    expect(nestedCount(roots)).toBe(3);
  });

  test("siblings run oldest write first, the order the CLI lists them in", () => {
    const roots = chainOfCommand([
      run({ agent_id: "late", parent_agent_id: "p", last_write: 300 }),
      run({ agent_id: "early", parent_agent_id: "p", last_write: 100 }),
      run({ agent_id: "unwritten", parent_agent_id: "p", last_write: null }),
      run({ agent_id: "p", last_write: 50 }),
    ]);
    expect(ids(roots[0].children)).toEqual(["unwritten", "early", "late"]);
  });

  test("two rows for one worker are one worker", () => {
    // A retried push is not a second run, and counting it twice would inflate
    // the header line above the number of rows on screen.
    const roots = chainOfCommand([
      run({ agent_id: "a", description: "first" }),
      run({ agent_id: "a", description: "second" }),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].run.description).toBe("first");
    expect(countRuns(roots)).toBe(1);
  });
});

describe("a run whose parent is missing is still a run", () => {
  test("it sits at the root rather than disappearing", () => {
    // A session read mid-fan-out, or a parent whose stop hook never landed.
    // Dropping the row would lose work that really happened; indenting it
    // under nothing would draw a level nobody can account for.
    const roots = chainOfCommand([
      run({ agent_id: "orphan", parent_agent_id: "gone", spawn_depth: 2 }),
    ]);
    expect(ids(roots)).toEqual(["orphan"]);
    expect(roots[0].orphaned).toBe(true);
  });

  test("a run the session spawned is not called an orphan", () => {
    const roots = chainOfCommand([run({ agent_id: "a" })]);
    expect(roots[0].orphaned).toBe(false);
  });

  test("a run that is its own ancestor does not hang the walk", () => {
    // Impossible from Claude and cheap to survive: ids come off a wire, and a
    // render that never returns is worse than a tree drawn one level flat.
    const roots = chainOfCommand([
      run({ agent_id: "a", parent_agent_id: "b" }),
      run({ agent_id: "b", parent_agent_id: "a" }),
      run({ agent_id: "self", parent_agent_id: "self" }),
    ]);
    expect(ids(roots).sort()).toEqual(["a", "b", "self"]);
    expect(countRuns(roots)).toBe(3);
  });
});

describe("nothing to show is not the same as nothing happened", () => {
  test("no runs is an empty tree, not a thrown read", () => {
    const roots = chainOfCommand([]);
    expect(roots).toEqual([]);
    expect(countRuns(roots)).toBe(0);
    expect(nestedCount(roots)).toBe(0);
  });

  test("a body with no runs in it parses to no runs", () => {
    // Every one of these is a real shape a server can answer with, and none of
    // them may throw: the caller turns a throw into "we don't know", and an
    // answered-but-empty session is a different fact from an unanswered one.
    expect(parseSubagentRuns(null)).toEqual([]);
    expect(parseSubagentRuns({})).toEqual([]);
    expect(parseSubagentRuns([])).toEqual([]);
    expect(parseSubagentRuns({ runs: [] })).toEqual([]);
    expect(parseSubagentRuns("nope")).toEqual([]);
  });
});

describe("the wire is read without inventing anything", () => {
  test("a bare list and a wrapped one read the same", () => {
    const row = { agent_id: "a", agent_type: "Explore", description: "Verify telemetry" };
    for (const body of [[row], { runs: [row] }, { subagent_runs: [row] }, { subagents: [row] }]) {
      const [parsed] = parseSubagentRuns(body);
      expect(parsed.agent_id).toBe("a");
      expect(parsed.agent_type).toBe("Explore");
      expect(parsed.description).toBe("Verify telemetry");
    }
  });

  test("a run nobody counted files for prints no number", () => {
    // The honesty rule, at the one place it could be broken: `?? 0` here would
    // put "0 files" on a worker that may have rewritten the module.
    const [parsed] = parseSubagentRuns([{ agent_id: "a" }]);
    expect(parsed.files).toBeNull();
    const [counted] = parseSubagentRuns([{ agent_id: "a", files: 0 }]);
    expect(counted.files).toBe(0);
  });

  test("a row with no id is dropped, and the rest survive it", () => {
    // The id is the identity and the join key; a row without one cannot be
    // rendered or attributed. It must not take its neighbours down with it.
    const parsed = parseSubagentRuns([{ agent_type: "Explore" }, { agent_id: "a" }]);
    expect(parsed.map((r) => r.agent_id)).toEqual(["a"]);
  });

  test("the CLI's own fallbacks are the reader's fallbacks", () => {
    // `subagents.rs` reads a sidecar-less worker as type `subagent`, empty
    // description, depth 1. The two readers must agree or one session reads
    // two ways.
    const [parsed] = parseSubagentRuns([{ agent_id: "a" }]);
    expect(parsed.agent_type).toBe("subagent");
    expect(parsed.description).toBe("");
    expect(parsed.spawn_depth).toBe(1);
    expect(parsed.is_fork).toBe(false);
    expect(parsed.parent_agent_id).toBeNull();
  });

  test("a blank string is an absent value, not a value", () => {
    const [parsed] = parseSubagentRuns([
      { agent_id: "a", worktree_branch: "   ", model: "", last_message: " " },
    ]);
    expect(parsed.worktree_branch).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.last_message).toBeNull();
  });
});

describe("the route is written once", () => {
  test("the session id is escaped into the query", () => {
    expect(subagentRunsPath("a/b c")).toBe("/sessions/a%2Fb%20c/subagents");
  });
});

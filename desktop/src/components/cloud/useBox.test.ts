// Reading a box's session list the way a person reads it.
//
// The list itself comes off the machine and is tested against a real one; what
// is tested here is the layer between that list and the screen — which project
// a session belongs under, what to call it, and how long ago it did anything.
// All three have a wrong answer that looks plausible: a session filed under the
// wrong repo, a tab labelled `aura-agent-naridon-3f1c`, and "just now" on a
// session that has been idle since Tuesday.

import { describe, expect, test } from "bun:test";

import type { BoxSession } from "../../lib/api";
import { basename, groupByProject, sessionLabel, sinceWords } from "./useBox";

function session(over: Partial<BoxSession> = {}): BoxSession {
  return {
    name: "aura-shell-aura-src-01",
    project: "/home/ubuntu/aura-src",
    kind: "shell",
    agent: null,
    branch: null,
    title: "",
    created_at: 1_770_000_000,
    activity_at: 1_770_000_000,
    attached: 0,
    ...over,
  };
}

describe("which project a session is working in", () => {
  test("one box holding three repos reads as three headings", () => {
    const groups = groupByProject([
      session({ name: "a", project: "/home/ubuntu/naridon" }),
      session({ name: "b", project: "/home/ubuntu/aura-src" }),
      session({ name: "c", project: "/home/ubuntu/naridon" }),
    ]);
    expect(groups.map(([k]) => k)).toEqual(["aura-src", "naridon"]);
    expect(groups[1]![1].map((s) => s.name).sort()).toEqual(["a", "c"]);
  });

  test("a worktree is filed under its own directory, not swallowed by the repo", () => {
    // Its own branch means its own directory over there, and the whole point of
    // that is that the two are separately joinable. Folding them together would
    // put two agents' work under one heading and lose which is which.
    const groups = groupByProject([
      session({ name: "main", project: "/home/ubuntu/naridon" }),
      session({
        name: "wt",
        project: "/home/ubuntu/naridon-wt-fix-login",
        branch: "fix-login",
      }),
    ]);
    expect(groups.map(([k]) => k)).toEqual(["naridon", "naridon-wt-fix-login"]);
  });

  test("the newest activity leads its project", () => {
    const [, rows] = groupByProject([
      session({ name: "stale", activity_at: 1_770_000_000 }),
      session({ name: "busy", activity_at: 1_770_009_999 }),
    ])[0]!;
    expect(rows.map((s) => s.name)).toEqual(["busy", "stale"]);
  });

  test("a session from before any of this is listed, not hidden", () => {
    // Someone's own `tmux new` on the box carries no project. Dropping it would
    // make the list disagree with the machine, which is the one thing this
    // surface must never do.
    const groups = groupByProject([session({ name: "theirs", project: "" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]![0]).toBe("elsewhere on the box");
  });

  test("nothing running is no headings, not an invented one", () => {
    expect(groupByProject([])).toEqual([]);
  });
});

describe("what to call a session", () => {
  test("its own title wins", () => {
    expect(sessionLabel(session({ title: "Fix the login redirect" }))).toBe(
      "Fix the login redirect",
    );
  });

  test("no title falls back to the directory it works in", () => {
    expect(sessionLabel(session({ title: "  " }))).toBe("aura-src");
  });

  test("the machine's own session name is the last resort, not the first", () => {
    const s = session({ title: "", project: "", name: "aura-agent-box-3f1c" });
    expect(sessionLabel(s)).toBe("aura-agent-box-3f1c");
  });

  test("a trailing slash doesn't produce an empty label", () => {
    expect(basename("/home/ubuntu/naridon/")).toBe("naridon");
  });
});

describe("how long ago it did anything", () => {
  // Fixed now, so the words are the assertion rather than the clock.
  const NOW = 1_770_000_000_000;
  const ago = (seconds: number) => sinceWords(NOW / 1000 - seconds, NOW);

  test("a session that just spoke reads as just now", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44)).toBe("just now");
  });

  test("minutes, hours and days each get their own word", () => {
    expect(ago(60 * 3)).toBe("3m ago");
    expect(ago(60 * 90)).toBe("2h ago");
    expect(ago(60 * 60 * 50)).toBe("2d ago");
  });

  test("a clock that disagrees with the box never reads as the future", () => {
    // The box's clock is not this laptop's. A few seconds of skew must round to
    // "just now", not to a negative number rendered as "-1m ago".
    expect(sinceWords(NOW / 1000 + 30, NOW)).toBe("just now");
  });

  test("a session with no recorded activity says nothing rather than 1970", () => {
    expect(sinceWords(0, NOW)).toBe("");
  });
});

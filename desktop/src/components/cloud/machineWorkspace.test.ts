// Which box, and which session.
//
// Every decision here fails plausibly. There is no exception and no red screen:
// you get the wrong machine's liveness, or a shell you didn't ask for on
// somebody's hardware, or two clients on one tmux pane typing over each other.
// The user's report is "the cloud stuff is a bit flaky", which is unactionable,
// which is why these are assertions rather than comments.

import { describe, expect, test } from "bun:test";

import type { BoxSession, CloudRunner, Machine } from "../../lib/api";
import { tabIdFor } from "../../lib/remoteWorkspaceSnapshot";
import {
  instanceIdFor,
  machineToOpen,
  missingMachine,
  runnerFor,
  sessionToGreet,
} from "./machineWorkspace";

const box = (over: Partial<Machine> = {}): Machine => ({
  id: "ubuntu@10.0.0.1:/srv/aura",
  name: "aura-runner",
  host: "10.0.0.1",
  user: "ubuntu",
  key_path: "/keys/aura.pem",
  box_kind: "mine",
  repo_path: "/srv/aura",
  project_root: "/Users/mo/aura",
  repo_branch: null,
  added_at: 1,
  last_used_at: 2,
  ...over,
});

const session = (name: string, activity_at: number): BoxSession =>
  ({ name, activity_at }) as BoxSession;

const onBoard = (name: string, online = true): CloudRunner =>
  ({ name, online }) as CloudRunner;

describe("which machine a workspace stands in", () => {
  test("a machine already asked for is kept when the book arrives", () => {
    // The book is read asynchronously. Letting it win would walk someone out of
    // the machine they clicked and into whichever one they used last.
    expect(machineToOpen("ubuntu@10.0.0.2:/srv/aura", [box()])).toBe(
      "ubuntu@10.0.0.2:/srv/aura",
    );
  });

  test("with nothing asked for, the most recently used one", () => {
    // The book arrives in that order, and it is what "my machine" means to
    // someone who has two.
    const first = box({ id: "recent" });
    expect(machineToOpen(null, [first, box({ id: "older" })])).toBe("recent");
  });

  test("an empty book leaves you standing nowhere, not on a guess", () => {
    expect(machineToOpen(null, [])).toBe(null);
  });
});

describe("a workspace that outlived its machine", () => {
  test("the machine it asked for is named, not silently swapped", () => {
    // The dangerous alternative: open a different box instead. The shells come
    // up fine, somewhere else, and look completely right.
    expect(missingMachine([box({ id: "a" })], "b")).toBe("b");
  });

  test("nothing is missing while the book is still being read", () => {
    // "We haven't looked yet" and "we looked and it's gone" are different
    // sentences, and saying the second one early flashes an error at someone
    // whose machine is perfectly fine.
    expect(missingMachine(null, "b")).toBe(null);
  });

  test("a machine the book does hold is not missing", () => {
    expect(missingMachine([box({ id: "a" })], "a")).toBe(null);
  });

  test("standing on no machine at all is not a missing one", () => {
    expect(missingMachine([], null)).toBe(null);
  });
});

describe("matching a box to its row on the board", () => {
  test("by name, past the capitalisation nobody agrees on", () => {
    // The name is typed twice — into the wizard here, and into
    // `aura runner install` on the box — and the two rarely match exactly.
    const found = runnerFor(box({ name: " Aura-Runner " }), [
      onBoard("ci-box"),
      onBoard("aura-runner"),
    ]);
    expect(found?.name).toBe("aura-runner");
  });

  test("a single runner under any label is still this box", () => {
    expect(runnerFor(box({ name: "home-server" }), [onBoard("box-1")])?.name).toBe("box-1");
  });

  test("among several it never guesses", () => {
    // This is the assertion that matters. A wrong match shows one machine's
    // liveness on another: the box reads online, you open a shell, and it hangs
    // instead of saying the box is stopped.
    expect(
      runnerFor(box({ name: "home-server" }), [onBoard("box-1"), onBoard("box-2")]),
    ).toBe(null);
  });

  test("a board that hasn't answered is not an offline box", () => {
    expect(runnerFor(box(), null)).toBe(null);
    expect(runnerFor(null, [onBoard("aura-runner")])).toBe(null);
  });
});

describe("what you land in front of when you walk into a machine", () => {
  test("the session you were most recently working in", () => {
    const last = sessionToGreet([
      session("build", 100),
      session("agent-3f1", 900),
      session("logs", 500),
    ]);
    expect(last?.name).toBe("agent-3f1");
  });

  test("an idle box lands you on Chat rather than a shell nobody asked for", () => {
    // Opening a terminal on someone's machine so there is something to show is
    // a side effect, on their hardware, that they did not request.
    expect(sessionToGreet([])).toBe(null);
    expect(sessionToGreet(null)).toBe(null);
  });

  test("the box's own list is not reordered by being read", () => {
    // It is state the box owns and the session picker draws. Sorting in place
    // would shuffle that list under the user's cursor.
    const sessions = [session("build", 100), session("agent", 900)];
    sessionToGreet(sessions);
    expect(sessions.map((s) => s.name)).toEqual(["build", "agent"]);
  });
});

describe("the terminal a tab is bound to", () => {
  test("the machine is in the key, because two boxes both have a `main`", () => {
    // Without it, walking into the second box would attach its tab to the first
    // box's terminal — a live shell on the wrong hardware, looking correct.
    expect(instanceIdFor({ id: "ubuntu@10.0.0.1:/srv/aura" }, "main")).toBe(
      "remote:ubuntu@10.0.0.1:/srv/aura:main",
    );
    expect(instanceIdFor({ id: "ubuntu@10.0.0.2:/srv/aura" }, "main")).not.toBe(
      instanceIdFor({ id: "ubuntu@10.0.0.1:/srv/aura" }, "main"),
    );
  });

  test("driving and watching one session are two terminals", () => {
    const m = { id: "box" };
    expect(instanceIdFor(m, tabIdFor("agent", true))).not.toBe(
      instanceIdFor(m, tabIdFor("agent", false)),
    );
  });
});

// What these pin: a stage you set by dragging a card holds only until the
// pull request says something new, and storage that comes back mangled is
// read as no pins rather than as a crash.

import { describe, expect, test } from "bun:test";

import { effectiveStage, parsePins, withPin } from "./workspaceStage";

describe("a workspace's stage", () => {
  test("follows git when nothing is pinned", () => {
    expect(effectiveStage(undefined, "in-review")).toBe("in-review");
  });

  test("holds the pin while git says what it said when the card moved", () => {
    expect(effectiveStage({ stage: "backlog", derived: "in-progress" }, "in-progress")).toBe(
      "backlog",
    );
  });

  test("lets go of the pin once the pull request moves on", () => {
    const pin = { stage: "backlog" as const, derived: "in-progress" as const };
    expect(effectiveStage(pin, "in-review")).toBe("in-review");
    expect(effectiveStage(pin, "done")).toBe("done");
  });

  test("moving a card back to git's stage drops its pin", () => {
    const pinned = withPin({}, "/r/a", "backlog", "in-progress");
    expect(pinned).toEqual({ "/r/a": { stage: "backlog", derived: "in-progress" } });
    expect(withPin(pinned, "/r/a", "in-progress", "in-progress")).toEqual({});
  });

  test("a pin on one copy leaves the others alone", () => {
    const pins = withPin(withPin({}, "/r/a", "backlog", "in-progress"), "/r/b", "done", "in-review");
    expect(Object.keys(pins).sort()).toEqual(["/r/a", "/r/b"]);
    expect(withPin(pins, "/r/a", "in-progress", "in-progress")).toEqual({
      "/r/b": { stage: "done", derived: "in-review" },
    });
  });

  test("storage that does not parse, or names no stage, reads as no pins", () => {
    expect(parsePins(null)).toEqual({});
    expect(parsePins("{not json")).toEqual({});
    expect(parsePins("[]")).toEqual({});
    expect(
      parsePins(
        JSON.stringify({
          "/r/a": { stage: "backlog", derived: "in-progress" },
          "/r/b": { stage: "shipped", derived: "in-progress" },
          "/r/c": null,
        }),
      ),
    ).toEqual({ "/r/a": { stage: "backlog", derived: "in-progress" } });
  });
});

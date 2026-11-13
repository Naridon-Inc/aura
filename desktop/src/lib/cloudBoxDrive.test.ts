import { describe, expect, test } from "bun:test";

import type { PlaceRoster, PlaceRow } from "./api";
import {
  BOX_ROOT,
  boxComputersOf,
  boxLinkFor,
  composerOpen,
  isBoxAnswer,
  isBoxDriven,
  isFailedAnswer,
  waitingPrompt,
} from "./cloudBoxDrive";
import type { CloudMessageRow } from "./cloudWorkspacesApi";

const LINKED = "2026-11-11T10:00:00Z";
const box = { machine: "aura-runner", driver: "box", linked_at: LINKED };
const laptop = { machine: "aura-runner", driver: null };

function said(id: string, role: string, at: string, over: Partial<CloudMessageRow> = {}): CloudMessageRow {
  return { id, role, body: id, source: "public-api", created_at: at, ...over };
}

function place(over: Partial<PlaceRow>): PlaceRow {
  return { id: "m-1", name: "aura-runner", machine: null, runner_id: "p-1", online: true, ...over } as PlaceRow;
}

function roster(places: PlaceRow[]): PlaceRoster {
  return { places } as PlaceRoster;
}

describe("a computer that answers by itself", () => {
  test("is the place's driver, and only `box` names it", () => {
    expect(isBoxDriven({ place: box })).toBe(true);
    expect(isBoxDriven({ place: laptop })).toBe(false);
    expect(isBoxDriven({ place: { driver: "laptop" } })).toBe(false);
    expect(isBoxDriven({ place: null })).toBe(false);
    expect(isBoxDriven({})).toBe(false);
  });

  test("takes every member's prompt; a laptop's chat takes none in this box", () => {
    expect(composerOpen({ place: box }, { readOnly: false, archived: false })).toBe(true);
    expect(composerOpen({ place: null }, { readOnly: false, archived: false })).toBe(true);
    expect(composerOpen({ place: laptop }, { readOnly: false, archived: false })).toBe(false);
  });

  test("still takes nothing from a reader, or once archived", () => {
    expect(composerOpen({ place: box }, { readOnly: true, archived: false })).toBe(false);
    expect(composerOpen({ place: box }, { readOnly: false, archived: true })).toBe(false);
  });

  test("takes nothing once the work moved to a member's computer", () => {
    const moved = { to: "local", name: "Sam’s computer", branch: "fix/login", by: "u-1", at: null };
    expect(composerOpen({ place: null, moved }, { readOnly: false, archived: false })).toBe(false);
    expect(composerOpen({ place: null, moved: null }, { readOnly: false, archived: false })).toBe(true);
  });
});

describe("the computers a workspace can be handed to", () => {
  test("any runner on the board, with no machine entry on this laptop", () => {
    expect(boxComputersOf(roster([place({})]))).toEqual([{ placeId: "p-1", name: "aura-runner" }]);
  });

  test("not one known to be down, not a machine with no runner, and each once", () => {
    const list = roster([
      place({ online: false, runner_id: "p-down" }),
      place({ runner_id: null, name: "laptop-only" }),
      place({ online: null }),
      place({ id: "m-2" }),
    ]);
    expect(boxComputersOf(list)).toEqual([{ placeId: "p-1", name: "aura-runner" }]);
    expect(boxComputersOf(null)).toEqual([]);
  });

  test("is handed the workspace to answer by itself, under its own projects folder", () => {
    expect(boxLinkFor({ placeId: "p-1", name: "aura-runner" })).toEqual({
      machine: "aura-runner",
      remoteRoot: BOX_ROOT,
      branch: null,
      engine: "claude",
      placeId: "p-1",
      driver: "box",
    });
  });

  test("works on the workspace's own branch when it has one", () => {
    expect(boxLinkFor({ placeId: "p-1", name: "aura-runner" }, " feat/x ").branch).toBe("feat/x");
    expect(boxLinkFor({ placeId: "p-1", name: "aura-runner" }, "  ").branch).toBeNull();
    expect(boxLinkFor({ placeId: "p-1", name: "aura-runner" }, "fix/x", "codex").engine).toBe("codex");
  });
});

describe("what the computer is still working on", () => {
  const p1 = said("p1", "user", "2026-11-11T10:01:00Z");
  const a1 = said("a1", "assistant", "2026-11-11T10:02:00Z", { source: "box", answers: "p1" });
  const p2 = said("p2", "user", "2026-11-11T10:03:00Z");

  test("the newest prompt, until an answer names it", () => {
    expect(waitingPrompt([p1], LINKED)?.id).toBe("p1");
    expect(waitingPrompt([p1, a1], LINKED)).toBeNull();
    expect(waitingPrompt([p1, a1, p2], LINKED)?.id).toBe("p2");
  });

  test("an answer to an older prompt doesn't answer the newest", () => {
    const late = said("a0", "assistant", "2026-11-11T10:04:00Z", { source: "box", answers: "p1" });
    expect(waitingPrompt([p1, p2, late], LINKED)?.id).toBe("p2");
  });

  test("a message to teammates is not a prompt it is working on", () => {
    const toMaya = said("m1", "user", "2026-11-11T10:04:00Z");
    const toPeople = (r: { id: string }) => r.id === "m1";
    expect(waitingPrompt([p1, a1, toMaya], LINKED, toPeople)).toBeNull();
    expect(waitingPrompt([p1, toMaya], LINKED, toPeople)?.id).toBe("p1");
    expect(waitingPrompt([toMaya], LINKED, toPeople)).toBeNull();
  });

  test("a failed answer still ends the wait", () => {
    const failed = said("f2", "assistant", "2026-11-11T10:04:00Z", { source: "box", answers: "p2", failed: true });
    expect(waitingPrompt([p1, a1, p2, failed], LINKED)).toBeNull();
  });

  test("an answer that names no prompt counts for the prompts before it", () => {
    const bare = said("b1", "assistant", "2026-11-11T10:04:00Z", { source: "box" });
    expect(waitingPrompt([p2, bare], LINKED)).toBeNull();
    expect(waitingPrompt([bare, p2], LINKED)?.id).toBe("p2");
  });

  test("nothing from before the computer was given the workspace", () => {
    const old = said("p0", "user", "2026-11-11T09:00:00Z");
    expect(waitingPrompt([old], LINKED)).toBeNull();
    expect(waitingPrompt([p1], null)).toBeNull();
    expect(waitingPrompt([], LINKED)).toBeNull();
    expect(waitingPrompt(null, LINKED)).toBeNull();
  });

  test("a person's reply is not the computer's answer", () => {
    const person = said("r1", "assistant", "2026-11-11T10:04:00Z", { source: "public-api" });
    expect(waitingPrompt([p2, person], LINKED)?.id).toBe("p2");
  });
});

describe("an answer that says the prompt was not run", () => {
  test("is the computer's, and flagged failed", () => {
    expect(isFailedAnswer(said("f", "assistant", LINKED, { source: "box", failed: true }))).toBe(true);
    expect(isFailedAnswer(said("a", "assistant", LINKED, { source: "box" }))).toBe(false);
    expect(isFailedAnswer(said("u", "user", LINKED, { failed: true }))).toBe(false);
    expect(isBoxAnswer(said("a", "assistant", LINKED, { answers: "p1" }))).toBe(true);
  });
});

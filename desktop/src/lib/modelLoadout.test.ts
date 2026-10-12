// The loadout's order is the part a person can feel: a chord is bound to a
// position, so any rule that quietly renumbers positions moves somebody's keys
// under their fingers. These pin the ones that must not.

import { describe, expect, test } from "bun:test";

import type { BrainChoice } from "./api";
import type { CatalogModel } from "./modelCatalog";
import {
  LOADOUT_CHORD_SLOTS,
  loadoutChordLabel,
  loadoutSlotKey,
  moveLoadoutEntry,
  resolveLoadout,
  toggleLoadoutEntry,
  type LoadoutRow,
} from "./modelLoadout";

const brain = (id: string): BrainChoice => ({
  id,
  label: id,
  kind: "cli_wrapper",
  active: true,
  requires_api_key: false,
  has_api_key: true,
});

const model = (key: string): CatalogModel => ({ key, id: key, label: key });

const row = (brainId: string, modelKey: string): LoadoutRow => ({
  brain: brain(brainId),
  model: model(modelKey),
});

describe("adding and removing", () => {
  test("a new entry lands at the end, leaving the chords where they were", () => {
    // The whole point of the chord is that it does not move. Inserting at the
    // front would make ⌘1 mean something different the moment you add a sixth
    // model you will never press.
    expect(toggleLoadoutEntry(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  test("adding one already in the loadout removes it", () => {
    expect(toggleLoadoutEntry(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("reordering", () => {
  test("a dragged entry lands where it was dropped", () => {
    expect(moveLoadoutEntry(["a", "b", "c", "d"], 3, 1)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  test("dragging down accounts for the gap the entry left", () => {
    expect(moveLoadoutEntry(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  test("a drag that ends where it started changes nothing", () => {
    const order = ["a", "b"];
    expect(moveLoadoutEntry(order, 1, 1)).toBe(order);
  });

  test("a drop outside the list is a no-op, not a reshuffle", () => {
    const order = ["a", "b"];
    expect(moveLoadoutEntry(order, 0, 5)).toBe(order);
    expect(moveLoadoutEntry(order, -1, 0)).toBe(order);
  });
});

describe("the chords", () => {
  test("the first slots get one and the rest do not", () => {
    expect(loadoutChordLabel(0)).toBe("⌘1");
    expect(loadoutChordLabel(LOADOUT_CHORD_SLOTS - 1)).toBe(
      `⌘${LOADOUT_CHORD_SLOTS}`,
    );
    expect(loadoutChordLabel(LOADOUT_CHORD_SLOTS)).toBeNull();
  });

  test("a slot past the end of the loadout resolves to nothing", () => {
    // Pressing ⌘4 with three models loaded must do nothing. Wrapping onto the
    // first would switch model when the user expected no such thing.
    expect(loadoutSlotKey(["a", "b", "c"], 4)).toBeNull();
    expect(loadoutSlotKey(["a", "b", "c"], 2)).toBe("b");
  });

  test("a slot outside the chord range resolves to nothing", () => {
    const order = ["a", "b", "c", "d", "e", "f"];
    expect(loadoutSlotKey(order, LOADOUT_CHORD_SLOTS + 1)).toBeNull();
    expect(loadoutSlotKey(order, 0)).toBeNull();
  });
});

describe("resolving against what is installed", () => {
  test("rows come back in loadout order, not catalog order", () => {
    const rows = [row("claude", "opus"), row("gemini", "pro")];
    const resolved = resolveLoadout(["gemini::pro", "claude::opus"], rows);
    expect(resolved.map((r) => r.model.key)).toEqual(["pro", "opus"]);
  });

  test("an entry whose agent is gone is skipped, not dropped", () => {
    // The stored list is the user's intent. Uninstalling Gemini hides its row;
    // installing it again must put the row back in the slot it always had.
    const order = ["claude::opus", "gemini::pro", "claude::sonnet"];
    const withoutGemini = resolveLoadout(order, [
      row("claude", "opus"),
      row("claude", "sonnet"),
    ]);
    expect(withoutGemini.map((r) => r.model.key)).toEqual(["opus", "sonnet"]);

    const backAgain = resolveLoadout(order, [
      row("claude", "opus"),
      row("claude", "sonnet"),
      row("gemini", "pro"),
    ]);
    expect(backAgain.map((r) => r.model.key)).toEqual([
      "opus",
      "pro",
      "sonnet",
    ]);
  });

  test("an empty loadout resolves to nothing at all", () => {
    expect(resolveLoadout([], [row("claude", "opus")])).toEqual([]);
  });

  test("a duplicated catalog row is listed once", () => {
    const rows = [row("claude", "opus"), row("claude", "opus")];
    expect(resolveLoadout(["claude::opus"], rows)).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  NEW_SECTION_NAME,
  insertIndexAt,
  nameForNewSection,
  parseSections,
  sectionDropIndex,
  sectionOfPath,
  sectionOfRepo,
  withRepoIn,
  withSection,
  withSectionEdited,
  withSectionMoved,
  withWorkspaceIn,
  withoutSection,
  type RosterSectionDef,
} from "./sectionModel";

const two: RosterSectionDef[] = [
  { id: "a", name: "Alpha", paths: ["/w/1", "/w/2"] },
  { id: "b", name: "Beta", emoji: "🚀", paths: [] },
];

describe("sections", () => {
  test("reads only well-formed sections", () => {
    expect(parseSections(null)).toEqual([]);
    expect(parseSections("not json")).toEqual([]);
    expect(parseSections('{"id":"a"}')).toEqual([]);
    expect(
      parseSections(JSON.stringify([...two, { id: 1, name: "x", paths: [] }, { id: "c", name: "C" }])),
    ).toEqual(two);
  });

  test("a section made with the name left empty is called New section", () => {
    expect(nameForNewSection("", [])).toBe(NEW_SECTION_NAME);
    expect(nameForNewSection("   ", two)).toBe("New section");
    expect(nameForNewSection("  Shipping ", two)).toBe("Shipping");
  });

  test("a second unnamed section is numbered past the ones already made", () => {
    const made = [
      ...two,
      { id: "n1", name: "New section", paths: [] },
      { id: "n2", name: "New section 2", paths: [] },
    ];
    expect(nameForNewSection("", made)).toBe("New section 3");
    expect(nameForNewSection("", made.filter((s) => s.id !== "n1"))).toBe("New section");
  });

  test("a new section goes before the one named, or last", () => {
    expect(withSection(two, { id: "c", name: "  Gamma " }).map((s) => s.id)).toEqual(["a", "b", "c"]);
    const before = withSection(two, { id: "c", name: "Gamma", emoji: "✨" }, "b");
    expect(before.map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(before[1]).toEqual({ id: "c", name: "Gamma", emoji: "✨", paths: [] });
    expect(withSection(two, { id: "c", name: "G" }, "gone").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("editing renames and can clear the emoji", () => {
    const edited = withSectionEdited(two, "b", { name: " Ship " });
    expect(edited[1]).toEqual({ id: "b", name: "Ship", paths: [] });
    expect(edited[0]).toBe(two[0]);
  });

  test("deleting a section leaves the others", () => {
    expect(withoutSection(two, "a")).toEqual([two[1]]);
  });

  test("a workspace is in one section at most", () => {
    const moved = withWorkspaceIn(two, "/w/1", "b");
    expect(moved[0].paths).toEqual(["/w/2"]);
    expect(moved[1].paths).toEqual(["/w/1"]);
    expect(sectionOfPath(moved, "/w/1")?.id).toBe("b");
    const out = withWorkspaceIn(moved, "/w/1", null);
    expect(sectionOfPath(out, "/w/1")).toBeUndefined();
  });

  test("a workspace lands at the index asked, clamped", () => {
    expect(withWorkspaceIn(two, "/w/3", "a", 0)[0].paths).toEqual(["/w/3", "/w/1", "/w/2"]);
    expect(withWorkspaceIn(two, "/w/3", "a", 99)[0].paths).toEqual(["/w/1", "/w/2", "/w/3"]);
    // Reordering within its own section counts the list without it.
    expect(withWorkspaceIn(two, "/w/1", "a", 1)[0].paths).toEqual(["/w/2", "/w/1"]);
  });

  test("sections reorder", () => {
    expect(withSectionMoved(two, "b", 0).map((s) => s.id)).toEqual(["b", "a"]);
    expect(withSectionMoved(two, "a", 5).map((s) => s.id)).toEqual(["b", "a"]);
    expect(withSectionMoved(two, "x", 0)).toEqual(two);
  });

  test("a drop height picks the gap between rows", () => {
    expect(insertIndexAt([10, 30, 50], 0)).toBe(0);
    expect(insertIndexAt([10, 30, 50], 20)).toBe(1);
    expect(insertIndexAt([10, 30, 50], 60)).toBe(3);
    expect(insertIndexAt([], 5)).toBe(0);
  });

  test("a section dropped on another goes before or after it", () => {
    const three = withSection(two, { id: "c", name: "C" });
    expect(sectionDropIndex(three, "c", "a", false)).toBe(0);
    expect(sectionDropIndex(three, "c", "a", true)).toBe(1);
    expect(sectionDropIndex(three, "a", "c", true)).toBe(2);
  });
});

describe("repositories filed in sections", () => {
  test("a section saved before repositories could be filed still reads", () => {
    const old = JSON.stringify([{ id: "a", name: "Alpha", paths: ["/w/1"] }]);
    expect(parseSections(old)).toEqual([{ id: "a", name: "Alpha", paths: ["/w/1"] }]);
  });

  test("a section's repositories are read only when they are a list of ids", () => {
    const raw = JSON.stringify([
      { id: "a", name: "A", paths: [], repos: ["/r/1"] },
      { id: "b", name: "B", paths: [], repos: "/r/2" },
      { id: "c", name: "C", paths: [], repos: [3] },
    ]);
    expect(parseSections(raw)).toEqual([{ id: "a", name: "A", paths: [], repos: ["/r/1"] }]);
  });

  test("filing a repository puts it at the spot, and in one section only", () => {
    const start: RosterSectionDef[] = [
      { id: "a", name: "A", paths: [], repos: ["/r/1", "/r/2"] },
      { id: "b", name: "B", paths: ["/w/1"] },
    ];
    const moved = withRepoIn(start, "/r/1", "b");
    expect(moved[0].repos).toEqual(["/r/2"]);
    expect(moved[1]).toEqual({ id: "b", name: "B", paths: ["/w/1"], repos: ["/r/1"] });
    expect(sectionOfRepo(moved, "/r/1")?.id).toBe("b");

    const first = withRepoIn(moved, "/r/3", "b", 0);
    expect(first[1].repos).toEqual(["/r/3", "/r/1"]);
    expect(withRepoIn(first, "/r/3", "b", 99)[1].repos).toEqual(["/r/1", "/r/3"]);
  });

  test("filing a repository leaves the section's workspaces and the other sections alone", () => {
    const start: RosterSectionDef[] = [
      { id: "a", name: "A", paths: ["/w/1"], repos: ["/r/1"] },
      { id: "b", name: "B", paths: [] },
    ];
    const out = withRepoIn(start, "/r/2", "a");
    expect(out[0].paths).toEqual(["/w/1"]);
    expect(out[1]).toBe(start[1]);
  });

  test("taking a repository out of every section", () => {
    const start: RosterSectionDef[] = [{ id: "a", name: "A", paths: [], repos: ["/r/1"] }];
    const out = withRepoIn(start, "/r/1", null);
    expect(out[0].repos).toEqual([]);
    expect(sectionOfRepo(out, "/r/1")).toBeUndefined();
  });

  test("editing a section keeps the repositories filed in it", () => {
    const start: RosterSectionDef[] = [{ id: "a", name: "A", paths: [], repos: ["/r/1"] }];
    expect(withSectionEdited(start, "a", { name: "Renamed" })[0].repos).toEqual(["/r/1"]);
  });
});

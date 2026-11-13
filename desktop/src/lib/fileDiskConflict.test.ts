import { describe, expect, test } from "bun:test";

import {
  afterDiskRead,
  afterEdit,
  discardMyEdits,
  hasDiskConflict,
  keepMyEdits,
} from "./fileDiskConflict";

const clean = { baseline: "a", current: "a" };
const edited = { baseline: "a", current: "a + mine" };

describe("a file read again from disk", () => {
  test("with no unsaved edits, simply shows the new copy", () => {
    const next = afterDiskRead(clean, "b");
    expect(next).toEqual({ baseline: "b", current: "b", diskChanged: false });
    expect(hasDiskConflict(next)).toBe(false);
  });

  test("under unsaved edits, keeps them and asks which copy wins", () => {
    const next = afterDiskRead(edited, "b");
    expect(next.current).toBe("a + mine");
    expect(next.baseline).toBe("b");
    expect(hasDiskConflict(next)).toBe(true);
  });

  test("that hasn't changed asks nothing", () => {
    expect(afterDiskRead(edited, "a")).toBe(edited);
  });

  test("that now matches the edits asks nothing and is saved", () => {
    const next = afterDiskRead(edited, "a + mine");
    expect(hasDiskConflict(next)).toBe(false);
    expect(next.current).toBe(next.baseline);
  });

  test("a second change while still unanswered keeps asking", () => {
    const once = afterDiskRead(edited, "b");
    expect(hasDiskConflict(afterDiskRead(once, "c"))).toBe(true);
  });
});

describe("answering", () => {
  const conflict = afterDiskRead(edited, "b");

  test("Keep mine leaves the edits unsaved and lets them be saved", () => {
    const next = keepMyEdits(conflict);
    expect(next.current).toBe("a + mine");
    expect(next.current).not.toBe(next.baseline);
    expect(hasDiskConflict(next)).toBe(false);
  });

  test("Discard my edits shows the copy on disk", () => {
    const next = discardMyEdits(conflict);
    expect(next.current).toBe("b");
    expect(hasDiskConflict(next)).toBe(false);
  });

  test("typing back to the copy on disk ends it", () => {
    expect(hasDiskConflict(afterEdit(conflict, "b"))).toBe(false);
    expect(afterEdit(afterEdit(conflict, "b"), "b!").diskChanged).toBe(false);
  });

  test("more typing does not end it", () => {
    expect(hasDiskConflict(afterEdit(conflict, "a + mine + more"))).toBe(true);
  });
});

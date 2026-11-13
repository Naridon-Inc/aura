import { describe, expect, test } from "bun:test";

import { resolveShortcut } from "../keymap";
import { SHORTCUT_GROUPS } from "../shortcuts";
import {
  COMMENT_NAV_OFFSET,
  commentNavChord,
  commentNavState,
  navTargets,
  type NavTarget,
} from "./commentNav";
import type { ReviewComment } from "./reviewComments";

function comment(id: string, lineNumber: number, side: ReviewComment["side"] = "additions", end?: number): ReviewComment {
  return {
    id,
    workspace: "/repo",
    filePath: "src/a.ts",
    lineNumber,
    endLineNumber: end,
    side,
    body: id,
    state: "ready_for_review",
    createdAt: 0,
  };
}

function at(id: string, top: number, height = 20): NavTarget {
  return { comment: comment(id, 1), top, height };
}

describe("comment navigation counts", () => {
  test("nothing to step to without comments", () => {
    expect(commentNavState([], 0, 500)).toEqual({ previousCount: 0, nextCount: 0 });
  });

  test("comments in view split the rest into before and after", () => {
    const s = commentNavState([at("d", 900), at("a", 100), at("c", 600), at("b", 300)], 250, 400);
    expect(s.previous?.id).toBe("a");
    expect(s.next?.id).toBe("d");
    expect(s.previousCount).toBe(1);
    expect(s.nextCount).toBe(1);
  });

  test("the top band under the floating button does not count as in view", () => {
    // Top at 250 + 56 = 306; "b" ends at 300, so it is above, not in view.
    const s = commentNavState([at("a", 100), at("b", 280), at("c", 1000)], 250, 400);
    expect(s.previousCount).toBe(2);
    expect(s.previous?.id).toBe("b");
    expect(s.next?.id).toBe("c");
    expect(s.nextCount).toBe(1);
  });

  test("with none in view, the split falls at the top of the view", () => {
    const s = commentNavState([at("a", 10), at("b", 2000)], 500, 300);
    expect(s.previous?.id).toBe("a");
    expect(s.next?.id).toBe("b");
    expect([s.previousCount, s.nextCount]).toEqual([1, 1]);
  });

  test("at the top of the file every comment is ahead", () => {
    const s = commentNavState([at("a", 900), at("b", 1200)], 0, 300);
    expect(s.previous).toBeUndefined();
    expect(s.next?.id).toBe("a");
    expect([s.previousCount, s.nextCount]).toEqual([0, 2]);
  });

  test("the offset is the one the scroll lands on", () => {
    expect(COMMENT_NAV_OFFSET).toBe(56);
  });
});

describe("comment navigation targets", () => {
  test("two comments ending on one line of one side are one stop", () => {
    const list = [comment("a", 4), comment("b", 2, "additions", 4), comment("c", 4, "deletions")];
    const got = navTargets(list, (c) => ({ top: c.lineNumber * 20, height: 20 }));
    expect(got.map((t) => t.comment.id)).toEqual(["a", "c"]);
  });

  test("a line that cannot be placed is skipped", () => {
    const got = navTargets([comment("a", 1), comment("b", 9)], (c) => (c.id === "a" ? null : { top: 1, height: 1 }));
    expect(got.map((t) => t.comment.id)).toEqual(["b"]);
  });

  test("a comment on the whole file is not a stop", () => {
    expect(navTargets([comment("a", 0)], () => ({ top: 0, height: 1 }))).toEqual([]);
  });
});

describe("comment navigation keys", () => {
  const key = (code: string, mods: Partial<KeyboardEvent> = {}) =>
    commentNavChord({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, code, ...mods } as KeyboardEvent);

  test("⌥⌘K goes back and ⌥⌘J goes on, read from the physical key", () => {
    expect(key("KeyK")).toBe("previous");
    expect(key("KeyJ")).toBe("next");
  });

  test("other chords are left alone", () => {
    expect(key("KeyK", { altKey: false })).toBeNull();
    expect(key("KeyJ", { shiftKey: true })).toBeNull();
    expect(key("KeyL")).toBeNull();
  });

  test("the keymap stands back from them and keeps ⌘K and ⌘J", () => {
    const chord = (k: string, alt: boolean) => ({ key: k, meta: true, shift: false, alt, editable: false });
    expect(resolveShortcut(chord("K", true))).toBeNull();
    expect(resolveShortcut(chord("J", true))).toBeNull();
    expect(resolveShortcut(chord("k", false))).toBe("palette");
    expect(resolveShortcut(chord("j", false))).toBe("toggle_terminal");
  });

  test("the sheet lists them under Code review", () => {
    const group = SHORTCUT_GROUPS.find((g) => g.title === "Code review");
    expect(group?.items.map((i) => i.keys)).toEqual(["⌘⌥K", "⌘⌥J"]);
    expect(group?.note).toBeTruthy();
  });
});

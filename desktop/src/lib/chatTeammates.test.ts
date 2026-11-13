import { describe, expect, test } from "bun:test";

import { chatTeammates, setChatTeammates } from "./chatTeammates";

const maya = { id: "u1", label: "Maya", detail: "@maya-k", kind: "mention" as const, insertText: "@maya-k" };
const sam = { id: "u2", label: "Sam", detail: "@samr", kind: "mention" as const, insertText: "@samr" };

describe("a chat's teammates", () => {
  test("are kept for their own chat only", () => {
    setChatTeammates("s-1", [maya, sam]);
    expect(chatTeammates("s-1").map((r) => r.insertText)).toEqual(["@maya-k", "@samr"]);
    expect(chatTeammates("s-2")).toEqual([]);
    expect(chatTeammates(null)).toEqual([]);
    setChatTeammates("s-1", []);
  });

  test("the same rows again keep the list it had, so nothing redraws", () => {
    setChatTeammates("s-3", [maya]);
    const first = chatTeammates("s-3");
    setChatTeammates("s-3", [{ ...maya }]);
    expect(chatTeammates("s-3")).toBe(first);
    setChatTeammates("s-3", [maya, sam]);
    expect(chatTeammates("s-3")).not.toBe(first);
    setChatTeammates("s-3", []);
    expect(chatTeammates("s-3")).toEqual([]);
  });
});

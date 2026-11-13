import { describe, expect, test } from "bun:test";

import { extractHandles, parseMentions } from "../src/lib/mentions";

describe("a mention ends where the handle does", () => {
  test("a full stop after a mention stays text", () => {
    expect(parseMentions("Ping @alice.")).toEqual([
      { kind: "text", text: "Ping " },
      { kind: "mention", handle: "alice", raw: "@alice" },
      { kind: "text", text: "." },
    ]);
  });

  test("dots and dashes inside a handle are kept", () => {
    expect(extractHandles("ask @mo.k and @sam-r, then @x_")).toEqual(["mo.k", "sam-r", "x_"]);
  });

  test("trailing punctuation of every kind stays outside", () => {
    expect(extractHandles("(@ann) @bob! @cy? @dee- @eve...")).toEqual(["ann", "bob", "cy", "dee", "eve"]);
  });

  test("an email address is not a mention", () => {
    expect(extractHandles("mail mo@example.com")).toEqual([]);
  });
});

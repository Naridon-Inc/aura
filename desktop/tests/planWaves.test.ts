// The multi-step launcher stages one task per wave of `aura plan`'s output,
// with the files a wave names claimed for that wave's task.
//
//   bun test tests/planWaves.test.ts

import { describe, expect, test } from "bun:test";
import { parseWaves } from "../src/components/manager/planWaves";

describe("parseWaves", () => {
  test("files listed after a wave's verify line stay with that wave", () => {
    const xml = [
      "<plan>",
      "<wave>",
      "<action>Add a retry helper</action>",
      "<verify>Unit tests cover five attempts</verify>",
      "<file>src/net/retry.ts</file>",
      "<file>src/net/retry.test.ts</file>",
      "</wave>",
      "<wave>",
      "<action>Use the helper when sending</action>",
      "<verify>Sends survive a dropped connection</verify>",
      "<file>src/net/send.ts</file>",
      "</wave>",
      "</plan>",
    ].join("\n");
    expect(parseWaves(xml)).toEqual([
      {
        action: "Add a retry helper",
        verify: "Unit tests cover five attempts",
        zones: ["src/net/retry.ts", "src/net/retry.test.ts"],
      },
      {
        action: "Use the helper when sending",
        verify: "Sends survive a dropped connection",
        zones: ["src/net/send.ts"],
      },
    ]);
  });

  test("waves without closing tags still split at the next action", () => {
    const xml = [
      "<action>First</action>",
      "<file>a.ts</file>",
      "<verify>one</verify>",
      "<action>Second</action>",
      "<verify>two</verify>",
    ].join("\n");
    expect(parseWaves(xml)).toEqual([
      { action: "First", verify: "one", zones: ["a.ts"] },
      { action: "Second", verify: "two", zones: [] },
    ]);
  });

  test("a wave written on one line keeps its verify", () => {
    const xml = "<wave><action>Only</action><verify>check</verify></wave>";
    expect(parseWaves(xml)).toEqual([{ action: "Only", verify: "check", zones: [] }]);
  });

  test("CDATA and entities are unwrapped", () => {
    const xml = "<action><![CDATA[Keep a < b & c]]></action>\n<verify>x &amp; y</verify>";
    expect(parseWaves(xml)).toEqual([{ action: "Keep a < b & c", verify: "x & y", zones: [] }]);
  });
});

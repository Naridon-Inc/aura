// The Concise chip: what it stores, what it hands the CLI, and that the turn
// context actually carries it.

import { describe, expect, test } from "bun:test";

import {
  outputStyleArg,
  parseOutputStyle,
  toggleOutputStyle,
} from "../src/lib/outputStyle";
import { readSrc } from "./support/code";

describe("output style", () => {
  test("only 'concise' is a style; everything else is the default", () => {
    expect(parseOutputStyle("concise")).toBe("concise");
    expect(parseOutputStyle("verbose")).toBe("default");
    expect(parseOutputStyle(null)).toBe("default");
  });

  test("toggles", () => {
    expect(toggleOutputStyle("default")).toBe("concise");
    expect(toggleOutputStyle("concise")).toBe("default");
  });

  test("the default adds nothing to the request", () => {
    expect(outputStyleArg("default")).toBeNull();
    expect(outputStyleArg("concise")).toBe("concise");
  });

  test("the chat view puts the style on the brain turn", async () => {
    const src = await readSrc("components/manager/ManagerChatView.tsx");
    expect(src).toContain("output_style: outputStyleArg(readOutputStyle())");
  });

  test("the turn context type knows the field", async () => {
    const src = await readSrc("lib/api.ts");
    expect(src).toMatch(/output_style\?: string \| null/);
  });
});

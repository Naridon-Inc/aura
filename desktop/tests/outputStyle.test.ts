// The Concise chip: what it stores, what it hands the CLI, and that the turn
// context actually carries it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  OUTPUT_STYLE_KEY,
  outputStyleArg,
  parseOutputStyle,
  readOutputStyle,
  subscribeOutputStyle,
  toggleOutputStyle,
  writeOutputStyle,
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

// Settings opens over the chats, so their composers are still mounted while
// the style is changed there. The Concise chip used to keep the value it read
// when the composer opened, showing one style while the send used another.
describe("one live output style", () => {
  let store: Map<string, string>;
  const scope = globalThis as { localStorage?: unknown };

  beforeEach(() => {
    store = new Map();
    scope.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  afterEach(() => {
    delete scope.localStorage;
  });

  test("a change made anywhere reaches every open reader", () => {
    const seen: string[] = [];
    const stopA = subscribeOutputStyle(() => seen.push(readOutputStyle()));
    const stopB = subscribeOutputStyle(() => seen.push(readOutputStyle()));
    writeOutputStyle("concise");
    expect(seen).toEqual(["concise", "concise"]);
    expect(store.get(OUTPUT_STYLE_KEY)).toBe("concise");
    stopA();
    writeOutputStyle("default");
    stopB();
    expect(seen).toEqual(["concise", "concise", "default"]);
    expect(store.has(OUTPUT_STYLE_KEY)).toBe(false);
  });

  test("the composer and Settings both read the live value", async () => {
    const composer = await readSrc("components/manager/ManagerComposer.tsx");
    const settings = await readSrc("components/settings/pages/ModelsPage.tsx");
    expect(composer).toContain("useOutputStyle()");
    expect(settings).toContain("useOutputStyle()");
  });
});

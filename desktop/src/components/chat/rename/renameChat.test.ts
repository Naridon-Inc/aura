import { describe, expect, test } from "bun:test";

import {
  cleanChatTitle,
  RENAME_CHAT_EVENT,
  renameChat,
  type RenameChatEffects,
  requestRenameChat,
} from "./renameChat";

function recorder(failSave = false) {
  const calls: string[] = [];
  const effects: RenameChatEffects = {
    save: async (sid, title) => {
      calls.push(`save ${sid} ${title}`);
      if (failSave) throw new Error("disk full");
    },
    updateList: (sid, title) => void calls.push(`list ${sid} ${title}`),
    updateTab: (sid, title) => void calls.push(`tab ${sid} ${title}`),
  };
  return { calls, effects };
}

describe("a typed chat name", () => {
  test("becomes one clean line", () => {
    expect(cleanChatTitle("  Fix the  retry\nbackoff ")).toBe("Fix the retry backoff");
  });
  test("is nothing when only whitespace is left", () => {
    expect(cleanChatTitle("  \n\t ")).toBeNull();
    expect(cleanChatTitle("")).toBeNull();
  });
  test("stops at 100 characters, like the automatic title", () => {
    expect(Array.from(cleanChatTitle("é".repeat(140)) ?? "").length).toBe(100);
  });
});

describe("renaming a chat", () => {
  test("saves the cleaned name, then shows it in the list and the tab", async () => {
    const { calls, effects } = recorder();
    expect(await renameChat("s1", "  New   name ", "Old", effects)).toBe("New name");
    expect(calls).toEqual(["save s1 New name", "list s1 New name", "tab s1 New name"]);
  });
  test("does nothing for a blank name", async () => {
    const { calls, effects } = recorder();
    expect(await renameChat("s1", "   ", "Old", effects)).toBeNull();
    expect(calls).toEqual([]);
  });
  test("does nothing when the name did not change", async () => {
    const { calls, effects } = recorder();
    expect(await renameChat("s1", " Old ", "Old", effects)).toBeNull();
    expect(calls).toEqual([]);
  });
  test("a failed save leaves the old name on the list and the tab", async () => {
    const { calls, effects } = recorder(true);
    await expect(renameChat("s1", "New", "Old", effects)).rejects.toThrow("disk full");
    expect(calls).toEqual(["save s1 New"]);
  });
});

describe("asking for the rename dialog", () => {
  test("sends the chat and its current name", () => {
    const seen: unknown[] = [];
    const target = new EventTarget();
    const g = globalThis as unknown as { window?: EventTarget };
    const had = g.window;
    g.window = target;
    target.addEventListener(RENAME_CHAT_EVENT, (e) => seen.push((e as CustomEvent).detail));
    try {
      requestRenameChat("s1", "Old");
    } finally {
      g.window = had;
    }
    expect(seen).toEqual([{ sessionId: "s1", currentTitle: "Old" }]);
  });
});

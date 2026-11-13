// Run with: bun test src/components/chat/chatViewSwitch.test.ts
//
// The agent pane has no sub-header row. The Chat / CLI switch, and the
// transcript's search and copy, used to sit in one above the conversation and
// above the terminal; they now ride in the composer footer, which shows in both
// views. Pinned by source scan because each is an import or a prop.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("agent pane without a sub-header", () => {
  test("no surface draws the old heading row", () => {
    expect(existsSync(join(SRC, "components/chat/ChatHeader.tsx"))).toBe(false);
    for (const rel of [
      "components/agent/AgentSurface.tsx",
      "components/agent/StreamChatView.tsx",
      "components/agent/normalized/NormalizedTranscript.tsx",
    ]) {
      expect(read(rel)).not.toContain("ChatHeader");
    }
  });

  test("the switch is the shared toggle group", () => {
    const src = read("components/chat/ChatViewSwitcher.tsx");
    expect(src).toContain('from "../ui/toggle-group"');
    expect(src).toContain('type="single"');
    expect(src).toContain('value="terminal"');
    expect(src).toContain('value="chat"');
  });

  test("every composer in the timeline carries the switch and the tools", () => {
    const transcript = read("components/agent/normalized/NormalizedTranscript.tsx");
    expect(transcript).toContain("<TimelineToolsContext.Provider");
    expect(transcript).toContain("<TimelineViewSwitch />");
    expect(transcript).toContain("<TimelineMenuItems />");
    const agent = read("components/agent/chat/AgentChatComposer.tsx");
    expect(agent).toContain("<TimelineViewSwitch />");
    expect(agent).toContain("<TimelineMenuItems />");
    expect(read("components/agent/OpenAiCompatChatView.tsx")).toContain(
      "<TimelineMenuItems />",
    );
  });

  test("search and copy stay out of the strip over the terminal", () => {
    const tools = read("components/agent/normalized/timelineTools.tsx");
    expect(tools).toMatch(/if \(!tools \|\| tools\.overlay\) return null;/);
    expect(tools).toContain('"Search conversation"');
    expect(tools).toContain('"Copy conversation"');
  });

  test("the old heading's controls left no rules behind", () => {
    const css = read("components/agent/chatView.css");
    for (const cls of [
      ".chat-view-switcher",
      ".chat-heading-search",
      ".chat-heading-actions",
      ".chat-workspace-name",
      ".chat-icon-button",
      ".chat-send",
      ".chat-stop",
      ".chat-compose-box",
    ]) {
      expect(css).not.toContain(cls);
    }
  });
});

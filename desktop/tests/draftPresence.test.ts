// The draft pencil: what counts as a draft, and that both composers file
// their drafts under the prefixes the tab strip looks up.

import { describe, expect, test } from "bun:test";

import {
  AGENT_DRAFT_PREFIX,
  MANAGER_DRAFT_PREFIX,
} from "../src/components/composer/composerDrafts";
import { hasDraftText } from "../src/lib/draftPresence";
import { readSrc, stripComments } from "./support/code";

describe("hasDraftText", () => {
  test("whitespace is not a draft", () => {
    expect(hasDraftText("")).toBe(false);
    expect(hasDraftText("   \n")).toBe(false);
    expect(hasDraftText(null)).toBe(false);
  });
  test("anything typed is", () => {
    expect(hasDraftText("fix the")).toBe(true);
  });
});

describe("composers file drafts where the strip looks", () => {
  test("the Aura chat composer uses MANAGER_DRAFT_PREFIX", async () => {
    const src = stripComments(await readSrc("components/manager/ManagerComposer.tsx"));
    expect(src).toContain("MANAGER_DRAFT_PREFIX");
    expect(src).not.toMatch(/const DRAFT_PREFIX = "aura\.manager\.draft:"/);
  });

  test("the agent chat composer's private prefix matches AGENT_DRAFT_PREFIX", async () => {
    // AgentChatComposer isn't rewired (not this change's file); the strip
    // relies on its literal staying equal to the exported constant.
    const src = await readSrc("components/agent/chat/AgentChatComposer.tsx");
    const m = src.match(/DRAFT_PREFIX = "([^"]+)"/);
    expect(m?.[1]).toBe(AGENT_DRAFT_PREFIX);
    expect(MANAGER_DRAFT_PREFIX).not.toBe(AGENT_DRAFT_PREFIX);
  });

  test("the tab strip draws the pencil for both tab kinds", async () => {
    const src = await readSrc("components/WorkSurface.tsx");
    expect(src).toContain("AGENT_DRAFT_PREFIX");
    expect(src).toContain("MANAGER_DRAFT_PREFIX");
    expect(src).toContain("<DraftMark");
  });
});

// Run with: bun test src/components/chat/chatDockColumn.test.ts
//
// Two regressions from the chat unification, pinned by source scan because
// both are a stylesheet rule or an import, and both only show in a wide pane:
//
// 1. The composer stretched edge to edge while the messages above it sat in a
//    reading column, and the dock under every chat painted its own band (a
//    darker fill and a rule above it). The dock now shares the transcript's
//    column and its ground.
// 2. The agent chats drew their own model picker — a bare Radix popover with
//    an unstyled class, and a free-text box — instead of the Aura chat's. All
//    three pickers now mount the same shell and catalog.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** The declaration block of every rule whose selector list is exactly `selector`. */
function rules(css: string, selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(re)) {
    if (m[1].trim() === selector) out.push(m[2]);
  }
  return out;
}

const chatView = read("components/agent/chatView.css");
const chatComposer = read("components/chat/ChatComposer.css");
// Loaded AFTER ChatComposer.css in the production bundle, so where both set
// the same property on the same selector, this file is the one that applies.
const shellCss = read("styles.css");

describe("chat dock", () => {
  test("the composer is no longer uncapped", () => {
    expect(chatView).not.toMatch(/\.chat-composer\s*>\s*div\s*\{\s*max-width:\s*none/);
  });

  test("the reading column is a column, not the whole pane", () => {
    const decl = rules(shellCss, ".aura-chat").join(";");
    const col = decl.match(/--chat-col:\s*([^;]+)/)?.[1].trim();
    expect(col).toBeDefined();
    expect(col).toMatch(/^\d+px$/);
    // One source: a second declaration here is what once made it 100% in
    // dev while production showed something else.
    expect(rules(chatComposer, ".aura-chat").join(";")).not.toContain("--chat-col");
  });

  test("the agent dock caps every child to that column", () => {
    const children = rules(chatView, ".chat-dock > *").join(";");
    expect(children).toMatch(/max-width:\s*var\(--chat-col/);
  });

  test("no dock paints its own band", () => {
    const blocks = [
      ...rules(chatView, ".chat-dock"),
      ...rules(chatView, ".chat-composer"),
      ...rules(chatView, ".chat-controls"),
      ...rules(chatView, ".chat-controls:not(:empty)"),
      ...rules(chatComposer, ".aura-chat .p-dock"),
      ...rules(shellCss, ".aura-chat .p-dock"),
    ];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/background:\s*var\(--color-bg-1\)/);
      expect(block).not.toMatch(/border-top:\s*1px/);
      expect(block).not.toMatch(/background:\s*var\(--color-bg-[0-9]\)/);
    }
  });

  test("a docked card fuses onto the composer instead of being flattened", () => {
    expect(chatView).not.toContain(".question-flow.is-docked { border: 0");
    expect(chatView).not.toContain("has-docked-control");
    expect(chatView).toMatch(/\.chat-dock:has\(\.composer-docked\)\s*\{\s*gap:\s*0/);
  });

  test("usage, controls and composer render inside the dock", () => {
    const src = read("components/agent/normalized/NormalizedTranscript.tsx");
    const dock = src.slice(src.indexOf('<div className="chat-dock">'));
    expect(dock.indexOf("SessionUsageStrip")).toBeGreaterThan(0);
    expect(dock.indexOf("{controls}")).toBeGreaterThan(0);
    expect(dock.indexOf("{composer}")).toBeGreaterThan(0);
    expect(src).not.toContain("max-w-[760px]");
  });

  test("the terminal-agent composer fuses under a docked question", () => {
    const src = read("components/agent/normalized/NormalizedTranscript.tsx");
    expect(src).toContain("docked={questionDock != null}");
    const composer = read("components/agent/chat/AgentChatComposer.tsx");
    expect(composer).toContain('"composer composer-docked"');
  });
});

describe("one model picker", () => {
  const pickers = [
    "components/manager/BrainPicker.tsx",
    "components/agent/chat/AgentChatComposer.tsx",
    "components/chat/ModelCatalogPopover.tsx",
  ];

  test("every picker mounts the shared shell", () => {
    expect(read("components/manager/BrainPicker.tsx")).toContain("<ModelCatalogPopover");
    expect(read("components/agent/chat/AgentChatComposer.tsx")).toContain("<ModelCatalogPopover");
    expect(read("components/agent/StreamChatView.tsx")).toContain("<AgentTurnModelPicker");
    expect(read("components/chat/ModelCatalogPopover.tsx")).toMatch(
      /export function AgentTurnModelPicker[\s\S]*<ModelCatalogPopover/,
    );
  });

  test("the shell carries the class the stylesheet actually styles", () => {
    const shell = read("components/chat/ModelCatalogPopover.tsx");
    expect(shell).toContain('className="chat-menu-surface chat-catalog-popover"');
    expect(chatComposer).toContain(".chat-catalog-popover.chat-menu-surface");
    for (const file of pickers) {
      expect(read(file)).not.toContain("composer-catalog-popover");
    }
  });

  test("no picker keeps favorites to itself", () => {
    for (const file of pickers) {
      const src = read(file);
      expect(src).not.toMatch(/useState<string\[\]>\(\[\]\)/);
      expect(src).not.toContain('"aura.manager.modelFavorites"');
    }
  });

  test("the agent chat names its agent, not its id", () => {
    const shell = read("components/chat/ModelCatalogPopover.tsx");
    expect(shell).toMatch(/label:\s*agentName\(agentId\)/);
    expect(read("components/agent/chat/AgentChatComposer.tsx")).toContain(
      "agentCatalogBrain(agentId)",
    );
  });

  test("the free-text-only picker is gone", () => {
    expect(read("components/chat/ChatComposer.tsx")).not.toContain("export function ChatModelPicker");
  });
});

// A file dragged over the chat shows where it will land, and a long paste
// goes in as a file. The drop mark is drawn by the shared box; the main chat
// composer drives it from the desktop drop router, whose drag events are the
// only ones a Finder drag produces in the app's window.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../ui/composer";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const noop = () => {};
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(Composer, { value: "", onChange: noop, onSend: noop, ...props }));

describe("composer drop and paste", () => {
  test("a drag over the chat lays the upload mark over the box", () => {
    expect(render({})).not.toContain("ui-composer-drop");
    const over = render({ dragOver: true });
    expect(over).toContain('class="ui-composer-drop" aria-hidden="true"');
    expect(over).toContain("lucide-upload");
    // A read-only box takes nothing, so it shows nothing.
    expect(render({ dragOver: true, disabled: true })).not.toContain("ui-composer-drop");
    const css = read("components/ui/interface.css");
    expect(css).toMatch(/\.ui-composer-drop \{[^}]*inset:\s*0[^}]*border:\s*1px solid var\(--ui-border\)[^}]*border-radius:\s*inherit[^}]*color-mix\(in srgb, var\(--ui-bg\) 80%/);
    expect(css).toMatch(/\.ui-composer-drop svg \{[^}]*width:\s*20px/);
  });

  test("the main chat composer follows the drop router and attaches long pastes", () => {
    const host = read("components/manager/ManagerComposer.tsx");
    expect(host).toContain('setOsDragOver(detail?.kind === "composer" && !detail?.targetId);');
    expect(host).toMatch(/attachLongPaste\s+dragOver=\{osDragOver\}/);
    // The agent tab's composer has no attachment delivery yet, so a long
    // paste stays text there.
    expect(read("components/agent/chat/AgentChatComposer.tsx")).not.toContain("attachLongPaste");
    const box = read("components/ui/composer.tsx");
    expect(box).toMatch(/attachLongPaste && onAttach && isLongPaste\(text\)[\s\S]{0,80}onAttach\(\[longPasteFile\(text\)\]\)/);
  });
});

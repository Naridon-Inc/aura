// Run with: bun test src/components/chat/composerFocusHint.test.ts
//
// An empty composer that does not have focus names the key that focuses it
// ("⌘L to focus") in a small pill: top right of the box, or in the footer row
// while the box is folded. It goes away as soon as there is something in the
// box, and only a host that actually binds a focus key passes one — a pill
// naming a key that does nothing would be worse than no pill.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, type ComposerProps } from "../ui/composer";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const noop = () => {};
const render = (props: Partial<ComposerProps>) =>
  renderToStaticMarkup(
    createElement(Composer, { value: "", onChange: noop, onSend: noop, ...props }),
  );
const HINT = '<span class="ui-composer-focus-hint">⌘L to focus</span>';

describe("the composer names its focus key", () => {
  test("an empty box shows the pill above the footer and keeps room for it", () => {
    const html = render({ focusShortcut: "⌘L" });
    expect(html).toContain(HINT);
    expect(html.indexOf(HINT)).toBeLessThan(html.indexOf("ui-composer-footer"));
    expect(html).toContain('data-focus-hint="true"');
  });

  test("a folded box shows it in the footer row instead", () => {
    const html = render({ focusShortcut: "⌘L", minimized: true });
    expect(html.indexOf(HINT)).toBeGreaterThan(html.indexOf("ui-composer-actions"));
  });

  test("text, an attachment, a disabled box or no key hides it", () => {
    expect(render({ focusShortcut: "⌘L", value: "hi" })).not.toContain("to focus");
    expect(
      render({ focusShortcut: "⌘L", attachments: [{ id: "a", name: "a.png" }] }),
    ).not.toContain("to focus");
    expect(render({ focusShortcut: "⌘L", disabled: true })).not.toContain("to focus");
    expect(render({})).not.toContain("to focus");
  });

  test("the main chat composer passes the key it binds", () => {
    const src = read("components/manager/ManagerComposer.tsx");
    expect(src).toContain("focusShortcut={`${modKeyLabel()}L`}");
    expect(src).toMatch(/e\.key === "l" \|\| e\.key === "L"/);
  });

  test("the pill sits top right and the field keeps its width clear", () => {
    const css = read("components/ui/interface.css");
    expect(css).toMatch(/\.ui-composer > \.ui-composer-focus-hint \{\s*position: absolute;\s*top: 8px;\s*right: 4px;/);
    expect(css).toMatch(/\.ui-composer\[data-focus-hint\]:not\(\[data-composer-minimized="true"\]\) textarea \{\s*padding-right: 144px;/);
  });
});

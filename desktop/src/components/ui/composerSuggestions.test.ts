import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "./composer";
import { matchedLetters, matchSuggestions, SuggestionRow, type ComposerSuggestion } from "./composerSuggestions";

const cmd = (name: string, detail?: string): ComposerSuggestion => ({
  id: name,
  label: `/${name}`,
  detail,
  insertText: `/${name}`,
  kind: "command",
});
const row = (item: ComposerSuggestion, query = "") =>
  renderToStaticMarkup(createElement(SuggestionRow, { item, query }));

describe("composer @ and / lists", () => {
  test("a row named exactly what was typed comes first; the list isn't cut at eight", () => {
    const list = [cmd("reviewer"), cmd("pr-review"), cmd("review")];
    expect(matchSuggestions(list, "/", "review").map((s) => s.id)).toEqual(["review", "reviewer", "pr-review"]);
    const many = Array.from({ length: 30 }, (_, i) => cmd(`c${i}`));
    expect(matchSuggestions(many, "/", "")).toHaveLength(30);
    expect(matchSuggestions(many, "@", "")).toHaveLength(0);
  });

  test("the matched letters stay; the rest dim once something is typed", () => {
    expect(matchedLetters("review", "vie")).toEqual([2, 3, 4]);
    expect(matchedLetters("review", "rvw")).toEqual([0, 2, 5]);
    expect(matchedLetters("review", "xyz")).toEqual([]);
    expect(row(cmd("review"))).not.toContain("ui-suggestion-dim");
    expect(row(cmd("review"), "vie")).toContain('<span class="ui-suggestion-dim">re</span><span>vie</span><span class="ui-suggestion-dim">w</span>');
  });

  test("a command reads '/ name  description' on one line", () => {
    expect(row(cmd("review", "Review the diff"))).toBe(
      '<span class="ui-suggestion-sigil">/</span><span class="ui-suggestion-name">review</span><span class="ui-suggestion-detail">Review the diff</span>',
    );
  });

  test("a file reads 'icon name  folder', marked by what follows the last slash", () => {
    const file: ComposerSuggestion = {
      id: "file:src/components/composer.tsx",
      label: "src/components/composer.tsx",
      name: "composer.tsx",
      detail: "src/components",
      insertText: "@src/components/composer.tsx",
      kind: "mention",
      icon: createElement("svg", { "data-icon": "file" }),
    };
    const html = row(file, "src/components/comp");
    expect(html).toStartWith('<span class="ui-suggestion-icon"><svg data-icon="file"></svg></span><span class="ui-suggestion-name">');
    expect(html).toContain('<span>comp</span><span class="ui-suggestion-dim">oser.tsx</span>');
    expect(html).toEndWith('<span class="ui-suggestion-detail">src/components</span>');
  });

  test("rows carry their index and kind; the pointer moves the selection", () => {
    const html = renderToStaticMarkup(
      createElement(Composer, { value: "/re", onChange: () => {}, onSend: () => {}, suggestions: [cmd("review"), cmd("rebase")] }),
    );
    expect(html).toContain('data-kind="command" data-list-index="0" aria-selected="true"');
    expect(html).toContain('data-list-index="1" aria-selected="false"');
    const src = readFileSync(join(import.meta.dir, "composer.tsx"), "utf8");
    expect(src).toContain("onMouseMove={() => index !== activeIndex && setActiveSuggestion(index)}");
    expect(src).toMatch(/querySelector\(`\[data-list-index="\$\{activeIndex\}"\]`\)\s*\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
  });

  test("the chat composer's list is a tab on the box's top edge", () => {
    const css = readFileSync(join(import.meta.dir, "patterns.css"), "utf8");
    const tab = css.match(/\.ui-composer > \.ui-composer-suggestions \{([^}]*)\}/)?.[1] ?? "";
    for (const rule of [
      "bottom: calc(100% + 1px)",
      "left: 7px",
      "right: 7px",
      "max-height: 308px",
      "background: var(--ui-bg)",
      "border-bottom: 0",
      "border-radius: 8px 8px 0 0",
    ])
      expect(tab).toContain(rule);
    expect(css).toMatch(/> button\[aria-selected="true"\] \{\s*background: var\(--ui-sidebar-accent\)/);
    expect(css).toMatch(/\.ui-suggestion-detail \{[^}]*font-size: 10px[^}]*letter-spacing: 0\.04em/);
    expect(css).toMatch(/\.ui-suggestion-dim \{\s*opacity: 0\.5/);
  });
});

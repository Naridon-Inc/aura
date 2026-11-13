// Run with: bun test src/components/ui/textFieldOverflow.test.ts
//
// Every empty text field showed a horizontal scrollbar once the app was
// zoomed in (⌘+, webview zoom above 100%): the create dialog, the PR reply,
// the settings fields. WebKit lays a field's placeholder out at the content
// width times the zoom a second time, so at 110% an empty textarea's
// placeholder is ~25px wider than the field and the field scrolls sideways.
// At 100% nothing overflows, which is why it never showed in a default
// headless check. Pinned by source scan because it is two global rules.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
const css = readFileSync(join(SRC, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block of every top-level rule whose selector is exactly `selector`. */
function rules(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim() === selector) out.push(m[2]);
  }
  return out;
}

describe("text fields never scroll sideways", () => {
  test("a placeholder is capped at its field's width", () => {
    expect(rules("::placeholder").join(";")).toMatch(/max-width:\s*100%/);
  });

  test("a textarea only scrolls down", () => {
    expect(rules("textarea").join(";")).toMatch(/overflow-x:\s*hidden/);
  });
});

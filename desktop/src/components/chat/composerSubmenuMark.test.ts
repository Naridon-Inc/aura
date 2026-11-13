// Run with: bun test src/components/chat/composerSubmenuMark.test.ts
//
// The composer's ＋ menu has its own row family, and its submenu rows end in a
// muted text "›". Every other menu keeps the shared chevron icon, as the
// reference's shared submenu trigger does. Scanned rather than rendered: the
// rows only exist inside an open menu.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("the ＋ menu's submenu mark", () => {
  test("both ＋ submenu rows pass the text mark", () => {
    const src = read("components/chat/composer/ComposerTurnMenu.tsx");
    expect(src).toMatch(/className="ui-menu-sub-mark">\s*›\s*<\/span>/);
    expect(src.match(/<DropdownMenuSubTrigger[^>]*indicator=\{SUBMENU_MARK\}/g)?.length).toBe(2);
  });

  test("the shared trigger still defaults to the chevron", () => {
    const src = read("components/ui/dropdown-menu.tsx");
    expect(src).toContain('{indicator ?? <ChevronRight className="ml-auto h-4 w-4 text-text-4" />}');
  });
});

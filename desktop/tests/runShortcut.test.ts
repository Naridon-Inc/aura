// ⌘R has to mean the same thing in three files, and only one of them is
// JavaScript.
//
// On macOS a native menu accelerator is handled in `performKeyEquivalent:`,
// *before* the responder chain — so whatever `menu.rs` binds to ⌘R wins, and
// the webview's keydown never runs. Moving ⌘R from Reload to Run therefore
// takes: the native menu item, the in-app keymap (for Linux/Windows and for
// when the menubar isn't focused), and the palette hint people read to learn
// the binding.
//
// Miss the Rust half and ⌘R reloads the app instead of running the project —
// which looks exactly like Run being broken, because the page you would read
// the error on is gone. Miss the palette and the app teaches the old binding.

import { describe, expect, it } from "bun:test";

import { resolveShortcut } from "../src/lib/keymap";
import { readSrc, stripComments } from "./support/code";

const menuRs = stripComments(
  await Bun.file(`${import.meta.dir}/../src-tauri/src/menu.rs`).text(),
);

/** The accelerator bound to a native menu item id, if it declares one. */
function accelerator(id: string): string | null {
  const item = menuRs.match(
    new RegExp(`with_id\\("${id}"[\\s\\S]{0,200}?\\.build\\(h\\)`),
  );
  if (!item) return null;
  return item[0].match(/\.accelerator\("([^"]+)"\)/)?.[1] ?? null;
}

describe("the native menu", () => {
  it("gives ⌘R to Run, because it takes the key before the webview sees it", () => {
    expect(accelerator("run_project")).toBe("CmdOrCtrl+R");
  });

  it("moves Reload to ⌘⇧R rather than leaving two items on one key", () => {
    expect(accelerator("reload_app")).toBe("CmdOrCtrl+Shift+R");
  });

  it("keeps the Review panel on ⌘⌥R", () => {
    expect(accelerator("toggle_review")).toBe("CmdOrCtrl+Alt+R");
  });
});

describe("the in-app keymap", () => {
  // Asked of the resolver rather than of the source text. The branch used to
  // be scanned for `dispatch("run_project")`, which pinned a spelling and not
  // a behaviour — it broke when the table moved into `resolveShortcut` while
  // still routing ⌘R exactly as before. This asks the question directly, so it
  // survives the next refactor and fails only when the meaning changes.
  it("routes plain ⌘R to run_project, shift to reload, alt to review", () => {
    const r = (mods: { shift?: boolean; alt?: boolean } = {}) =>
      resolveShortcut({
        key: "r",
        meta: true,
        shift: false,
        alt: false,
        editable: false,
        ...mods,
      });
    expect(r()).toBe("run_project");
    // The old branch bailed out on shift and let the webview reload. Relying
    // on a shortcut we don't install is not a binding.
    expect(r({ shift: true })).toBe("reload_app");
    expect(r({ alt: true })).toBe("toggle_review");
  });

  it("routes the menu event too, or the menu item would be dead", async () => {
    const src = await readSrc("lib/keymap.ts");
    const ids = src.match(/const MENU_ACTION_IDS[\s\S]*?\];/)?.[0] ?? "";
    expect(ids).toContain('"run_project"');
  });

  it("knows run_project as an action id", async () => {
    const src = await readSrc("lib/keymap.ts");
    const union = src.match(/export type AppActionId =[\s\S]*?;/)?.[0] ?? "";
    expect(union).toContain('"run_project"');
  });
});

describe("what the app teaches", () => {
  it("advertises ⌘R for Run in the palette", async () => {
    const src = await readSrc("components/CommandPalette.tsx");
    const row = src.match(/\{[^{}]*id: "run_project"[^{}]*\}/)?.[0] ?? "";
    expect(row).toContain('hint: "⌘R"');
  });
});

describe("the handler", () => {
  it("opens the terminal panel, which is the only thing that owns terminals", async () => {
    const src = await readSrc("App.tsx");
    const arm = src.match(/case "run_project": \{[\s\S]*?\n        \}/)?.[0] ?? "";
    expect(arm).toContain("setTerminalPanelOpen(true)");
    // How the request then reaches the panel it just opened — and why it can't
    // be a timer — is runRequest.test.ts's subject.
  });
});

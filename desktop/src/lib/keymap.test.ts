import { describe, expect, test } from "bun:test";

import { resolveShortcut, type Chord } from "./keymap";

// The native menubar is macOS-only (src-tauri/src/menu.rs, `install`) — on
// Linux and Windows it drew a second bar inside the window, over the page, so
// it is no longer attached there. That deletes the window's whole accelerator
// table on those platforms, which makes THIS the only thing left that runs a
// shortcut. So the rule these pin is: every accelerator menu.rs declares has a
// twin here, or it is unreachable by keyboard off macOS.

function chord(key: string, mods: Partial<Chord> = {}): Chord {
  return { key, meta: true, shift: false, alt: false, editable: false, ...mods };
}

describe("the accelerators the macOS menubar used to own", () => {
  test("Ctrl+S saves — the File menu's CmdOrCtrl+S", () => {
    expect(resolveShortcut(chord("s"))).toBe("save");
  });

  test("Ctrl+O opens a project — the File menu's CmdOrCtrl+O", () => {
    expect(resolveShortcut(chord("o"))).toBe("open_file");
  });

  test("Ctrl+Shift+I logs intent — the Engine menu's CmdOrCtrl+Shift+I", () => {
    expect(resolveShortcut(chord("i", { shift: true }))).toBe("aura_log_intent");
  });

  test("plain Ctrl+I is not ours — it is italic in every rich-text surface", () => {
    expect(resolveShortcut(chord("i"))).toBeNull();
  });

  test("Ctrl+Shift+S stays Monaco's Share-to-chat, not a save", () => {
    expect(resolveShortcut(chord("s", { shift: true }))).toBeNull();
  });

  test("Ctrl+Shift+O is nobody's, so we don't swallow it", () => {
    expect(resolveShortcut(chord("o", { shift: true }))).toBeNull();
  });
});

describe("the shortcuts that were already here keep answering", () => {
  test("the palette, the terminal and settings", () => {
    expect(resolveShortcut(chord("k"))).toBe("palette");
    expect(resolveShortcut(chord("j"))).toBe("toggle_terminal");
    expect(resolveShortcut(chord(","))).toBe("settings");
  });

  test("R branches three ways on its modifiers", () => {
    expect(resolveShortcut(chord("r"))).toBe("run_project");
    expect(resolveShortcut(chord("r", { shift: true }))).toBe("reload_app");
    expect(resolveShortcut(chord("r", { alt: true }))).toBe("toggle_review");
  });

  test("W closes a tab, Shift+W opens Workspaces", () => {
    expect(resolveShortcut(chord("w"))).toBe("close_tab");
    expect(resolveShortcut(chord("w", { shift: true }))).toBe("workspaces");
  });

  test("zoom takes both spellings of each key", () => {
    expect(resolveShortcut(chord("="))).toBe("zoom_in");
    expect(resolveShortcut(chord("+"))).toBe("zoom_in");
    expect(resolveShortcut(chord("-"))).toBe("zoom_out");
    expect(resolveShortcut(chord("_"))).toBe("zoom_out");
    expect(resolveShortcut(chord("0"))).toBe("zoom_reset");
  });
});

describe("the chords that stand down for a text cursor", () => {
  test("B is bold while you are typing, sidebar when you are not", () => {
    expect(resolveShortcut(chord("b"))).toBe("toggle_sidebar");
    expect(resolveShortcut(chord("b", { editable: true }))).toBeNull();
  });

  test("Z is text undo while you are typing, engine undo when you are not", () => {
    expect(resolveShortcut(chord("z"))).toBe("aura_undo");
    expect(resolveShortcut(chord("z", { editable: true }))).toBeNull();
    expect(resolveShortcut(chord("z", { shift: true }))).toBeNull();
  });
});

describe("what we never claim", () => {
  test("an unmodified key is the page's", () => {
    expect(resolveShortcut(chord("s", { meta: false }))).toBeNull();
    expect(resolveShortcut(chord("k", { meta: false }))).toBeNull();
  });

  test("a key with no row falls through so the webview gets it", () => {
    expect(resolveShortcut(chord("c"))).toBeNull();
    expect(resolveShortcut(chord("v"))).toBeNull();
    expect(resolveShortcut(chord("x"))).toBeNull();
    expect(resolveShortcut(chord("f"))).toBeNull();
  });

  test("the key arrives however the OS spells its case", () => {
    expect(resolveShortcut(chord("S"))).toBe("save");
    expect(resolveShortcut(chord("I", { shift: true }))).toBe("aura_log_intent");
  });
});

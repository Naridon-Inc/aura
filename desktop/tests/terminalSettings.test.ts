// Settings → Terminal calls a shell a shell, and lets you set the type size.
//
//   bun test
//
// Driven in a real window, the pane read:
//
//     PROFILE
//     Default profile                                    [ zsh  ▾ ]
//     The shell every new terminal tab opens with.
//
//     VISUAL
//     Cursor blink   …   Bell   …
//     HISTORY
//     Scrollback lines                                   [ 5k   ▾ ]
//
// Two things. The heading said "profile" over a list of shells while its own
// description said "shell", and the `+` menu that opens these has always
// called them Shells — one list, two names, and the losing name already
// means a git identity + agent HOME two rails up in Accounts & profiles.
//
// And the size of the text was not settable anywhere. Appearance's font row
// said "the terminal keeps its own size", which was true and unhelpful: the
// size was compiled in, 12 on mac and 14 elsewhere, and no screen in the app
// could change it. A terminal pane offering a bell but not a type size is
// picking the wrong two controls.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const DIALOG = "components/dialogs/SettingsDialog.tsx";
const SHELL_TERM = "components/Terminal.tsx";
const AGENT_TERM = "components/agent/AgentTerminalView.tsx";
const STORE = "lib/settingsStore.ts";
const API = "lib/api.ts";

async function terminalTab(): Promise<string> {
  const src = await readSrc(DIALOG);
  const start = src.indexOf("function TerminalTab()");
  expect(start).toBeGreaterThan(0);
  return src.slice(start, src.indexOf("\nfunction ", start + 10));
}

describe("terminal settings — the shell is called a shell", () => {
  test("no user-facing string on the pane says profile", async () => {
    const tab = await terminalTab();
    for (const shown of [
      'title="Profile"',
      'label="Default profile"',
      'aria-label="Default profile"',
      "No profiles found",
    ]) {
      expect(tab).not.toContain(shown);
    }
  });

  test("it says shell, in the heading, the row and the empty state", async () => {
    const tab = await terminalTab();
    expect(tab).toContain('title="Shell"');
    expect(tab).toContain('label="Default shell"');
    expect(tab).toContain('aria-label="Default shell"');
    expect(tab).toContain("No shells found");
  });

  test("the `+` menu and the pane now use one word for one list", async () => {
    const menu = await readSrc("components/terminal/TerminalNewMenu.tsx");
    // The menu was always right; this is the side that moved.
    expect(menu).toContain("Choose the Default Shell");
  });

  test("the type keeps its name — only the copy changed", async () => {
    const tab = await terminalTab();
    expect(tab).toContain("TerminalProfile");
    expect(tab).toContain("terminalProfileSetDefault");
  });
});

describe("terminal settings — text size", () => {
  test("the pane offers one", async () => {
    const tab = await terminalTab();
    expect(tab).toContain('label="Text size"');
    expect(tab).toContain("setTerminalFontSize");
    expect(tab).toContain("defaultTerminalFontSize()");
  });

  test("never-set means the platform default, not an invented number", async () => {
    const store = await readSrc(STORE);
    expect(store).toContain("font_size: null");
    expect(store).toContain("export function defaultTerminalFontSize()");
    // 12 on macOS, 14 elsewhere — the VS Code defaults the xterm
    // construction already matched by hand.
    const fn = store.slice(store.indexOf("export function defaultTerminalFontSize()"));
    expect(fn.slice(0, 300)).toContain("isMac ? 12 : 14");
  });

  test("the wire type admits the unset state", async () => {
    const api = await readSrc(API);
    const terminal = api.slice(api.indexOf("  terminal: {", api.indexOf("export type AppSettings")));
    expect(terminal.slice(0, 600)).toContain("font_size: number | null");
  });

  test("both terminals read it — the agent one included", async () => {
    const shell = await readSrc(SHELL_TERM);
    expect(shell).toContain("tprefs.font_size ?? (isMac ? 12 : 14)");
    const agent = await readSrc(AGENT_TERM);
    // The agent view's own tuning stays the default; a chosen size wins.
    expect(agent).toContain("tprefs.font_size ?? 12.5");
  });

  test("Appearance stops pointing at a size that had no control", async () => {
    const src = await readSrc(DIALOG);
    expect(src).not.toContain("The terminal keeps its own size");
    expect(src).toContain("Terminals have their own, on the Terminal page");
  });
});

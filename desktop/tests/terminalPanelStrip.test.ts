// The terminal panel in the right column: its tabs, its Run task list, the
// new-terminal cap, the collapse chevron's words and the remembered split.

import { describe, expect, test } from "bun:test";
import {
  MAX_TERMINALS,
  RUN_TAB,
  SETUP_TAB,
  runTasks,
  stripTabs,
} from "../src/components/terminal/terminalStrip";
import { runControlsState } from "../src/components/terminal/RunControls";
import { SETUP_BUTTON_LABELS } from "../src/components/terminal/SetupScriptButton";
import { newTerminalState, terminalPanelToggleLabel } from "../src/components/ui/details-terminal";
import {
  SCRIPTS_DEFAULT_SHARE,
  SCRIPTS_MIN_SHARE,
  parseScriptsShare,
} from "../src/components/RightColumnSplit";
import type { PanelGroupView } from "../src/components/terminal/grouping";
import type { TerminalTab } from "../src/lib/editorStore";

const term = (termId: string, label?: string): TerminalTab =>
  ({ termId, cwd: "/repo", label }) as TerminalTab;
const view = (groupId: string, ...panes: TerminalTab[]): PanelGroupView =>
  ({ groupId, panes, isSplit: panes.length > 1 }) as PanelGroupView;

describe("the panel's tabs", () => {
  const base = {
    setupCommand: null,
    setupRunning: false,
    runCommand: null,
    runRunning: false,
    reserved: [] as Array<string | null>,
    nameFor: (_t: TerminalTab, i: number) => `Terminal ${i + 1}`,
    onClose: () => {},
  };

  test("Setup and Run always lead, even with no script or command", () => {
    const tabs = stripTabs({ ...base, views: [] });
    expect(tabs.map((t) => t.value)).toEqual([SETUP_TAB, RUN_TAB]);
    expect(tabs.map((t) => t.label)).toEqual(["Setup", "Run"]);
    expect(tabs.every((t) => !t.onClose)).toBe(true);
  });

  test("Setup spins while it runs and Run wears its dot while live", () => {
    const tabs = stripTabs({ ...base, setupRunning: true, runRunning: true, views: [] });
    expect(tabs[0].working).toBe(true);
    expect(tabs[1].running).toBe(true);
  });

  test("terminals are numbered and closable; Setup and Run terminals aren't listed twice", () => {
    const closed: string[][] = [];
    const tabs = stripTabs({
      ...base,
      views: [view("g1", term("run")), view("g2", term("a")), view("g3", term("b"), term("c"))],
      reserved: ["run", null],
      onClose: (ids) => closed.push(ids),
    });
    expect(tabs.map((t) => t.label)).toEqual(["Setup", "Run", "Terminal 1", "Terminal 2 +1"]);
    tabs[3].onClose?.();
    expect(closed).toEqual([["b", "c"]]);
  });
});

describe("what Run can start", () => {
  test("the run command first, then the named scripts", () => {
    const tasks = runTasks("bun dev", [{ name: "test", command: "bun test" }]);
    expect(tasks.map((t) => [t.id, t.label, t.command])).toEqual([
      [RUN_TAB, "Run", "bun dev"],
      ["script:test", "test", "bun test"],
    ]);
  });

  test("no run command leaves only the scripts, and nothing at all asks to add one", () => {
    expect(runTasks(null, [{ name: "lint", command: "bun lint" }]).map((t) => t.label)).toEqual(["lint"]);
    expect(runControlsState(false, runTasks(undefined, []))).toEqual({ kind: "idle", main: null });
  });

  test("a live run is a Stop button whatever the tasks are", () => {
    expect(runControlsState(true, runTasks("bun dev", []))).toEqual({ kind: "running" });
  });
});

describe("the header's controls", () => {
  test("a sixth terminal is refused with the cap in the tooltip", () => {
    expect(MAX_TERMINALS).toBe(5);
    expect(newTerminalState(4, MAX_TERMINALS)).toEqual({ disabled: false, hint: "New terminal" });
    expect(newTerminalState(5, MAX_TERMINALS)).toEqual({
      disabled: true,
      hint: "Maximum 5 terminals allowed",
    });
  });

  test("the chevron says what it will do", () => {
    expect(terminalPanelToggleLabel(true)).toBe("Hide terminal panel");
    expect(terminalPanelToggleLabel(false)).toBe("Show terminal panel");
  });
});

describe("the remembered split", () => {
  test("half the column unless something sensible was stored", () => {
    expect(parseScriptsShare(null)).toBe(SCRIPTS_DEFAULT_SHARE);
    expect(parseScriptsShare("nope")).toBe(SCRIPTS_DEFAULT_SHARE);
    expect(parseScriptsShare("0.7")).toBe(0.7);
  });

  test("never under a fifth, never over the whole column", () => {
    expect(parseScriptsShare("0.05")).toBe(SCRIPTS_MIN_SHARE);
    expect(parseScriptsShare("3")).toBe(1);
  });
});

describe("the setup script button", () => {
  test("says what it will do, and what it is doing while pending", () => {
    expect(SETUP_BUTTON_LABELS.run).toEqual({ idle: "Run setup", pending: "Running..." });
    expect(SETUP_BUTTON_LABELS.rerun).toEqual({ idle: "Rerun setup", pending: "Running..." });
    expect(SETUP_BUTTON_LABELS.stop).toEqual({ idle: "Stop setup", pending: "Stopping..." });
  });
});

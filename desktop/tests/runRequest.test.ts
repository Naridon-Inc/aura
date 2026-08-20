// Pressing ⌘R with the terminal panel closed has to still run the project.
//
// `Layout.tsx` renders the bottom pane only while it is open, so the panel —
// the only thing that owns terminals — does not exist at the moment the key is
// pressed. The first version opened the panel and dispatched a window event on
// a `setTimeout(…, 0)`, which is a race: the timer task is queued before React
// commits, while the subscribing effect flushes on React's own scheduler task.
// When the timer won, ⌘R did nothing at all — and "nothing happened" reads as
// Run being broken, not as a missed event.
//
// So the request is held until something claims it. These tests pin the order
// that used to be the bug: request first, listener second.

import { beforeEach, describe, expect, it } from "bun:test";

import {
  claimRunRequest,
  onRunRequested,
  requestRun,
  resetRunRequest,
} from "../src/lib/runRequest";

beforeEach(() => resetRunRequest());

describe("a run requested before anything can hear it", () => {
  it("is delivered to a listener that subscribes afterwards", () => {
    requestRun();

    let ran = 0;
    onRunRequested(() => {
      if (claimRunRequest()) ran++;
    });

    expect(ran).toBe(1);
  });

  it("is claimed exactly once, however many times the panel re-subscribes", () => {
    requestRun();

    let ran = 0;
    const listen = () =>
      onRunRequested(() => {
        if (claimRunRequest()) ran++;
      });

    // TerminalPanel re-binds whenever repoRoot or its deps change. A stale
    // request must not start the dev server again on every re-bind.
    const off = listen();
    off();
    listen();

    expect(ran).toBe(1);
  });

  it("does not run anything when there was no request", () => {
    let ran = 0;
    onRunRequested(() => {
      if (claimRunRequest()) ran++;
    });

    expect(ran).toBe(0);
  });
});

describe("a run requested while the panel is already open", () => {
  it("reaches the live listener immediately", () => {
    let ran = 0;
    onRunRequested(() => {
      if (claimRunRequest()) ran++;
    });

    requestRun();
    expect(ran).toBe(1);

    requestRun();
    expect(ran).toBe(2);
  });

  it("stops reaching a listener that unsubscribed", () => {
    let ran = 0;
    const off = onRunRequested(() => {
      if (claimRunRequest()) ran++;
    });
    off();

    requestRun();
    expect(ran).toBe(0);
    // The request is still outstanding — the panel remounting picks it up.
    expect(claimRunRequest()).toBe(true);
  });

  it("survives a listener that unsubscribes from inside its own callback", () => {
    // The panel's effect cleanup can run while the notify loop is mid-flight;
    // mutating the set during iteration must not skip or throw.
    let ran = 0;
    const off = onRunRequested(() => {
      off();
      if (claimRunRequest()) ran++;
    });

    expect(() => requestRun()).not.toThrow();
    expect(ran).toBe(1);
  });
});

describe("what the app wires up", () => {
  it("has App.tsx request a run rather than time an event at the panel", async () => {
    const { readSrc } = await import("./support/code");
    const src = await readSrc("App.tsx");
    const arm = src.match(/case "run_project": \{[\s\S]*?\n        \}/)?.[0] ?? "";
    expect(arm).toContain("setTerminalPanelOpen(true)");
    expect(arm).toContain("requestRun()");
    // The timer was the bug, not the delivery mechanism.
    expect(arm).not.toContain("setTimeout");
  });

  it("has the panel claim the request on subscribe", async () => {
    const { readSrc } = await import("./support/code");
    const src = await readSrc("components/terminal/TerminalPanel.tsx");
    expect(src).toContain("onRunRequested(() => {");
    expect(src).toContain("if (claimRunRequest()) void handleRun();");
  });
});

// Run — the one command per project that ⌘R starts.
//
// The whole feature turns on refusing to guess. A dev command that is wrong is
// worse than no dev command: it fails in a terminal the app opened, with a
// message about the project, and it reads as the project's fault. So the rules
// this file protects are:
//
//   • what the person pinned beats what we read out of the repo;
//   • "we don't know" is an answer we are allowed to give, and never quietly
//     becomes `npm run dev`;
//   • a remembered Run terminal is a claim about the world, so it is checked
//     against the world before it is believed;
//   • restart closes the old terminal first, so Run never leaves a dev server
//     running behind a tab nobody can see.
//
// Each of those fails silently if it regresses: the wrong command still opens a
// terminal, a stale id still looks like "Run is open", and an orphaned server
// still holds its port while the new one prints EADDRINUSE.

import { describe, expect, it, beforeEach, mock } from "bun:test";

/** The backend's answer for the next detection. */
let detected: { command: string | null; candidates: { command: string; source: string }[] } = {
  command: null,
  candidates: [],
};
/** Every repo root the backend was asked about. */
let asks: string[] = [];
/** Set to make detection fail the way a backend error would. */
let failWith: string | null = null;

mock.module("../src/lib/api", () => ({
  api: {
    runDetect: async (repoRoot: string) => {
      asks.push(repoRoot);
      if (failWith !== null) throw new Error(failWith);
      return detected;
    },
  },
}));

// `runPane` remembers the pin and the Run terminal in localStorage; the test
// runtime has none, so give it the smallest real one rather than mocking the
// module's own storage helpers (which would test the mock, not the code).
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const {
  detectRun,
  focusRun,
  invalidateRunDetection,
  liveRunTermId,
  resolveRunCommand,
  runCommandOverride,
  runProject,
  setRunCommandOverride,
  stopRun,
  RUN_LABEL,
} = await import("../src/lib/runPane");

const REPO = "/tmp/run-pane-repo";
const OTHER = "/tmp/other-repo";

/** A fake panel: records what Run asked it to do, and answers `terminals`
 *  the way the store would after each call. */
function panel(initial: { termId: string; cwd: string }[] = []) {
  const terminals = [...initial];
  const opened: { cwd: string; bootCommand?: string; label?: string }[] = [];
  const closed: string[] = [];
  const selected: string[] = [];
  let next = 1;
  return {
    terminals,
    opened,
    closed,
    selected,
    openPanelTerminal(cwd: string, opts?: { bootCommand?: string; label?: string }) {
      opened.push({ cwd, ...opts });
      const termId = `term-${next++}`;
      terminals.push({ termId, cwd });
      return termId;
    },
    selectPanelTerminal(termId: string) {
      selected.push(termId);
    },
    closeTerminal(termId: string) {
      closed.push(termId);
      const i = terminals.findIndex((t) => t.termId === termId);
      if (i >= 0) terminals.splice(i, 1);
    },
  };
}

beforeEach(() => {
  asks = [];
  failWith = null;
  detected = { command: null, candidates: [] };
  store.clear();
  invalidateRunDetection();
});

describe("what Run will actually run", () => {
  it("gives back nothing when the project said nothing", async () => {
    expect(await resolveRunCommand(REPO)).toBe(null);
  });

  it("never invents a command when detection fails", async () => {
    failWith = "backend exploded";
    expect(await resolveRunCommand(REPO)).toBe(null);
  });

  it("uses what the repo justified", async () => {
    detected = {
      command: "bun run dev",
      candidates: [{ command: "bun run dev", source: "package.json" }],
    };
    expect(await resolveRunCommand(REPO)).toBe("bun run dev");
  });

  it("prefers the command the person pinned over the one we read", async () => {
    detected = {
      command: "npm run start",
      candidates: [{ command: "npm run start", source: "package.json" }],
    };
    setRunCommandOverride(REPO, "make serve");
    expect(await resolveRunCommand(REPO)).toBe("make serve");
  });

  it("falls back to the repo when the pin is cleared", async () => {
    detected = {
      command: "npm run start",
      candidates: [{ command: "npm run start", source: "package.json" }],
    };
    setRunCommandOverride(REPO, "make serve");
    setRunCommandOverride(REPO, null);
    expect(runCommandOverride(REPO)).toBe(null);
    expect(await resolveRunCommand(REPO)).toBe("npm run start");
  });

  it("treats a pin of only whitespace as no pin at all", async () => {
    setRunCommandOverride(REPO, "   ");
    expect(runCommandOverride(REPO)).toBe(null);
  });

  it("keeps each project's pin to itself", async () => {
    setRunCommandOverride(REPO, "make serve");
    expect(runCommandOverride(OTHER)).toBe(null);
  });

  it("reads the backend once for repeated asks, and again after invalidating", async () => {
    detected = { command: "npm run dev", candidates: [] };
    await detectRun(REPO);
    await detectRun(REPO);
    expect(asks.length).toBe(1);
    invalidateRunDetection();
    await detectRun(REPO);
    expect(asks.length).toBe(2);
  });
});

describe("the terminal Run remembers", () => {
  it("is nothing at all until something runs", () => {
    const p = panel();
    expect(liveRunTermId(REPO, p)).toBe(null);
  });

  it("forgets a remembered terminal that no longer exists", async () => {
    detected = { command: "npm run dev", candidates: [] };
    const p = panel();
    const out = await runProject(REPO, p);
    expect(out.ok).toBe(true);

    // The tab is closed from the toolbar, not through Run.
    p.terminals.length = 0;
    expect(liveRunTermId(REPO, p)).toBe(null);
    // …and the stale pointer is gone, not just ignored this once.
    expect(store.has(`aura.run.term:${REPO}`)).toBe(false);
  });

  it("does not claim another project's terminal", async () => {
    detected = { command: "npm run dev", candidates: [] };
    const p = panel();
    const out = await runProject(REPO, p);
    expect(out.ok).toBe(true);

    // Same id, different project — a reopened workspace can do this.
    p.terminals[0].cwd = OTHER;
    expect(liveRunTermId(REPO, p)).toBe(null);
  });
});

describe("running, restarting and stopping", () => {
  it("refuses to run when nothing justified a command", async () => {
    const p = panel();
    const out = await runProject(REPO, p);
    expect(out).toEqual({ ok: false, reason: "no-command" });
    expect(p.opened.length).toBe(0);
  });

  it("opens one labelled terminal that boots the command, and focuses it", async () => {
    detected = {
      command: "bun run dev",
      candidates: [{ command: "bun run dev", source: "package.json" }],
    };
    const p = panel();
    const out = await runProject(REPO, p);

    expect(out.ok).toBe(true);
    expect(p.opened).toEqual([
      { cwd: REPO, bootCommand: "bun run dev", label: RUN_LABEL },
    ]);
    expect(p.selected).toEqual([out.ok ? out.termId : ""]);
    expect(out.ok && out.restarted).toBe(false);
  });

  it("closes the old terminal before opening the new one on restart", async () => {
    detected = { command: "npm run dev", candidates: [] };
    const p = panel();
    const first = await runProject(REPO, p);
    const second = await runProject(REPO, p);

    expect(first.ok && second.ok).toBe(true);
    expect(p.closed).toEqual([first.ok ? first.termId : ""]);
    expect(p.opened.length).toBe(2);
    expect(second.ok && second.restarted).toBe(true);
    // One Run, not two: the old tab is gone from the panel.
    expect(p.terminals.length).toBe(1);
  });

  it("runs the pinned command rather than the detected one", async () => {
    detected = {
      command: "npm run start",
      candidates: [{ command: "npm run start", source: "package.json" }],
    };
    setRunCommandOverride(REPO, "make serve");
    const p = panel();
    await runProject(REPO, p);
    expect(p.opened[0].bootCommand).toBe("make serve");
  });

  it("stops what is running and forgets it", async () => {
    detected = { command: "npm run dev", candidates: [] };
    const p = panel();
    const out = await runProject(REPO, p);
    expect(stopRun(REPO, p)).toBe(true);
    expect(p.closed).toEqual([out.ok ? out.termId : ""]);
    expect(liveRunTermId(REPO, p)).toBe(null);
  });

  it("is safe to stop twice", async () => {
    detected = { command: "npm run dev", candidates: [] };
    const p = panel();
    await runProject(REPO, p);
    expect(stopRun(REPO, p)).toBe(true);
    expect(stopRun(REPO, p)).toBe(false);
    expect(p.closed.length).toBe(1);
  });

  it("focuses without restarting, and says so when there is nothing to focus", async () => {
    detected = { command: "npm run dev", candidates: [] };
    const p = panel();
    const out = await runProject(REPO, p);
    p.selected.length = 0;

    expect(focusRun(REPO, p)).toBe(true);
    expect(p.selected).toEqual([out.ok ? out.termId : ""]);
    expect(p.opened.length).toBe(1); // focusing is not running
    expect(p.closed.length).toBe(0);

    stopRun(REPO, p);
    expect(focusRun(REPO, p)).toBe(false);
  });
});

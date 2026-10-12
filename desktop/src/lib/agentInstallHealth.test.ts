// What these pin: the verdict that decides whether an agent pane grows a row.
//
// The expensive half — spawning every copy of every agent binary to ask its
// version — already has its tests in Rust. What is tested here is the reading
// of that answer, and the one case it used to get wrong: an install that is
// only off PATH is not `stale`, because nothing runs to be out of date, and a
// surface that gates on `stale` therefore says nothing about an agent that
// cannot start at all.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { AgentInstall, AgentInstallHealth } from "./api";
import {
  dismissNudge,
  installNudge,
  isDismissed,
  subscribeInstallHealth,
  tildePath,
} from "./agentInstallHealth";

function copy(path: string, version: string | null, onPath: boolean): AgentInstall {
  return { path, raw_version: version, version, on_path: onPath };
}

function health(over: Partial<AgentInstallHealth>): AgentInstallHealth {
  return {
    agent_id: "codex",
    bin: "codex",
    running: null,
    shadowed: [],
    stale: false,
    newest_version: null,
    ...over,
  };
}

function installStorage() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("which installs are worth a row", () => {
  it("says nothing about the ordinary case", () => {
    const n = installNudge(
      health({ running: copy("/usr/local/bin/codex", "0.161.0", true), newest_version: "0.161.0" }),
    );
    expect(n).toBeNull();
  });

  it("names the newer copy that PATH is walking past", () => {
    const n = installNudge(
      health({
        running: copy("/opt/homebrew/bin/codex", "0.155.1", true),
        shadowed: [copy("/Users/x/.bun/bin/codex", "0.161.0", false)],
        stale: true,
        newest_version: "0.161.0",
      }),
    );
    expect(n?.trouble).toBe("shadowed-newer");
    expect(n?.line).toContain("0.155.1");
    expect(n?.line).toContain("0.161.0");
    expect(n?.other.path).toBe("/Users/x/.bun/bin/codex");
  });

  // The defect this module exists to close. `stale` is false here — correctly,
  // since no copy runs — so every surface that gated on `stale` stayed silent
  // about an agent that was installed and unlaunchable at the same time.
  it("still speaks when the only copy is somewhere PATH never looks", () => {
    const n = installNudge(
      health({
        agent_id: "kimi",
        bin: "kimi",
        running: null,
        shadowed: [copy("/Users/x/.hermes/node/bin/kimi", "1.0.0", false)],
        stale: false,
        newest_version: "1.0.0",
      }),
    );
    expect(n?.trouble).toBe("off-path-only");
    expect(n?.line).toContain("~/.hermes/node/bin/kimi");
    expect(n?.running).toBeNull();
  });

  it("says nothing when the agent is simply not installed", () => {
    expect(installNudge(health({ agent_id: "pi", bin: "pi" }))).toBeNull();
  });

  // A shadow whose version could not be read cannot be pointed at as "the
  // newer one", and the Rust side already refuses to call that stale. Reading
  // it as a nudge anyway would print "update to undefined".
  it("needs a version it can name before it blames a shadow", () => {
    const n = installNudge(
      health({
        running: copy("/usr/local/bin/codex", "0.155.1", true),
        shadowed: [copy("/Users/x/.bun/bin/codex", null, false)],
        stale: false,
        newest_version: "0.155.1",
      }),
    );
    expect(n).toBeNull();
  });
});

describe("dismissing one", () => {
  const stale = health({
    running: copy("/opt/homebrew/bin/codex", "0.155.1", true),
    shadowed: [copy("/Users/x/.bun/bin/codex", "0.161.0", false)],
    stale: true,
    newest_version: "0.161.0",
  });

  it("remembers the exact situation, not the agent", () => {
    const first = installNudge(stale)!;
    dismissNudge(first.signature);
    expect(isDismissed(first.signature)).toBe(true);

    // The next version lands and the nag resumes with new numbers. That is a
    // new fact, so it is not covered by the old dismissal.
    const later = installNudge(
      health({
        running: copy("/opt/homebrew/bin/codex", "0.155.1", true),
        shadowed: [copy("/Users/x/.bun/bin/codex", "0.170.0", false)],
        stale: true,
        newest_version: "0.170.0",
      }),
    )!;
    expect(isDismissed(later.signature)).toBe(false);
  });

  // The bug this pair caught: the signature reached storage and the
  // subscribers were told, but the shared snapshot was the same object, so
  // `useSyncExternalStore` was entitled to skip the re-render — and did. The
  // row stayed on screen in the very pane it had just been dismissed from,
  // and only a remount cleared it.
  it("takes effect where it was clicked, not on the next mount", () => {
    const n = installNudge(stale)!;
    let told = 0;
    const stop = subscribeInstallHealth(() => (told += 1));
    dismissNudge(n.signature);
    stop();
    expect(told).toBe(1);
    expect(isDismissed(n.signature)).toBe(true);
  });

  it("survives no storage at all rather than throwing in the render path", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => dismissNudge("unstorable")).not.toThrow();
    // It still holds for this session — the row goes away now and comes back
    // on the next launch, which beats a click that visibly does nothing.
    expect(isDismissed("unstorable")).toBe(true);
  });
});

describe("paths as a person reads them", () => {
  it("shortens a home path and leaves the rest alone", () => {
    expect(tildePath("/Users/muhammed/.bun/bin/codex")).toBe("~/.bun/bin/codex");
    expect(tildePath("/home/ci/.local/bin/codex")).toBe("~/.local/bin/codex");
    expect(tildePath("/opt/homebrew/bin/codex")).toBe("/opt/homebrew/bin/codex");
  });
});

// A running agent must never be drawn as a paused one.
//
// `dormant` is stamped on every agent tab that comes back through a workspace
// snapshot (`markAgentDormant`), because the usual reason a snapshot is being
// read is that the shell restarted and the PTY children died with it. Aura
// deliberately does not relaunch those — you get a Start button instead.
//
// The same rehydrate runs on an ordinary worktree switch, where the children
// are still running. So switching marrakesh → granada → marrakesh handed a
// live Claude Code session back with the paused pane over it, offering to
// start an agent that had never stopped. The flag was an assumption; the PTY
// is the fact, and nothing was asking the PTY.
//
// Scanned rather than rendered: the bug is in which signal the surface trusts.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const surface = await readSrc("components/agent/AgentSurface.tsx");
const store = await readSrc("lib/editorStore.ts");

describe("a dormant tab whose PTY answers", () => {
  it("asks the process instead of trusting the restore-time flag", () => {
    // The probe must be gated on `dormant` being set — that is the only case
    // where the flag could be wrong in the direction that hurts.
    expect(surface).toContain("if (!tab.dormant) return;");
    expect(surface).toMatch(
      /if \(!cancelled && alive\) store\.markAgentLive\(tab\.sessionId\)/,
    );
  });

  it("keeps the tab cold when the daemon can't be reached", () => {
    // A wrong "it's alive" strands the user on a dead terminal with no way
    // back. Silence must not be read as life: the probe's failure path has to
    // fall through to the existing cold behaviour, and the flag may only be
    // cleared on an affirmative answer — so there is exactly one call site,
    // and it sits behind `alive`.
    const probe = surface.slice(
      surface.indexOf("if (!tab.dormant) return;"),
      surface.indexOf("if (tab.dormant) return;"),
    );
    expect(probe).toContain("catch");
    expect(probe.match(/markAgentLive\(/g)).toHaveLength(1);
  });

  it("clears the flag in the store rather than shadowing it in the view", () => {
    // A local `useState` override would be lost on the next rehydrate and
    // would not reach the other reader (`paused` pins the view to terminal).
    expect(store).toContain("function markAgentLive(sessionId: string)");
    expect(store).toContain("dormant: undefined");
  });

  it("is a no-op for a tab that is already live", () => {
    const body = store.slice(store.indexOf("function markAgentLive"));
    expect(body.slice(0, 300)).toContain("!state.agentTabs[idx].dormant) return");
  });

  it("still refuses to auto-respawn a genuinely cold tab", () => {
    // The whole point of `dormant` — never relaunch a Claude process the user
    // did not ask for — has to survive this change.
    expect(surface).toContain("if (tab.dormant) return;");
  });
});

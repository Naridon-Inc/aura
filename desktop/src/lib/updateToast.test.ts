// What these pin: "Later" quiets one version for a day and no other; the toast
// shows only when there's an update, and a check the person asked for always
// shows it; the line under the title comes from the release's notes; and
// "Restart when idle" waits for every agent and terminal to stop, and for the
// quiet to hold, before it restarts.

import { describe, expect, it } from "bun:test";

import {
  busyTerminals,
  IDLE_SETTLE_MS,
  IDLE_WAIT_START,
  isSnoozed,
  PTY_QUIET_MS,
  releaseHeadline,
  releaseNotesUrl,
  shouldShowUpdateToast,
  SNOOZE_KEY,
  SNOOZE_MS,
  snoozeVersion,
  stepIdleWait,
  updateOffer,
  type IdleWait,
  type SnoozeStore,
} from "./updateToast";
import { TURN_QUIET_MS } from "./agentTurnState";

function memory(): SnoozeStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

const NOW = 1_800_000_000_000;

describe("snooze is per version", () => {
  it("quiets the version that was put off, for a day", () => {
    const s = memory();
    snoozeVersion("0.20.1", NOW, s);
    expect(isSnoozed("0.20.1", NOW, s)).toBe(true);
    expect(isSnoozed("0.20.1", NOW + SNOOZE_MS - 1, s)).toBe(true);
    expect(isSnoozed("0.20.1", NOW + SNOOZE_MS, s)).toBe(false);
  });

  it("never quiets a different, newer release", () => {
    const s = memory();
    snoozeVersion("0.20.1", NOW, s);
    expect(isSnoozed("0.20.2", NOW, s)).toBe(false);
  });

  it("keeps one record: snoozing a newer version replaces the older", () => {
    const s = memory();
    snoozeVersion("0.20.1", NOW, s);
    snoozeVersion("0.20.2", NOW, s);
    expect(isSnoozed("0.20.2", NOW, s)).toBe(true);
    expect(isSnoozed("0.20.1", NOW, s)).toBe(false);
  });

  it("treats v0.20.1 and 0.20.1 as the same release", () => {
    const s = memory();
    snoozeVersion("v0.20.1", NOW, s);
    expect(isSnoozed("0.20.1", NOW, s)).toBe(true);
  });

  it("reads missing, malformed or unavailable storage as not snoozed", () => {
    expect(isSnoozed("0.20.1", NOW, null)).toBe(false);
    expect(isSnoozed("0.20.1", NOW, memory())).toBe(false);
    const bad = memory();
    bad.map.set(SNOOZE_KEY, "{not json");
    expect(isSnoozed("0.20.1", NOW, bad)).toBe(false);
    const throws: SnoozeStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => snoozeVersion("0.20.1", NOW, throws)).not.toThrow();
    expect(isSnoozed("0.20.1", NOW, throws)).toBe(false);
  });
});

describe("shouldShowUpdateToast", () => {
  it("shows only when an update exists", () => {
    expect(shouldShowUpdateToast({ version: null, snoozed: false, manual: false })).toBe(false);
    expect(shouldShowUpdateToast({ version: undefined, snoozed: false, manual: true })).toBe(false);
    expect(shouldShowUpdateToast({ version: "", snoozed: false, manual: true })).toBe(false);
    expect(shouldShowUpdateToast({ version: "0.20.1", snoozed: false, manual: false })).toBe(true);
  });

  it("stays quiet for a snoozed version on its own checks", () => {
    expect(shouldShowUpdateToast({ version: "0.20.1", snoozed: true, manual: false })).toBe(false);
  });

  it("shows a snoozed version when the person checks", () => {
    expect(shouldShowUpdateToast({ version: "0.20.1", snoozed: true, manual: true })).toBe(true);
  });
});

describe("what the toast says", () => {
  it("leads with the first line of the notes, markdown stripped", () => {
    expect(releaseHeadline("0.20.1", "## **Faster** chat saves\n\n- more")).toBe("Faster chat saves");
    expect(releaseHeadline("0.20.1", "\n\n- `aura` stays in step\n")).toBe("aura stays in step");
  });

  it("falls back to the version when there are no notes", () => {
    expect(releaseHeadline("v0.20.1", null)).toBe("Aura 0.20.1");
    expect(releaseHeadline("0.20.1", "  \n ")).toBe("Aura 0.20.1");
  });

  it("links See changes to that release's changelog page", () => {
    expect(releaseNotesUrl("v0.20.1")).toBe("https://auravcs.com/changelog/0.20.1");
  });
});

describe("busyTerminals", () => {
  it("counts only terminals that printed inside the quiet window", () => {
    expect(busyTerminals([0, PTY_QUIET_MS - 1, PTY_QUIET_MS, 60_000])).toBe(2);
  });

  it("does not count a session it has no reading for", () => {
    expect(busyTerminals([null, undefined, null])).toBe(0);
  });

  it("uses the same quiet window as the turn tracker", () => {
    expect(PTY_QUIET_MS).toBe(TURN_QUIET_MS);
  });
});

describe("updateOffer", () => {
  it("offers Restart when idle only while something is working", () => {
    expect(updateOffer({ busy: false, waiting: false })).toBe("offer");
    expect(updateOffer({ busy: true, waiting: false })).toBe("offer-idle");
  });

  it("shows the wait, whatever the fleet is doing, once it is set", () => {
    expect(updateOffer({ busy: true, waiting: true })).toBe("waiting");
    expect(updateOffer({ busy: false, waiting: true })).toBe("waiting");
  });
});

describe("stepIdleWait", () => {
  /** Feed a run of (time, busy) looks through the wait; the time it fired. */
  function run(looks: Array<[number, boolean]>): number | null {
    let wait: IdleWait = IDLE_WAIT_START;
    for (const [now, busy] of looks) {
      const step = stepIdleWait(wait, busy, now);
      wait = step.wait;
      if (step.fire) return now;
    }
    return null;
  }

  it("never fires while anything is working", () => {
    expect(run([[0, true], [10_000, true], [60_000, true]])).toBeNull();
  });

  it("fires once idle has held for the settle time", () => {
    expect(run([[0, true], [1_000, false], [3_000, false], [1_000 + IDLE_SETTLE_MS, false]])).toBe(
      1_000 + IDLE_SETTLE_MS,
    );
  });

  it("starts the clock over when work comes back between turns", () => {
    // Idle at 1s, a queued turn starts at 4s, idle again at 5s: the restart
    // waits the whole settle time from 5s, not from 1s.
    const fired = run([
      [1_000, false],
      [4_000, true],
      [5_000, false],
      [1_000 + IDLE_SETTLE_MS, false],
      [5_000 + IDLE_SETTLE_MS, false],
    ]);
    expect(fired).toBe(5_000 + IDLE_SETTLE_MS);
  });

  it("fires on the first look when nothing needs to settle", () => {
    expect(stepIdleWait(IDLE_WAIT_START, false, 42, 0)).toEqual({
      wait: { idleSince: 42 },
      fire: true,
    });
  });
});

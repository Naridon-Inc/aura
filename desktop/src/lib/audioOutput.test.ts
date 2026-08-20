import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  OUTPUT_IDLE_GRACE_MS,
  __resetOutputContextForTests,
  acquireOutputContext,
  outputContextState,
  playOutputSound,
  releaseOutputContextAfter,
  releaseOutputContextNow,
} from "./audioOutput";

// These cases pin the other half of the AirPods rule: Aura may borrow the
// audio OUTPUT device to make a sound, but it hands it straight back. A
// context left in `running` keeps a CoreAudio output unit open for the life of
// the app, which is what makes macOS keep yanking connected AirPods off the
// user's phone and onto the Mac.

class FakeAudioContext {
  static built = 0;
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  constructor() {
    FakeAudioContext.built += 1;
  }
  async resume(): Promise<void> {
    this.state = "running";
  }
  async suspend(): Promise<void> {
    this.state = "suspended";
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  FakeAudioContext.built = 0;
  (globalThis as { window?: unknown }).window = {
    AudioContext: FakeAudioContext as unknown as typeof AudioContext,
  };
  __resetOutputContextForTests();
});

afterEach(() => {
  __resetOutputContextForTests();
  delete (globalThis as { window?: unknown }).window;
});

describe("the output device is not held until a sound plays", () => {
  test("importing the module builds no context", () => {
    expect(outputContextState()).toBe("none");
    expect(FakeAudioContext.built).toBe(0);
  });

  test("playing a sound builds exactly one running context", () => {
    expect(playOutputSound((_ac, now) => now + 0.1)).toBe(true);
    expect(FakeAudioContext.built).toBe(1);
    expect(outputContextState()).toBe("running");
  });

  test("a second sound reuses the same context", () => {
    playOutputSound((_ac, now) => now + 0.05);
    playOutputSound((_ac, now) => now + 0.05);
    expect(FakeAudioContext.built).toBe(1);
  });

  test("no context at all when Web Audio is unavailable", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(playOutputSound((_ac, now) => now)).toBe(false);
    expect(acquireOutputContext()).toBeNull();
    expect(outputContextState()).toBe("none");
  });
});

describe("the output device is handed back once the sound has decayed", () => {
  test("a short sound suspends the context after its tail plus the grace", async () => {
    playOutputSound((_ac, now) => now + 0.02);
    expect(outputContextState()).toBe("running");
    await sleep(OUTPUT_IDLE_GRACE_MS + 200);
    expect(outputContextState()).toBe("suspended");
  });

  test("the next sound resumes the same context rather than building a new one", async () => {
    playOutputSound((_ac, now) => now + 0.02);
    await sleep(OUTPUT_IDLE_GRACE_MS + 200);
    expect(outputContextState()).toBe("suspended");
    playOutputSound((_ac, now) => now + 0.02);
    expect(outputContextState()).toBe("running");
    expect(FakeAudioContext.built).toBe(1);
  });

  test("a schedule that throws still arms a release", async () => {
    expect(
      playOutputSound(() => {
        throw new Error("bad graph");
      }),
    ).toBe(false);
    await sleep(OUTPUT_IDLE_GRACE_MS + 200);
    expect(outputContextState()).toBe("suspended");
  });

  test("releaseOutputContextNow suspends immediately", () => {
    playOutputSound((_ac, now) => now + 5);
    expect(outputContextState()).toBe("running");
    releaseOutputContextNow();
    expect(outputContextState()).toBe("suspended");
  });
});

describe("overlapping sounds share one hold", () => {
  test("a short sound cannot cut a long one short", async () => {
    // A soundboard clip holds for its whole length; a terminal bell landing on
    // top of it must not suspend the context out from under the clip.
    releaseOutputContextAfter(OUTPUT_IDLE_GRACE_MS + 700);
    acquireOutputContext();
    playOutputSound((_ac, now) => now + 0.01);
    await sleep(OUTPUT_IDLE_GRACE_MS + 200);
    expect(outputContextState()).toBe("running");
    await sleep(700);
    expect(outputContextState()).toBe("suspended");
  });

  test("a later sound extends the hold past the earlier one's deadline", async () => {
    playOutputSound((_ac, now) => now + 0.01);
    await sleep(OUTPUT_IDLE_GRACE_MS / 2);
    playOutputSound((_ac, now) => now + 0.5);
    await sleep(OUTPUT_IDLE_GRACE_MS);
    expect(outputContextState()).toBe("running");
    await sleep(500 + OUTPUT_IDLE_GRACE_MS + 200);
    expect(outputContextState()).toBe("suspended");
  });
});

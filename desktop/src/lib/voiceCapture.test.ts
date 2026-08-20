import { describe, expect, test } from "bun:test";

import {
  createVoiceCapture,
  type VoiceCaptureRecorder,
  type VoiceCaptureSession,
  type VoiceCaptureTrack,
} from "./voiceCapture";

// These cases pin one product rule: Aura never holds the microphone unless the
// user asked it to, and never keeps holding it afterwards. On macOS a live
// input track drags connected AirPods into the handsfree profile and hands the
// Mac ownership of them, so a capture that leaks is a capture that makes the
// user's headphones bounce between their laptop and their phone.

type FakeTrack = VoiceCaptureTrack & { stopped: boolean };

function fakeTrack(): FakeTrack {
  return {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
}

type FakeRig = {
  session: VoiceCaptureSession;
  tracks: FakeTrack[];
  recorder: VoiceCaptureRecorder & {
    state: "inactive" | "recording" | "paused";
    started: boolean;
  };
  /** Fire what a real MediaRecorder fires once `stop()` has settled. */
  settleStop(): void;
};

function fakeRig(trackCount = 2): FakeRig {
  const tracks = Array.from({ length: trackCount }, () => fakeTrack());
  const recorder = {
    state: "inactive" as "inactive" | "recording" | "paused",
    mimeType: "audio/webm;codecs=opus",
    started: false,
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    start() {
      recorder.started = true;
      recorder.state = "recording";
    },
    stop() {
      recorder.state = "inactive";
    },
    pause() {
      recorder.state = "paused";
    },
    resume() {
      recorder.state = "recording";
    },
  };
  return {
    tracks,
    recorder,
    session: { stream: { getTracks: () => tracks }, recorder },
    settleStop: () => recorder.onstop?.(),
  };
}

describe("the microphone is not opened until the user starts a recording", () => {
  test("building a capture asks for nothing", () => {
    let opens = 0;
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: () => {},
      open: async () => {
        opens += 1;
        return fakeRig().session;
      },
    });
    expect(opens).toBe(0);
    expect(capture.state()).toBe("idle");
    expect(capture.microphoneIsOpen()).toBe(false);
  });

  test("start() is the only thing that opens the device", async () => {
    const rig = fakeRig();
    let opens = 0;
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: () => {},
      open: async () => {
        opens += 1;
        return rig.session;
      },
    });
    await capture.start();
    expect(opens).toBe(1);
    expect(capture.state()).toBe("recording");
    expect(rig.recorder.started).toBe(true);
    expect(capture.microphoneIsOpen()).toBe(true);
  });

  test("a second start() while recording does not open a second device", async () => {
    const rig = fakeRig();
    let opens = 0;
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: () => {},
      open: async () => {
        opens += 1;
        return rig.session;
      },
    });
    await capture.start();
    await capture.start();
    expect(opens).toBe(1);
  });
});

describe("every track is stopped on every exit path", () => {
  test("dispose() releases the device", async () => {
    const rig = fakeRig();
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: () => {},
      open: async () => rig.session,
    });
    await capture.start();
    capture.dispose();
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
    expect(capture.microphoneIsOpen()).toBe(false);
    expect(capture.state()).toBe("closed");
  });

  test("dispose() before getUserMedia resolves still stops the stream it lands with", async () => {
    // The regression this whole module was written for: the recorder unmounts
    // while the permission prompt is up, the promise resolves into nothing,
    // and the input stays open for the rest of the session.
    const rig = fakeRig();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: () => {},
      open: async () => {
        await gate;
        return rig.session;
      },
    });
    const started = capture.start();
    capture.dispose();
    expect(rig.tracks.some((t) => t.stopped)).toBe(false); // nothing yet — it hasn't landed
    release?.();
    await started;
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
    expect(capture.microphoneIsOpen()).toBe(false);
    expect(rig.recorder.started).toBe(false);
  });

  test("cancel() releases the device and delivers nothing", async () => {
    const rig = fakeRig();
    let finished = 0;
    const capture = createVoiceCapture({
      onFinished: () => {
        finished += 1;
      },
      onError: () => {},
      open: async () => rig.session,
    });
    await capture.start();
    capture.cancel();
    rig.settleStop();
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
    expect(finished).toBe(0);
  });

  test("finish() releases the device and hands back what was recorded", async () => {
    const rig = fakeRig();
    let got: { size: number; type: string } | null = null;
    const capture = createVoiceCapture({
      onFinished: (blob, mimeType) => {
        got = { size: blob.size, type: mimeType };
      },
      onError: () => {},
      open: async () => rig.session,
    });
    await capture.start();
    rig.recorder.ondataavailable?.({ data: new Blob(["abcd"]) });
    rig.recorder.ondataavailable?.({ data: new Blob(["efg"]) });
    capture.finish();
    rig.settleStop();
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
    expect(capture.microphoneIsOpen()).toBe(false);
    expect(got).not.toBeNull();
    expect(got!.size).toBe(7);
    expect(got!.type).toBe("audio/webm;codecs=opus");
  });

  test("a zero-size chunk is not collected", async () => {
    const rig = fakeRig();
    let size = -1;
    const capture = createVoiceCapture({
      onFinished: (blob) => {
        size = blob.size;
      },
      onError: () => {},
      open: async () => rig.session,
    });
    await capture.start();
    rig.recorder.ondataavailable?.({ data: new Blob([]) });
    capture.finish();
    rig.settleStop();
    expect(size).toBe(0);
  });

  test("a refused microphone leaves nothing open and reports the refusal", async () => {
    let message: string | null = null;
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: (m) => {
        message = m;
      },
      open: async () => {
        throw new Error("NotAllowedError");
      },
    });
    await capture.start();
    expect(capture.microphoneIsOpen()).toBe(false);
    expect(capture.state()).toBe("closed");
    expect(message).toBe("Microphone access is required to record a voice note.");
  });

  test("a recorder that refuses to start still releases the device", async () => {
    const rig = fakeRig();
    rig.recorder.start = () => {
      throw new Error("recorder unavailable");
    };
    let message: string | null = null;
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: (m) => {
        message = m;
      },
      open: async () => rig.session,
    });
    await capture.start();
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
    expect(message).toBe("recorder unavailable");
  });

  test("dispose() after finish() is a no-op, not a second delivery", async () => {
    const rig = fakeRig();
    let finished = 0;
    const capture = createVoiceCapture({
      onFinished: () => {
        finished += 1;
      },
      onError: () => {},
      open: async () => rig.session,
    });
    await capture.start();
    capture.finish();
    rig.settleStop();
    capture.dispose();
    expect(finished).toBe(1);
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
  });

  test("dispose() between finish() and the recorder settling drops the result", async () => {
    // Unmount wins over delivery: nothing should be uploaded on behalf of a
    // surface that is already gone, and the device must still be released.
    const rig = fakeRig();
    let finished = 0;
    const capture = createVoiceCapture({
      onFinished: () => {
        finished += 1;
      },
      onError: () => {},
      open: async () => rig.session,
    });
    await capture.start();
    capture.finish();
    capture.dispose();
    rig.settleStop();
    expect(finished).toBe(0);
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
  });
});

describe("pause and resume never re-open the device", () => {
  test("pausing keeps the same stream and resumes back to recording", async () => {
    const rig = fakeRig();
    let opens = 0;
    const capture = createVoiceCapture({
      onFinished: () => {},
      onError: () => {},
      open: async () => {
        opens += 1;
        return rig.session;
      },
    });
    await capture.start();
    capture.pause();
    expect(capture.state()).toBe("paused");
    capture.resume();
    expect(capture.state()).toBe("recording");
    expect(opens).toBe(1);
    expect(rig.tracks.some((t) => t.stopped)).toBe(false);
    capture.dispose();
    expect(rig.tracks.every((t) => t.stopped)).toBe(true);
  });
});

// The one place in Aura that opens the microphone for a recording.
//
// ## The rules this module exists to keep
//
//  1. **Constructing a capture does not touch the microphone.** Nothing is
//     requested until `start()` is called, and `start()` is only ever reached
//     from an explicit user action — the composer's record button. No mount,
//     no poll, no speculative device enumeration.
//
//  2. **Every track is stopped on every exit path.** Finish, cancel, error,
//     unmount — and, the case that used to leak, unmount *while getUserMedia
//     is still in flight*. A `MediaStream` nobody holds a reference to still
//     owns the input device: only `track.stop()` releases it, and a merely
//     muted track releases nothing at all.
//
// Why that matters beyond tidiness: an open input on macOS drags connected
// AirPods out of A2DP into the handsfree profile and hands the Mac ownership
// of them, so a leaked capture leaves the user's AirPods pinned to the laptop
// and fighting their phone for as long as the app is running.
//
// The device plumbing is behind one injection seam (`open`) so the state
// machine above it can be tested without a browser, a permission prompt, or
// a physical microphone.

/** Just enough of `MediaStreamTrack` to release it. A real one satisfies
 *  this structurally. */
export type VoiceCaptureTrack = {
  stop(): void;
};

/** Just enough of `MediaStream` to enumerate what has to be released. */
export type VoiceCaptureStream = {
  getTracks(): VoiceCaptureTrack[];
};

/** Just enough of `MediaRecorder` to drive one recording. The browser
 *  implementation is adapted onto this in `openBrowserMicrophone` rather than
 *  being used directly, so tests can supply a plain object. */
export type VoiceCaptureRecorder = {
  readonly state: "inactive" | "recording" | "paused";
  readonly mimeType: string;
  start(timesliceMs?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
};

/** A live microphone plus the recorder wired to it. */
export type VoiceCaptureSession = {
  stream: VoiceCaptureStream;
  recorder: VoiceCaptureRecorder;
};

/** The device seam. The default opens the real microphone; tests pass a fake. */
export type OpenMicrophone = () => Promise<VoiceCaptureSession>;

export type VoiceCaptureState =
  | "idle"
  | "opening"
  | "recording"
  | "paused"
  | "stopping"
  | "closed";

export type VoiceCaptureOptions = {
  /** Fires once, after `finish()`, with everything the recorder produced.
   *  Never fires for `cancel()` or `dispose()`. */
  onFinished: (blob: Blob, mimeType: string) => void;
  /** The microphone could not be opened, or the recorder refused to start. */
  onError: (message: string) => void;
  /** Injection seam — defaults to `openBrowserMicrophone`. */
  open?: OpenMicrophone;
};

export type VoiceCapture = {
  /** Open the microphone and begin recording. Safe to call once; later calls
   *  while a recording is live are ignored. */
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Stop and hand the bytes to `onFinished`. */
  finish(): void;
  /** Stop and throw the bytes away. */
  cancel(): void;
  /** Unconditional teardown. Idempotent, and safe to call at any point —
   *  including before `start()` has resolved, in which case the stream is
   *  released the moment it lands. */
  dispose(): void;
  state(): VoiceCaptureState;
  /** True only while Aura is holding the input device. */
  microphoneIsOpen(): boolean;
};

/** How often the recorder flushes a chunk. Small enough that a cancel loses
 *  nothing visible, large enough not to churn. */
const CHUNK_MS = 250;

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true },
};

const MIC_DENIED =
  "Microphone access is required to record a voice note.";

function stopEveryTrack(stream: VoiceCaptureStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* the device is already gone — that is the state we wanted anyway */
    }
  }
}

/** The real device path: getUserMedia + MediaRecorder, adapted onto the
 *  structural types above so the state machine never touches DOM classes. */
export async function openBrowserMicrophone(): Promise<VoiceCaptureSession> {
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const native = new MediaRecorder(stream, { mimeType: preferred });
  const recorder: VoiceCaptureRecorder = {
    get state() {
      return native.state;
    },
    get mimeType() {
      return native.mimeType || preferred;
    },
    ondataavailable: null,
    onstop: null,
    start: (timesliceMs?: number) => native.start(timesliceMs),
    stop: () => native.stop(),
    pause: () => native.pause(),
    resume: () => native.resume(),
  };
  native.ondataavailable = (event) => {
    recorder.ondataavailable?.({ data: event.data });
  };
  native.onstop = () => {
    recorder.onstop?.();
  };
  return { stream, recorder };
}

export function createVoiceCapture(opts: VoiceCaptureOptions): VoiceCapture {
  const open = opts.open ?? openBrowserMicrophone;

  let state: VoiceCaptureState = "idle";
  let stream: VoiceCaptureStream | null = null;
  let recorder: VoiceCaptureRecorder | null = null;
  let chunks: Blob[] = [];
  /** `finish()` was called — the only path that delivers a result. */
  let wantsResult = false;
  /** `dispose()` was called. Latched, and checked again after every await. */
  let disposed = false;

  function releaseDevice(): void {
    const held = stream;
    stream = null;
    if (held) stopEveryTrack(held);
  }

  function close(): void {
    releaseDevice();
    recorder = null;
    chunks = [];
    state = "closed";
  }

  async function start(): Promise<void> {
    if (state !== "idle") return;
    state = "opening";

    let session: VoiceCaptureSession;
    try {
      session = await open();
    } catch {
      state = "closed";
      if (!disposed) opts.onError(MIC_DENIED);
      return;
    }

    // The user left while the permission prompt / device open was in flight.
    // Nothing above us holds this stream, but the OS input is open until every
    // track is stopped — so stop them here rather than letting the mic sit
    // open for the rest of the session.
    if (disposed) {
      stopEveryTrack(session.stream);
      return;
    }

    stream = session.stream;
    recorder = session.recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const produced = chunks.slice();
      const mimeType = recorder?.mimeType || "audio/webm";
      const deliver = wantsResult && !disposed;
      // Release first, deliver second: the upload can take seconds and there
      // is no reason to hold the microphone through it.
      close();
      if (deliver) {
        opts.onFinished(new Blob(produced, { type: mimeType }), mimeType);
      }
    };

    try {
      recorder.start(CHUNK_MS);
      state = "recording";
    } catch (reason) {
      close();
      opts.onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function pause(): void {
    if (state !== "recording" || !recorder) return;
    try {
      recorder.pause();
      state = "paused";
    } catch {
      /* recorder raced to inactive — the state below reflects reality */
    }
  }

  function resume(): void {
    if (state !== "paused" || !recorder) return;
    try {
      recorder.resume();
      state = "recording";
    } catch {
      /* same */
    }
  }

  function finish(): void {
    if (state !== "recording" && state !== "paused") return;
    wantsResult = true;
    state = "stopping";
    const rec = recorder;
    if (!rec) {
      close();
      return;
    }
    try {
      rec.stop();
    } catch {
      // The recorder never got going — close by hand so the device is still
      // released, and report nothing (there are no bytes to deliver).
      wantsResult = false;
      close();
    }
  }

  function cancel(): void {
    wantsResult = false;
    const rec = recorder;
    if (rec && rec.state !== "inactive") {
      state = "stopping";
      try {
        rec.stop();
        return;
      } catch {
        /* fall through to the hard close */
      }
    }
    close();
  }

  function dispose(): void {
    disposed = true;
    wantsResult = false;
    const rec = recorder;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* nothing to stop */
      }
    }
    // Never wait for `onstop` to fire — an unmount has to release the device
    // synchronously, and `close()` is idempotent with the handler.
    close();
  }

  return {
    start,
    pause,
    resume,
    finish,
    cancel,
    dispose,
    state: () => state,
    microphoneIsOpen: () => stream !== null,
  };
}

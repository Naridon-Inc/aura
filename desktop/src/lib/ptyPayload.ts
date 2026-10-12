// The one place that turns a PTY event payload into bytes.
//
// `pty:<id>` and `agent-pty:<id>` carry terminal output, and the backend sends
// it base64-encoded — see `pty_emit::encode_chunk`. It used to send a `Vec<u8>`,
// which Tauri's JSON `emit` expands into an array of decimal integers: a 64 KB
// chunk of build output crossed as ~224 KB of text, which the webview parsed
// into a JS array that the frontend then copied elementwise into a
// `Uint8Array`. Measured 132 MB/s. Base64 is ~1.33x the bytes rather than
// ~3.5x and decodes in one pass — measured 631 MB/s, and better again where
// the engine has a native `Uint8Array.fromBase64`.
//
// Four call sites each wrote `new Uint8Array(e.payload)` — the plain and
// agent terminals, the machine-connect wizard and the run row. They all
// come through here now, so the wire format is stated once and the two ends
// can only ever disagree in one place. (`agentPromptSeed` also listens on
// `agent-pty:<id>`, but only as a settle beat; it never reads the payload.)

/**
 * A chunk as it arrives. A `string` is base64, which is what the backend
 * sends today; `number[]` is the shape it sent before, accepted so a webview
 * and a backend that disagree degrade to slow rather than to a dead terminal.
 */
export type PtyChunk = string | number[];

/** `Uint8Array.fromBase64` is newer than our TS lib, so reach it by shape. */
type MaybeNativeBase64 = {
  fromBase64?: (encoded: string) => Uint8Array;
};

const nativeFromBase64 = (Uint8Array as unknown as MaybeNativeBase64)
  .fromBase64;

let warned = false;

/**
 * Decode one chunk of PTY output.
 *
 * Never throws: this runs inside an event listener, where an exception would
 * take the terminal's subscription down with it and leave the pane frozen
 * mid-stream. A chunk that cannot be decoded is dropped — visible as a gap in
 * the output, which is recoverable — and reported once.
 */
export function decodePtyChunk(payload: PtyChunk): Uint8Array {
  if (typeof payload !== "string") {
    return new Uint8Array(payload);
  }
  if (payload.length === 0) return new Uint8Array(0);

  if (nativeFromBase64) {
    try {
      return nativeFromBase64.call(Uint8Array, payload);
    } catch {
      /* Fall through — the portable path decodes the same input. */
    }
  }

  try {
    const binary = atob(payload);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("[pty] dropped an undecodable output chunk", error);
    }
    return new Uint8Array(0);
  }
}

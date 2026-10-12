import { describe, expect, test } from "bun:test";

import { decodePtyChunk } from "./ptyPayload";

const b64 = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes));

describe("decodePtyChunk", () => {
  test("decodes what the backend sends", () => {
    const bytes = [0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x68, 0x69];
    expect(Array.from(decodePtyChunk(b64(bytes)))).toEqual(bytes);
  });

  test("carries bytes that are not valid UTF-8", () => {
    // A chunk boundary can fall mid-sequence, so the stream is not text: a
    // lone continuation byte, an interior NUL, a trailing 0xff. All of these
    // have to arrive unchanged or the escape stream renders as mojibake.
    const bytes = [0x80, 0x00, 0x1b, 0xff, 0xfe];
    expect(Array.from(decodePtyChunk(b64(bytes)))).toEqual(bytes);
  });

  test("preserves every byte value across a full 0..255 sweep", () => {
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(decodePtyChunk(b64(bytes)))).toEqual(bytes);
  });

  test("decodes the exact vector the backend pins", () => {
    // The same vector `pty_emit.rs` asserts it produces, so the two ends
    // cannot drift apart silently. URL-safe base64 would spell these bytes
    // `__4NCg==` rather than `//4NCg==`.
    expect(Array.from(decodePtyChunk("G1szMW2AAG9r//4NCg=="))).toEqual([
      0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x80, 0x00, 0x6f, 0x6b, 0xff, 0xfe, 0x0d, 0x0a,
    ]);
  });

  test("an empty chunk decodes to no bytes", () => {
    expect(decodePtyChunk("")).toHaveLength(0);
  });

  test("still accepts the integer array the backend used to send", () => {
    // A webview and a backend that disagree should degrade to slow, not to a
    // terminal that renders nothing.
    const bytes = [0x6f, 0x6b, 0x0a];
    expect(Array.from(decodePtyChunk(bytes))).toEqual(bytes);
  });

  test("a corrupt chunk is dropped rather than thrown", () => {
    // This runs inside an event listener: throwing would take the
    // subscription down and freeze the pane for the rest of the session.
    expect(() => decodePtyChunk("!!! not base64 !!!")).not.toThrow();
  });

  test("decoding does not depend on a native fromBase64 being present", () => {
    // The fast path is feature-detected at import, so the portable path has
    // to produce identical bytes — that is what runs on an older engine.
    const bytes = [0x00, 0x7f, 0x80, 0xff, 0x41];
    const encoded = b64(bytes);
    const portable = atob(encoded);
    const expected = Array.from(portable, (c) => c.charCodeAt(0));
    expect(Array.from(decodePtyChunk(encoded))).toEqual(expected);
    expect(expected).toEqual(bytes);
  });
});

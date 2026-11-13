// Run with: bun test src/lib/engineErrorEvent.test.ts
//
// A turn whose text is an engine's raw error event reads as a short sentence;
// anything else is left as the answer it is.

import { describe, expect, test } from "bun:test";
import { engineErrorSentence, parseEngineErrorEvent } from "./engineErrorEvent";

// The exact turn that showed the bug: OpenCode's run wire, a 401 from its
// token exchange, stored as the assistant's text.
const OPENCODE_401 =
  '{"type":"error","timestamp":1794315640949,"sessionID":"ses_e3a742b81ffeHKS068RxFLQ6pw","error":{"name":"UnknownError","data":{"message":"Failed to get direct access token: 401 Unauthorized - {\\"message\\":\\"401 Unauthorized\\"}"}}}';

describe("an engine's raw error event", () => {
  test("OpenCode's sign-in failure reads as a sentence with its status", () => {
    const e = parseEngineErrorEvent(OPENCODE_401);
    expect(e).not.toBeNull();
    expect(e!.status).toBe(401);
    expect(e!.detail).toContain("Failed to get direct access token");
    expect(engineErrorSentence(e!, "OpenCode")).toBe("OpenCode couldn't sign in (401)");
  });

  test("a bare API error body is one too", () => {
    const e = parseEngineErrorEvent(
      '{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}',
    );
    expect(engineErrorSentence(e!, "Gemini")).toBe("Gemini hit its usage limit (429)");
  });

  test("with no status and no engine it still says what happened", () => {
    const e = parseEngineErrorEvent('{"type":"error","error":{"name":"ProviderInitError"}}');
    expect(engineErrorSentence(e!, null)).toBe("The engine stopped with an error");
  });
});

describe("what is not an error event", () => {
  test("prose that talks about an error", () => {
    expect(parseEngineErrorEvent("The request failed with a 401 Unauthorized error.")).toBeNull();
  });

  test("JSON that is not an error event", () => {
    expect(parseEngineErrorEvent('{"type":"text","part":{"text":"hi"}}')).toBeNull();
    expect(parseEngineErrorEvent('{"error":{"code":1},"result":"ok"}')).toBeNull();
  });

  test("text that only looks like JSON", () => {
    expect(parseEngineErrorEvent('{"type":"error", oops')).toBeNull();
  });
});

// Run with: bun test src/components/manager/chat/AgentMessageBody.test.tsx
//
// A turn whose text is an engine's raw error event draws as one plain
// sentence; the event's JSON never reaches the page.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageBody } from "./AgentMessageBody";

const OPENCODE_401 =
  '{"type":"error","timestamp":1794315640949,"sessionID":"ses_e3a742b81ffeHKS068RxFLQ6pw","error":{"name":"UnknownError","data":{"message":"Failed to get direct access token: 401 Unauthorized"}}}';

describe("a turn that is an engine's error event", () => {
  test("reads as who failed and why, with a way to fix it", () => {
    const html = renderToStaticMarkup(<AgentMessageBody source={OPENCODE_401} engine="OpenCode" />);
    expect(html).toContain("OpenCode couldn&#x27;t sign in (401)");
    expect(html).toContain("Sign in or switch engine");
    expect(html).not.toContain("&quot;type&quot;");
    expect(html).not.toContain("sessionID");
  });

  test("an answer around it keeps its prose", () => {
    const html = renderToStaticMarkup(
      <AgentMessageBody source={`Trying the other model.\n\n${OPENCODE_401}`} engine="OpenCode" />,
    );
    expect(html).toContain("Trying the other model.");
    expect(html).toContain("OpenCode couldn&#x27;t sign in (401)");
  });
});

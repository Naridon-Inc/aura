// The turn a workspace's agent is working on, as everyone watching sees it:
// the reply as it is written, each tool as it runs, and what it is waiting
// on the member who drives the chat to allow.

import type { LiveState } from "../../lib/cloudWorkspaceLive";
import { ChatStatus, Message, MessageBody, ToolCall } from "../ui/message";

export function CloudLiveTurn({ live, driver }: { live: LiveState; driver: string | null }) {
  if (!live.working) return null;
  return (
    <>
      {live.steps.map((s, i) =>
        s.kind === "tool" ? (
          <ToolCall key={s.id} title={s.title} status={s.status} />
        ) : (
          <Message key={`t${i}`} role="assistant">
            <MessageBody>{s.text}</MessageBody>
          </Message>
        ),
      )}
      {live.asking ? (
        <ChatStatus state="permission">
          {`Waiting for ${driver ?? "the member driving this chat"} to allow: ${live.asking}`}
        </ChatStatus>
      ) : (
        <ChatStatus state="working">Working…</ChatStatus>
      )}
    </>
  );
}

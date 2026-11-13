// A message that never reached the agent, with the one button that fixes it.
//
// When the agent process behind a chat has died, sending fails with an error
// line and the message is simply gone — the only recovery was to notice,
// find the text, and paste it again. This keeps the words, says what
// happened in plain language, and offers Retry: bring the session back, then
// send the same message with the same settings.

import { useState } from "react";

import { ChatRecovery } from "../ui/chat-recovery";
import "../ui/chat-surface.css";

export type UndeliverableMessageProps = {
  /** What the user tried to send. */
  text: string;
  /** Why it failed, as the backend put it. Shown small under the headline. */
  reason: string | null;
  /** Restart the session and send the message again. Rejects on failure. */
  onRestart: () => Promise<void>;
  /** Drop the message and clear the notice. */
  onDismiss: () => void;
};

export function UndeliverableMessage({
  text,
  reason,
  onRestart,
  onDismiss,
}: UndeliverableMessageProps) {
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const restart = async () => {
    setWorking(true);
    setFailed(null);
    try {
      await onRestart();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const preview = text.length > 160 ? `${text.slice(0, 157)}…` : text;

  // While the restart runs the notice is the reconnecting state: a spinner
  // and no buttons, so the message cannot be sent twice.
  if (working) {
    return (
      <ChatRecovery
        kind="reconnecting"
        detail="Restarting the agent and sending your message again."
      />
    );
  }
  return (
    <ChatRecovery
      kind="generic"
      detail={
        <>
          This message didn't get through — the agent had stopped.
          {preview && <span className="ui-chat-undelivered-text">{preview}</span>}
          {(failed ?? reason) && (
            <span className="ui-chat-undelivered-reason">{failed ?? reason}</span>
          )}
        </>
      }
      onRetry={() => void restart()}
      action={{ label: "Dismiss", onClick: onDismiss }}
    />
  );
}

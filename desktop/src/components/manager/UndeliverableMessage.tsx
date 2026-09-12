// A message that never reached the agent, with the one button that fixes it.
//
// When the agent process behind a chat has died, sending fails with an error
// line and the message is simply gone — the only recovery was to notice,
// find the text, and paste it again. This keeps the words, says what
// happened in plain language, and offers "Restart and resend": bring the
// session back, then send the same message with the same settings.

import { useState } from "react";

import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

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

  return (
    <div
      role="alert"
      className="mt-2 rounded border border-line-soft bg-bg-1 px-2 py-1.5 text-xs"
    >
      <div className="text-text-1">This message didn't get through — the agent had stopped.</div>
      {preview && (
        <div className="mt-1 whitespace-pre-wrap text-text-4">{preview}</div>
      )}
      {(failed ?? reason) && (
        <div className="mt-1 font-mono text-[11px] text-text-4">{failed ?? reason}</div>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <Button size="sm" onClick={() => void restart()} disabled={working}>
          {working ? (
            <>
              <AsciiSpinner className="text-2xs" /> Restarting…
            </>
          ) : (
            "Restart and resend"
          )}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={working}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

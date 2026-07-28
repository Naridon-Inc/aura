// Send a note to another copy of this project.
//
// The thing that makes several parallel copies survivable is that they can
// talk. Aura already carries messages between them in the shared record, and
// an agent reads its inbox when it starts work — so a line typed here reaches
// whoever picks that copy up next, human or agent, without anyone leaving the
// app or knowing where the mailbox lives.
//
// The one honest thing this has to do is say when nobody is listening. A note
// to a copy with no session running is stored, not delivered, and pretending
// otherwise is how people end up believing they warned someone.

import { useState } from "react";

import { Dialog } from "../../Dialog";
import { Button } from "../../ui/button";
import { api } from "../../../lib/api";

type Props = {
  repoRoot: string;
  /** Folder name of the copy being written to. */
  toWorktree: string;
  onClose: () => void;
};

export function SayToWorktreeDialog({ repoRoot, toWorktree, onClose }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ recipients: number } | null>(null);

  async function send() {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await api.worktreeSay(repoRoot, message, toWorktree);
      setSent({ recipients: result.recipients });
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open
      width={460}
      title={sent ? "Note sent" : `Note to ${toWorktree}`}
      onClose={onClose}
      footer={
        sent ? (
          <Button size="xs" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="xs" onClick={send} disabled={!text.trim() || sending}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-text-2)" }}>
          {sent.recipients > 0
            ? `Delivered to ${sent.recipients} ${sent.recipients === 1 ? "session" : "sessions"} working in ${toWorktree}.`
            : `Nothing is running in ${toWorktree} right now, so the note is waiting there. Whoever opens it next — you or an agent — reads it before starting.`}
        </p>
      ) : (
        <>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={4}
            placeholder="e.g. I'm rewriting the login check in here — leave it alone for now"
            className="w-full resize-none rounded-sm px-2.5 py-2 text-[12.5px] leading-relaxed outline-none"
            style={{
              background: "var(--color-bg-2)",
              color: "var(--color-text-1)",
              border: "1px solid var(--color-line-soft)",
            }}
          />
          <p className="mt-2 text-[11px]" style={{ color: "var(--color-text-4)" }}>
            Goes to whoever works in that copy next. ⌘↵ to send.
          </p>
          {error && (
            <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-red)" }}>
              {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

// Send a note to another workspace of this project.
//
// The thing that makes several parallel workspaces survivable is that they
// can talk. Aura already carries messages between them in the shared record,
// and an agent reads its inbox when it starts work — so a line typed here
// reaches whoever picks that workspace up next, human or agent, without
// anyone leaving the app or knowing where the mailbox lives.
//
// The one honest thing this has to do is say when nobody is listening. A note
// to a workspace with no session running is stored, not delivered, and
// pretending otherwise is how people end up believing they warned someone.

import { useEffect, useState } from "react";

import { Dialog } from "../../Dialog";
import { Alert, AlertDescription } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import { Textarea } from "../../ui/textarea";
import { api } from "../../../lib/api";
import "../../ui/ask-aura.css";
import "../../ui/note-to-workspace.css";

type Props = {
  repoRoot: string;
  /** The checkout's name as the record knows it: `main` for the main
   *  checkout, otherwise its folder name. */
  toWorktree: string;
  /** What the person calls it, when that differs from the folder name. */
  label?: string;
  onClose: () => void;
};

export type NoteToWorkspaceRequest = Omit<Props, "onClose">;

const NOTE_EVENT = "aura:note-to-workspace";

/** Open the note dialog from anywhere (a row menu, a command). */
export function requestNoteToWorkspace(request: NoteToWorkspaceRequest): void {
  window.dispatchEvent(new CustomEvent(NOTE_EVENT, { detail: request }));
}

/** Mounted once; shows the dialog for whichever row asked last. */
export function NoteToWorkspaceHost() {
  const [request, setRequest] = useState<NoteToWorkspaceRequest | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      const detail = (e as CustomEvent<NoteToWorkspaceRequest>).detail;
      if (detail?.repoRoot && detail.toWorktree) setRequest(detail);
    };
    window.addEventListener(NOTE_EVENT, open);
    return () => window.removeEventListener(NOTE_EVENT, open);
  }, []);
  if (!request) return null;
  return (
    <SayToWorktreeDialog
      key={`${request.repoRoot}\u0000${request.toWorktree}`}
      {...request}
      onClose={() => setRequest(null)}
    />
  );
}

export function SayToWorktreeDialog({ repoRoot, toWorktree, label, onClose }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ recipients: number } | null>(null);
  const name = label || toWorktree;

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
      title={sent ? "Note sent" : `Note to ${name}`}
      onClose={onClose}
      footer={
        sent ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <p className="ui-ask-aura-keys">
              <Kbd>⌘↵</Kbd> to send
            </p>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={send} disabled={!text.trim() || sending}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <p className="ui-note-to-workspace-sent">
          {sent.recipients > 0
            ? `Delivered to ${sent.recipients} ${sent.recipients === 1 ? "session" : "sessions"} working in ${name}.`
            : `Nothing is running in ${name} right now, so the note is waiting there. Whoever opens it next, you or an agent, reads it before starting.`}
        </p>
      ) : (
        <div className="ui-note-to-workspace">
          <Textarea
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
            aria-label={`Note to ${name}`}
            placeholder="e.g. I'm rewriting the login check in here. Leave it alone for now"
          />
          <p className="ui-note-to-workspace-help">
            Goes to whoever works in that workspace next, you or an agent.
          </p>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </Dialog>
  );
}

// The Comments tab of a shared workspace's right panel: comments on the
// workspace as a whole (with their own box), every open thread on its
// messages with a way back to the message, and the resolved ones folded
// away at the end.

import { CommentBox } from "../ui/cloud-comments";
import { isResolved, type Thread } from "./cloudFeedback";
import { RoomThread, useFeedbackRoom } from "./CloudTurnFeedback";

const lastChange = (t: Thread) =>
  Math.max(...[t.root, ...t.replies].map((c) => Date.parse(c.updated_at) || 0));
const newestFirst = (a: { t: Thread }, b: { t: Thread }) => lastChange(b.t) - lastChange(a.t);

export function CloudCommentsTab({
  excerptOf,
  onGoTo,
}: {
  /** A few words of a turn, to say which message a thread is on. */
  excerptOf: (messageId: string) => string | null;
  onGoTo: (messageId: string, commentId: string) => void;
}) {
  const room = useFeedbackRoom();
  if (!room) return null;
  const onTurns = Object.entries(room.threads.byTurn).flatMap(([mid, ts]) => ts.map((t) => ({ mid, t })));
  const open = onTurns.filter((x) => !isResolved(x.t)).sort(newestFirst);
  const here = room.threads.workspace.filter((t) => !isResolved(t));
  const resolved = [
    ...onTurns.filter((x) => isResolved(x.t)),
    ...room.threads.workspace.filter(isResolved).map((t) => ({ mid: null as string | null, t })),
  ].sort(newestFirst);
  const anchor = (mid: string, rootId: string) => {
    const said = excerptOf(mid);
    return (
      <div className="ui-comments-anchor">
        <span>{said ? `On “${said}”` : "On a message"}</span>
        <button type="button" className="ui-comments-goto" onClick={() => onGoTo(mid, rootId)}>
          Go to message
        </button>
      </div>
    );
  };
  return (
    <div className="ui-comments-tab">
      <section className="ui-comments-section" aria-label="Comments on this workspace">
        <h3>On this workspace</h3>
        {here.map((t) => (
          <div key={t.root.id} className="ui-comments-item">
            <RoomThread t={t} />
          </div>
        ))}
        {room.closed ? (
          here.length === 0 && <p className="ui-comments-empty">No comments on this workspace.</p>
        ) : (
          <CommentBox
            placeholder="Comment on the workspace, or @mention a teammate"
            suggestions={room.suggestions}
            onSubmit={(body) => room.actions.comment({ messageId: null }, body)}
          />
        )}
      </section>
      <section className="ui-comments-section" aria-label="Open threads">
        <h3>{open.length ? `Open threads · ${open.length}` : "Open threads"}</h3>
        {open.length === 0 ? (
          <p className="ui-comments-empty">No open threads. Comment on a message to start one.</p>
        ) : (
          open.map(({ mid, t }) => (
            <div key={t.root.id} className="ui-comments-item">
              <RoomThread t={t} above={anchor(mid, t.root.id)} />
            </div>
          ))
        )}
      </section>
      {resolved.length > 0 && (
        <details className="ui-comments-section">
          <summary>{`Resolved · ${resolved.length}`}</summary>
          {resolved.map(({ mid, t }) => (
            <div key={t.root.id} className="ui-comments-item">
              <RoomThread t={t} above={mid ? anchor(mid, t.root.id) : undefined} />
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

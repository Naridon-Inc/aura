// Comments: the threaded discussion on one task. The composer always
// writes a root comment or a reply to one; replies sit under their root.
// Editing and deleting go through `tasks_comments_update` /
// `tasks_comments_delete`, and only the author sees those actions.

import { useCallback, useEffect, useState } from "react";

import { shortDate } from "../../lib/calendarDate";
import { relativeAge } from "../../lib/relativeTime";
import { api, type Task, type TaskComment, type TeamMember } from "../../lib/api";
import { Button } from "../ui/button";
import { TaskDetailNote, TaskDetailSection } from "../ui/tasks-detail";
import { TaskFormError } from "../ui/tasks-form";
import { Textarea } from "../ui/textarea";
import { TaskMarkdown } from "./TaskMarkdown";

// Past a week an age stops being useful and the calendar date is what the
// reader wants instead.
function formatTimestamp(iso: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso.slice(0, 10);
  const now = Date.now();
  return now - ms < 7 * 86_400_000 ? relativeAge(ms, { now }) : shortDate(ms, { now });
}

export function CommentsCard({
  task,
  repoRoot,
  currentHandle,
  members = [],
}: {
  task: Task;
  repoRoot: string;
  currentHandle: string | null;
  members?: TeamMember[];
}) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      setComments(await api.tasksCommentsList(repoRoot, task.id));
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot, task.id]);

  useEffect(() => {
    void refresh();
    setDraft("");
    setReplyTo(null);
    setEditingId(null);
  }, [refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const body = draft.trim();
    if (!body || busy) return;
    void run(async () => {
      await api.tasksCommentsCreate(repoRoot, task.id, body, {
        parentCommentId: replyTo,
        authorHandle: currentHandle ?? undefined,
      });
      setDraft("");
      setReplyTo(null);
    });
  };
  const commitEdit = () => {
    if (!editingId) return;
    const body = editingDraft.trim();
    if (!body) {
      setEditingId(null);
      return;
    }
    const id = editingId;
    void run(async () => {
      await api.tasksCommentsUpdate(repoRoot, id, body);
      setEditingId(null);
      setEditingDraft("");
    });
  };
  const deleteComment = (id: string) => void run(() => api.tasksCommentsDelete(repoRoot, id));

  const roots = comments.filter((c) => !c.parent_comment_id);
  const repliesByRoot = new Map<string, TaskComment[]>();
  for (const c of comments) {
    if (!c.parent_comment_id) continue;
    const arr = repliesByRoot.get(c.parent_comment_id) ?? [];
    arr.push(c);
    repliesByRoot.set(c.parent_comment_id, arr);
  }

  const row = (c: TaskComment, onReply: (() => void) | null) => (
    <CommentRow
      key={c.id}
      comment={c}
      members={members}
      busy={busy}
      isEditing={editingId === c.id}
      editingDraft={editingDraft}
      isOwner={currentHandle != null && currentHandle === c.author_handle}
      onStartEdit={() => {
        setEditingId(c.id);
        setEditingDraft(c.body);
      }}
      onChangeDraft={setEditingDraft}
      onCommitEdit={commitEdit}
      onCancelEdit={() => setEditingId(null)}
      onDelete={() => deleteComment(c.id)}
      onReply={onReply}
    />
  );

  return (
    <TaskDetailSection title="Comments" count={comments.length}>
      {roots.length === 0 && (
        <TaskDetailNote>
          No comments yet. Anything you or an agent says about this work goes here, so the
          reasoning stays with the item.
        </TaskDetailNote>
      )}
      <div className="ui-tasks-comments">
        {roots.map((root) => (
          <div key={root.id} className="ui-tasks-comment-thread">
            {row(root, () => setReplyTo(root.id))}
            {(repliesByRoot.get(root.id) ?? []).map((reply) => (
              <div key={reply.id} className="ui-tasks-comment-reply">
                {row(reply, null)}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="ui-tasks-comment-composer">
        {replyTo && (
          <div className="ui-tasks-comment-replying">
            <span>
              Replying to {comments.find((c) => c.id === replyTo)?.author_handle ?? "a comment"}
            </span>
            <Button variant="ghost" size="xs" onClick={() => setReplyTo(null)}>
              Cancel reply
            </Button>
          </div>
        )}
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={replyTo ? "Write a reply…" : "Add a comment…"}
          aria-label={replyTo ? "Reply" : "Comment"}
          disabled={busy}
          rows={2}
        />
        <div className="ui-tasks-comment-foot">
          <span>{currentHandle ? `As ${currentHandle}` : "System comment"}</span>
          <Button size="xs" onClick={submit} disabled={busy || draft.trim().length === 0}>
            {busy ? "Sending…" : replyTo ? "Reply" : "Comment"}
          </Button>
        </div>
        {error && <TaskFormError>{error}</TaskFormError>}
      </div>
    </TaskDetailSection>
  );
}

function CommentRow({
  comment,
  members,
  busy,
  isEditing,
  editingDraft,
  isOwner,
  onStartEdit,
  onChangeDraft,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  onReply,
}: {
  comment: TaskComment;
  members: TeamMember[];
  busy: boolean;
  isEditing: boolean;
  editingDraft: string;
  isOwner: boolean;
  onStartEdit: () => void;
  onChangeDraft: (s: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onReply: (() => void) | null;
}) {
  const edited = comment.updated_at !== comment.created_at;
  return (
    <article className="ui-tasks-comment">
      <header>
        <strong>{comment.author_handle}</strong>
        <span>
          {formatTimestamp(comment.created_at)}
          {edited && " · edited"}
        </span>
        <div className="ui-tasks-detail-actions">
          {onReply && (
            <Button variant="ghost" size="xs" onClick={onReply}>
              Reply
            </Button>
          )}
          {isOwner && (
            <>
              <Button variant="ghost" size="xs" onClick={onStartEdit} disabled={busy}>
                Edit
              </Button>
              <Button variant="ghost" size="xs" onClick={onDelete} disabled={busy}>
                Delete
              </Button>
            </>
          )}
        </div>
      </header>
      {isEditing ? (
        <div className="ui-tasks-comment-edit">
          <Textarea
            value={editingDraft}
            onChange={(e) => onChangeDraft(e.target.value)}
            aria-label="Edit comment"
            autoFocus
            rows={2}
          />
          <div className="ui-tasks-detail-actions">
            <Button variant="ghost" size="xs" onClick={onCancelEdit}>
              Cancel
            </Button>
            <Button
              size="xs"
              onClick={onCommitEdit}
              disabled={busy || editingDraft.trim().length === 0}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <TaskMarkdown source={comment.body} members={members} />
      )}
    </article>
  );
}

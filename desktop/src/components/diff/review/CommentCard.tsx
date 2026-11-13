// A written comment under its lines. An agent's comment leads with who left
// it and when; yours with the lines it covers. Then its text, and Edit and
// Delete for your own (Delete only while it is not waiting in the chat), and
// the button that puts it in the chat or takes it back out.

import { Bot, MessageSquareOff, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";

import { addCommentToChat, removeCommentFromChat } from "../../../lib/diffReview/commentChat";
import {
  commentKind,
  commentTime,
  deleteComment,
  startEdit,
  type ReviewComment,
} from "../../../lib/diffReview/reviewComments";
import { toast } from "../../../lib/toast";
import { Button } from "../../ui/button";
import { CommentBody, CommentRange } from "./CommentBody";
import { useInComposer } from "./useReviewStore";

export function AddToChatButton({ comment }: { comment: ReviewComment }) {
  const { target, inComposer } = useInComposer(comment);
  const onClick = () => {
    if (!target) return;
    if (inComposer) {
      removeCommentFromChat(target, comment);
      return;
    }
    if (!addCommentToChat(target, comment)) {
      toast.danger("Failed to add comment to chat", "Open a chat in this workspace first.");
    }
  };
  return (
    <Button variant="outline" size="sm" disabled={!target} onClick={onClick}>
      {inComposer ? <MessageSquareOff size={12} /> : <MessageSquarePlus size={12} />}
      {inComposer ? "Remove from chat" : "Add to chat"}
    </Button>
  );
}

/** The author's picture, or a round mark: every comment with an author here
 *  came from an agent. */
function CommentAvatar({ comment }: { comment: ReviewComment }) {
  if (comment.authorAvatarUrl) {
    return <img className="ui-diff-review-avatar" src={comment.authorAvatarUrl} alt={comment.author ?? ""} />;
  }
  return (
    <span className="ui-diff-review-avatar" data-mark="">
      <Bot size={12} />
    </span>
  );
}

/** "🤖 claude-sonnet · Nov 9, 3:04 PM", or "You · …" for your own. */
export function CommentAuthor({ comment }: { comment: ReviewComment }) {
  return (
    <div className="ui-diff-review-author">
      {comment.author ? (
        <>
          <CommentAvatar comment={comment} />
          <span>{comment.author}</span>
        </>
      ) : (
        <span>You</span>
      )}
      <span>·</span>
      <span>{commentTime(comment.createdAt)}</span>
    </div>
  );
}

export function CommentCard({ comment, repoRoot }: { comment: ReviewComment; repoRoot?: string }) {
  const { inComposer } = useInComposer(comment);
  const mine = commentKind(comment) === "user-local";
  return (
    <div className="ui-diff-review-comment">
      {comment.author && <CommentAuthor comment={comment} />}
      <CommentRange comment={comment} />
      <CommentBody comment={comment} repoRoot={repoRoot} />
      <div className="ui-diff-review-buttons">
        {mine && (
          <Button variant="ghost" size="sm" onClick={() => startEdit(comment.id, comment.body)}>
            <Pencil size={12} />
            Edit
          </Button>
        )}
        {mine && !inComposer && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => deleteComment(comment.workspace, comment.id)}
          >
            <Trash2 size={12} />
            Delete
          </Button>
        )}
        <AddToChatButton comment={comment} />
      </div>
    </div>
  );
}

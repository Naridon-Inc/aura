// The editor a comment opens in: a box to write in, Cancel, and Comment (or
// Save, when changing one already written). Cancelling asks first when the
// text would be lost. A new comment, once written, goes straight to the chat.
//
// Keys are read off the text box itself rather than through React: inside a
// Monaco diff the comment sits in one of the editor's view zones, which stops
// keys from reaching the editor's own shortcuts on the way up.

import { useEffect, useRef, useState } from "react";

import { addCommentToChat } from "../../../lib/diffReview/commentChat";
import {
  cancelNeedsConfirm,
  deleteComment,
  discardDescription,
  discardDraft,
  saveComment,
  updateDraftBody,
  type ReviewComment,
} from "../../../lib/diffReview/reviewComments";
import { toast } from "../../../lib/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import { Textarea } from "../../ui/textarea";
import { CommentRange } from "./CommentBody";
import { useCommentChatTarget, useDraftBody } from "./useReviewStore";

export function CommentEditor({ comment }: { comment: ReviewComment }) {
  const editing = comment.state !== "draft";
  const draft = useDraftBody(comment.id);
  const body = draft ?? (editing ? comment.body : "");
  const blank = body.trim().length === 0;
  const target = useCommentChatTarget();
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const close = () => {
    discardDraft(comment.id);
    if (!editing) deleteComment(comment.workspace, comment.id);
  };
  const cancel = () => {
    if (cancelNeedsConfirm({ editing, saved: comment.body, current: body })) setConfirming(true);
    else close();
  };
  const submit = () => {
    if (blank) return;
    const saved = saveComment(comment.workspace, comment.id, body);
    discardDraft(comment.id);
    if (editing) {
      if (!saved) toast.danger("Failed to save comment");
      return;
    }
    if (!saved || !target || !addCommentToChat(target, saved)) {
      toast.danger("Failed to add comment to chat", "Open a chat in this workspace first.");
    }
  };

  const keys = useRef({ cancel, submit });
  keys.current = { cancel, submit };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        keys.current.cancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        keys.current.submit();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="ui-diff-review-comment">
      <CommentRange comment={comment} />
      <div className="ui-diff-review-input">
        <Textarea
          ref={ref}
          value={body}
          placeholder="Add a comment for the AI"
          aria-label="Add a comment for the AI"
          onChange={(e) => updateDraftBody(comment.id, e.target.value)}
        />
      </div>
      <div className="ui-diff-review-buttons">
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={blank} onClick={submit}>
          {editing ? "Save" : "Comment"}
          <Kbd>⌘↵</Kbd>
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard comment?</AlertDialogTitle>
            <AlertDialogDescription>{discardDescription(editing)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="ui-button-danger"
              onClick={() => {
                setConfirming(false);
                close();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// One comment as it sits under its lines: the editor while it is being
// written or changed, the card once it is written.

import type { ReviewComment } from "../../../lib/diffReview/reviewComments";
import { CommentCard } from "./CommentCard";
import { CommentEditor } from "./CommentEditor";
import { useDraftBody } from "./useReviewStore";
import "../../ui/diff-review.css";

export function DiffComment({ comment, repoRoot }: { comment: ReviewComment; repoRoot?: string }) {
  const editing = useDraftBody(comment.id) !== undefined;
  if (comment.state === "draft" || editing) return <CommentEditor comment={comment} />;
  return <CommentCard comment={comment} repoRoot={repoRoot} />;
}

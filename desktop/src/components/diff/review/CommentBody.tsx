// What a comment shows under its lines: the run it covers, and its text with
// any ```suggestion block drawn as a suggested change against those lines.

import { useMemo } from "react";

import {
  commentRangeLabel,
  dedent,
  splitSuggestions,
  type ReviewComment,
} from "../../../lib/diffReview/reviewComments";
import { suggestionPatch } from "../../../lib/diffReview/suggestionPatch";
import { MarkdownView } from "../../MarkdownView";
import { UnifiedDiff } from "../UnifiedDiff";

export function CommentRange({ comment }: { comment: Pick<ReviewComment, "lineNumber" | "endLineNumber"> }) {
  const label = commentRangeLabel(comment);
  return label ? <div className="ui-diff-review-range">{label}</div> : null;
}

export function SuggestedChange({ base, suggestion }: { base: string; suggestion: string }) {
  const patch = useMemo(() => suggestionPatch(dedent(base), dedent(suggestion)), [base, suggestion]);
  return (
    <div className="ui-diff-review-suggestion">
      <div className="ui-diff-review-suggestion-head">Suggested change</div>
      <UnifiedDiff diff={patch} />
    </div>
  );
}

export function CommentBody({ comment, repoRoot }: { comment: ReviewComment; repoRoot?: string }) {
  const parts = useMemo(() => splitSuggestions(comment.body), [comment.body]);
  return (
    <div className="ui-diff-review-body">
      {parts.map((p, i) =>
        p.kind === "suggestion" && comment.suggestionBaseCode !== undefined ? (
          <SuggestedChange key={i} base={comment.suggestionBaseCode} suggestion={p.code} />
        ) : (
          <MarkdownView
            key={i}
            repoRoot={repoRoot}
            source={p.kind === "text" ? p.text : `\`\`\`\n${p.code}\n\`\`\``}
          />
        ),
      )}
    </div>
  );
}

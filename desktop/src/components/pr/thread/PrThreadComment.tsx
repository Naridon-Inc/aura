// One comment in a review thread: who wrote it and when, what they said in
// the shared message markdown, and the reactions people left on it.

import { useState, type ReactNode } from "react";
import { SmilePlus } from "lucide-react";
import type { PrComment, PrCommentReaction, ReactionContent } from "../../../lib/api";
import { monogram } from "../../../lib/monogram";
import { relativeAgeFromIso } from "../../../lib/relativeTime";
import { Avatar, AvatarFallback } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { MessageMarkdown } from "../../ui/transcript-content";
import { REACTIONS } from "./prThreads";
import "../../ui/pr-thread.css";

export function PrThreadComment({
  comment,
  actions,
  onReact,
}: {
  comment: PrComment;
  /** The thread's own controls, drawn beside the first comment only. */
  actions?: ReactNode;
  onReact?: (content: ReactionContent) => void;
}) {
  return (
    <article className="ui-pr-thread-comment">
      <header className="ui-pr-thread-head">
        <Avatar aria-hidden>
          <AvatarFallback>{monogram(comment.author)}</AvatarFallback>
        </Avatar>
        <strong>{comment.author}</strong>
        <time dateTime={comment.created_at}>
          {relativeAgeFromIso(comment.created_at, { style: "compact" })}
        </time>
        {actions && <div className="ui-pr-thread-actions">{actions}</div>}
      </header>
      <div className="ui-pr-activity-body">
        <MessageMarkdown content={comment.body} />
      </div>
      {onReact && <PrReactionBar reactions={comment.reactions} onToggle={onReact} />}
    </article>
  );
}

/** The reaction picker: the eight reactions a review comment takes. */
export function PrReactionPicker({ onPick }: { onPick: (content: ReactionContent) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="iconXs" aria-label="Add reaction" title="Add reaction">
          <SmilePlus />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="ui-pr-reaction-picker" aria-label="Reactions">
        {REACTIONS.map((r) => (
          <Button
            key={r.content}
            variant="ghost"
            size="iconSm"
            aria-label={r.label}
            title={r.label}
            onClick={() => {
              onPick(r.content);
              setOpen(false);
            }}
          >
            <span className="ui-pr-reaction-emoji">{r.emoji}</span>
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function PrReactionBar({
  reactions,
  onToggle,
}: {
  reactions: PrCommentReaction[];
  onToggle: (content: ReactionContent) => void;
}) {
  const visible = reactions.filter((r) => r.count > 0);
  if (visible.length === 0) return null;
  return (
    <div className="ui-pr-reactions">
      {visible.map((r) => {
        const meta = REACTIONS.find((x) => x.content === r.content);
        return (
          <Button
            key={r.content}
            variant="outline"
            size="xs"
            aria-pressed={r.viewer_reacted}
            title={meta?.label ?? r.content}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(r.content);
            }}
          >
            <span className="ui-pr-reaction-emoji">{meta?.emoji ?? "?"}</span>
            <span className="ui-pr-reaction-count">{r.count}</span>
          </Button>
        );
      })}
    </div>
  );
}

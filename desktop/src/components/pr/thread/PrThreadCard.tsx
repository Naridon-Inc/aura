// A review thread beside the diff line it belongs to: the first comment with
// the thread's controls (hand it to an agent, react, resolve, reply), the
// replies folded under it, and a reply box when one is being written.

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Reply } from "lucide-react";
import type { PrComment, ReactionContent } from "../../../lib/api";
import { prCommentReply, prCommentResolve, prReactionAdd, prReactionRemove } from "../../../lib/prApi";
import { FixWithAgentButton } from "../../agent/FixWithAgentButton";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Textarea } from "../../ui/textarea";
import { PrReactionPicker, PrThreadComment } from "./PrThreadComment";
import { buildCommentFixPrompt, type ThreadGroup } from "./prThreads";
import "../../ui/pr-thread.css";

export function PrThreadCard({
  thread,
  repoRoot,
  prNumber,
  onPosted,
}: {
  thread: ThreadGroup;
  repoRoot: string;
  prNumber: number;
  onPosted?: (c: PrComment) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(thread.root.thread_resolved);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const replyCount = thread.replies.length;
  const canResolve = !!thread.root.thread_node_id;

  const submitReply = async () => {
    if (!replyText.trim() || submitting) return;
    setSubmitting(true);
    try {
      const c = await prCommentReply(repoRoot, prNumber, thread.root.id, replyText);
      onPosted?.(c);
      setReplyText("");
      setReplying(false);
    } catch (e) {
      console.error("reply failed", e);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleResolve = async () => {
    if (!thread.root.thread_node_id) return;
    setResolving(true);
    try {
      await prCommentResolve(repoRoot, thread.root.thread_node_id);
      setResolved((v) => !v);
    } catch (e) {
      console.error("resolve toggle failed", e);
    } finally {
      setResolving(false);
    }
  };

  const react = async (target: PrComment, content: ReactionContent) => {
    const existing = target.reactions.find((r) => r.content === content);
    try {
      if (existing?.viewer_reacted) {
        await prReactionRemove(repoRoot, target.node_id, content);
      } else {
        await prReactionAdd(repoRoot, target.node_id, content);
      }
      onPosted?.(thread.root);
    } catch (e) {
      console.error("reaction toggle failed", e);
    }
  };

  return (
    <Card className="ui-pr-thread" data-resolved={resolved ? "" : undefined}>
      <PrThreadComment
        comment={thread.root}
        onReact={(content) => react(thread.root, content)}
        actions={
          <>
            <FixWithAgentButton
              iconOnly
              label="Fix with agent…"
              prompt={buildCommentFixPrompt(thread.root)}
            />
            <PrReactionPicker onPick={(content) => react(thread.root, content)} />
            {canResolve && (
              <Button
                variant="ghost"
                size="iconXs"
                aria-pressed={resolved}
                aria-label={resolved ? "Reopen thread" : "Resolve thread"}
                title={resolved ? "Reopen thread" : "Resolve thread"}
                disabled={resolving}
                onClick={toggleResolve}
              >
                <Check />
              </Button>
            )}
            <Button
              variant="ghost"
              size="iconXs"
              aria-label="Reply"
              title="Reply"
              onClick={() => setReplying(true)}
            >
              <Reply />
            </Button>
          </>
        }
      />
      {replyCount > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="ui-pr-thread-toggle"
          aria-expanded={repliesOpen}
          onClick={() => setRepliesOpen((v) => !v)}
        >
          {repliesOpen ? <ChevronDown /> : <ChevronRight />}
          {repliesOpen ? "Hide" : "Show"} {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </Button>
      )}
      {repliesOpen &&
        thread.replies.map((r) => (
          <PrThreadComment key={r.id} comment={r} onReact={(content) => react(r, content)} />
        ))}
      {replying && (
        <form
          className="ui-pr-thread-reply"
          onSubmit={(e) => {
            e.preventDefault();
            void submitReply();
          }}
        >
          <Textarea
            autoFocus
            rows={3}
            value={replyText}
            aria-label="Reply"
            placeholder="Write a reply…"
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submitReply();
              }
            }}
          />
          <div className="ui-pr-thread-reply-actions">
            <Button
              variant="ghost"
              size="xs"
              disabled={submitting}
              onClick={() => {
                setReplying(false);
                setReplyText("");
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={submitting || !replyText.trim()}>
              {submitting ? (
                <>
                  <AsciiSpinner size={10} />
                  Sending…
                </>
              ) : (
                "Reply"
              )}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

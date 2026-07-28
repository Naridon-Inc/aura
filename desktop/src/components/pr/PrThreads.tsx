// PR threads — Stage 7B. Renders inline review-comment threads grouped
// by file → line, plus a top-level conversation thread for issue-level
// comments. Supports reply, resolve, post-new (composer), and one-click
// "Convert to Plan" handoff to the Aura Manager (Stage 7C).
//
// Data flow: PRDetailPane fetches comments once with `prCommentsList`,
// passes the raw array down. We bucket here. Mutations call the Tauri
// command directly + optimistically prepend the response to local state
// so the UI updates without waiting for a refetch.
//
// Unread tracking: PRDetailPane writes `aura.pr.<repoRoot>.<pr>.last_seen_at`
// to localStorage on first paint of a PR; we compare each comment's
// created_at against that to decide whether to render the unread dot.

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type PrComment } from "../../lib/api";
import { Button } from "../ui/button";

type Props = {
  repoRoot: string;
  prNumber: number;
  comments: PrComment[];
  /** ISO timestamp from localStorage representing the user's last visit
   *  to this PR. Comments newer than this get an unread dot. */
  lastSeenAt: string | null;
  /** Refetch trigger after mutations. */
  onMutated: () => void;
  /** Open the Aura Manager launcher pre-populated with a Plan draft
   *  derived from one or more comments (Stage 7C). */
  onConvertToPlan: (comments: PrComment[]) => void;
  /** When set, only render the inline thread(s) for this file. The PR
   *  header still gets the full count via `comments.length`. */
  filterPath?: string;
};

type Thread = {
  root: PrComment;
  replies: PrComment[];
};

export function PrThreads({
  repoRoot,
  prNumber,
  comments,
  lastSeenAt,
  onMutated,
  onConvertToPlan,
  filterPath,
}: Props) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const inline = comments.filter((c) => !c.is_issue_comment);
  const issue = comments.filter((c) => c.is_issue_comment);

  const inlineThreads = useMemo(() => buildThreads(inline), [inline]);

  // Apply per-file filter (when invoked from a single file's diff
  // context). The conversation column always shows all issue comments.
  const visibleInline = filterPath
    ? inlineThreads.filter((t) => t.root.path === filterPath)
    : inlineThreads;

  const totalThreads = inlineThreads.length;
  const filteredCount = visibleInline.length;
  const unreadCount = countUnread(comments, lastSeenAt);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const convertSelected = () => {
    const picked = comments.filter((c) => selectedIds.has(c.id));
    if (picked.length === 0) return;
    onConvertToPlan(picked);
  };

  const submitIssueComment = async () => {
    const body = composerBody.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await api.prCommentPostIssue(repoRoot, prNumber, body);
      setComposerBody("");
      setComposerOpen(false);
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-7 px-3 flex items-center border-b border-line-soft text-[11px] text-text-2 font-medium uppercase tracking-wider gap-2 flex-shrink-0">
        <span>Threads</span>
        <span className="text-[10.5px] text-text-4 tabular-nums">
          {filterPath ? `${filteredCount}/${totalThreads}` : totalThreads}
        </span>
        {unreadCount > 0 && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-accent"
            title={`${unreadCount} unread`}
          />
        )}
        {selectedIds.size > 0 && (
          <Button
            variant="subtle"
            size="xs"
            onClick={convertSelected}
            className="ml-auto h-5 px-2 text-[10px]"
            title="Convert selected comments into a Manager plan"
          >
            → Plan ({selectedIds.size})
          </Button>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 text-[11px] text-red font-mono whitespace-pre-wrap border-b border-line-soft">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visibleInline.length === 0 && issue.length === 0 ? (
          <div className="text-text-4 text-[12px] px-3 py-3">
            {filterPath
              ? "no threads on this file."
              : "no comments yet."}
          </div>
        ) : (
          <>
            {visibleInline.map((t) => (
              <ThreadCard
                key={t.root.id}
                repoRoot={repoRoot}
                prNumber={prNumber}
                thread={t}
                lastSeenAt={lastSeenAt}
                selected={selectedIds.has(t.root.id)}
                onToggleSelect={() => toggleSelect(t.root.id)}
                onConvert={() => onConvertToPlan([t.root, ...t.replies])}
                onMutated={onMutated}
              />
            ))}
            {!filterPath && issue.length > 0 && (
              <div className="border-t border-line-soft mt-1">
                <div className="px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-text-4">
                  Conversation
                </div>
                {issue.map((c) => (
                  <CommentBody
                    key={c.id}
                    c={c}
                    lastSeenAt={lastSeenAt}
                    selected={selectedIds.has(c.id)}
                    onToggleSelect={() => toggleSelect(c.id)}
                    onConvert={() => onConvertToPlan([c])}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Issue-comment composer (file-agnostic). Per-line composers live
          on the diff gutter and call api.prCommentPost directly. */}
      <div className="border-t border-line-soft flex-shrink-0">
        {!composerOpen ? (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="w-full px-3 py-1.5 text-left text-[11px] text-text-3 hover:bg-bg-2"
          >
            + Add comment
          </button>
        ) : (
          <div className="p-2 space-y-1.5">
            <textarea
              autoFocus
              value={composerBody}
              onChange={(e) => setComposerBody(e.target.value)}
              placeholder="Comment on this PR…"
              className="w-full text-[11.5px] bg-bg-1 border border-line-soft rounded px-2 py-1.5 resize-y min-h-[60px] focus:outline-none focus:border-accent-blue"
            />
            <div className="flex items-center gap-1.5">
              <Button
                variant="accentSoft"
                size="xs"
                onClick={submitIssueComment}
                disabled={busy || composerBody.trim().length === 0}
              >
                {busy ? "posting…" : "Comment"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setComposerOpen(false);
                  setComposerBody("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function buildThreads(inline: PrComment[]): Thread[] {
  // Roots: comments without `in_reply_to` or whose parent isn't in the
  // current set (shouldn't happen via gh but be defensive). Replies are
  // grouped under their root id. GitHub's REST returns inline comments
  // with `in_reply_to_id` set on every comment in a thread except the
  // first.
  const byId = new Map(inline.map((c) => [c.id, c]));
  const threads = new Map<number, Thread>();
  for (const c of inline) {
    const rootId = walkToRoot(c, byId);
    const root = byId.get(rootId);
    if (!root) continue;
    let t = threads.get(rootId);
    if (!t) {
      t = { root, replies: [] };
      threads.set(rootId, t);
    }
    if (c.id !== rootId) t.replies.push(c);
  }
  for (const t of threads.values()) {
    t.replies.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return Array.from(threads.values()).sort((a, b) =>
    a.root.created_at.localeCompare(b.root.created_at),
  );
}

function walkToRoot(c: PrComment, by: Map<number, PrComment>): number {
  let cur = c;
  // Cap traversal — hostile data shouldn't loop forever.
  for (let i = 0; i < 64 && cur.in_reply_to !== null; i++) {
    const next = by.get(cur.in_reply_to);
    if (!next) break;
    cur = next;
  }
  return cur.id;
}

function countUnread(comments: PrComment[], lastSeenAt: string | null): number {
  if (!lastSeenAt) return 0;
  return comments.filter((c) => c.created_at > lastSeenAt).length;
}

function ThreadCard({
  repoRoot,
  prNumber,
  thread,
  lastSeenAt,
  selected,
  onToggleSelect,
  onConvert,
  onMutated,
}: {
  repoRoot: string;
  prNumber: number;
  thread: Thread;
  lastSeenAt: string | null;
  selected: boolean;
  onToggleSelect: () => void;
  onConvert: () => void;
  onMutated: () => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submitReply = async () => {
    const body = replyBody.trim();
    if (!body) return;
    setBusy(true);
    try {
      await api.prCommentReply(repoRoot, prNumber, thread.root.id, body);
      setReplyBody("");
      setReplyOpen(false);
      onMutated();
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    if (!thread.root.thread_node_id) return;
    setBusy(true);
    try {
      await api.prCommentResolve(repoRoot, thread.root.thread_node_id);
      onMutated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`border-b border-line-soft px-3 py-2 ${thread.root.thread_resolved ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="w-3 h-3" style={{ accentColor: "var(--color-accent)" }}
          title="Select to convert into a Manager plan"
        />
        {thread.root.path && (
          <span className="text-[10.5px] text-text-3 font-mono truncate flex-1">
            {thread.root.path}
            {thread.root.line ? `:${thread.root.line}` : ""}
          </span>
        )}
        {thread.root.thread_resolved && (
          <span className="text-[10px] uppercase tracking-wider text-text-4">
            Resolved
          </span>
        )}
        {!thread.root.thread_resolved && thread.root.thread_node_id && (
          <Button
            variant="ghost"
            size="xs"
            onClick={resolve}
            disabled={busy}
            className="h-5 px-1.5 text-[10.5px] text-text-3 hover:text-text-1"
            title="Resolve thread"
          >
            Resolve
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={onConvert}
          className="h-5 px-1.5 text-[10.5px] text-accent hover:text-text-1"
          title="Convert this thread into a Manager plan"
        >
          → Plan
        </Button>
      </div>
      <CommentBody c={thread.root} lastSeenAt={lastSeenAt} compact />
      {thread.replies.map((r) => (
        <div key={r.id} className="ml-3 mt-1 border-l border-line-soft pl-2">
          <CommentBody c={r} lastSeenAt={lastSeenAt} compact />
        </div>
      ))}
      <div className="mt-1 ml-3">
        {!replyOpen ? (
          <Button
            variant="link"
            size="xs"
            onClick={() => setReplyOpen(true)}
            className="h-auto px-0 text-[10.5px] text-text-4 hover:text-text-1 no-underline hover:no-underline"
          >
            Reply
          </Button>
        ) : (
          <div className="space-y-1">
            <textarea
              autoFocus
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              className="w-full text-[11.5px] bg-bg-1 border border-line-soft rounded px-2 py-1 resize-y min-h-[40px] focus:outline-none focus:border-accent-blue"
              placeholder="Reply…"
            />
            <div className="flex items-center gap-1.5">
              <Button
                variant="accentSoft"
                size="xs"
                onClick={submitReply}
                disabled={busy || replyBody.trim().length === 0}
                className="h-5 px-2 text-[10.5px]"
              >
                {busy ? "…" : "Reply"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setReplyOpen(false);
                  setReplyBody("");
                }}
                className="h-5 px-2 text-[10.5px]"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentBody({
  c,
  lastSeenAt,
  selected,
  onToggleSelect,
  onConvert,
  compact,
}: {
  c: PrComment;
  lastSeenAt: string | null;
  selected?: boolean;
  onToggleSelect?: () => void;
  onConvert?: () => void;
  compact?: boolean;
}) {
  const unread = lastSeenAt !== null && c.created_at > lastSeenAt;
  return (
    <div className={compact ? "" : "px-3 py-2 border-b border-line-soft"}>
      <div className="flex items-center gap-1.5">
        {!compact && onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            className="w-3 h-3" style={{ accentColor: "var(--color-accent)" }}
          />
        )}
        {unread && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
        <span className="text-[11px] text-text-2 font-medium">{c.author}</span>
        <span className="text-[10.5px] text-text-4 tabular-nums">
          {formatAge(c.created_at)}
        </span>
        {!compact && onConvert && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onConvert}
            className="ml-auto h-5 px-1.5 text-[10.5px] text-accent hover:text-text-1"
          >
            → Plan
          </Button>
        )}
      </div>
      <div className="text-[11.5px] text-text-1 leading-relaxed mt-0.5 [&_p]:my-0 [&_p+p]:mt-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-bg-2 [&_code]:text-[11px] [&_pre]:my-1.5 [&_pre]:p-2 [&_pre]:rounded [&_pre]:bg-bg-2 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_a]:text-accent [&_a:hover]:underline [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5">
        {c.body ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
        ) : (
          <span className="text-text-4 italic">(empty)</span>
        )}
      </div>
    </div>
  );
}

function formatAge(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return "<1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}

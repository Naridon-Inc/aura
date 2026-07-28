// PageComments — a PR/ticket-style conversation thread that mounts at the
// bottom of a Page. Comments persist durably in a sidecar JSON beside the
// page (see `src-tauri/src/cmd_page_comments.rs`); this surface just lists
// them and posts new ones through `pagesApi`.
//
// Plain-language, vibecoder audience: no jargon, no bulky cards — a compact
// conversation list + a calm composer, the way you'd leave a note on a doc.

import { useCallback, useEffect, useRef, useState } from "react";

import { Avatar } from "../team/presentation/Avatar";
import { Button } from "../ui/button";
import {
  pageCommentsAdd,
  pageCommentsList,
  pageCommentsResolve,
  type PageComment,
} from "./pagesApi";

type PageCommentsProps = {
  repoRoot: string;
  scope: string;
  bucket: string;
  id: string;
  /** The current user's handle; falls back to a sensible default if unset. */
  authorHandle?: string;
};

/** "3m ago" style relative stamp. Extends `formatRelativeAge` out to
 *  days / months / years for an aging thread, matching the TaskDetailPane
 *  style. Bad/empty timestamps degrade to an empty string rather than NaN. */
function relativeTime(iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function PageComments(props: PageCommentsProps) {
  const { repoRoot, scope, bucket, id, authorHandle } = props;
  const author = authorHandle && authorHandle.trim() ? authorHandle.trim() : "you";

  const [comments, setComments] = useState<PageComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-tick relative stamps once a minute without refetching from disk.
  const [now, setNow] = useState(() => Date.now());

  // Guard against a stale page's load landing after the user switched pages.
  const reqKeyRef = useRef("");

  const load = useCallback(() => {
    const key = `${repoRoot}|${scope}|${bucket}|${id}`;
    reqKeyRef.current = key;
    setLoaded(false);
    pageCommentsList(repoRoot, scope, bucket, id)
      .then((rows) => {
        if (reqKeyRef.current !== key) return;
        setComments(rows);
        setLoaded(true);
      })
      .catch((e) => {
        if (reqKeyRef.current !== key) return;
        setError(String(e));
        setLoaded(true);
      });
  }, [repoRoot, scope, bucket, id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setError(null);

    // Optimistic row — reconciled with the persisted one once it lands.
    const optimisticId = `pending_${Date.now()}`;
    const optimistic: PageComment = {
      id: optimisticId,
      author,
      body,
      created_at: new Date().toISOString(),
      resolved_at: null,
    };
    setComments((prev) => [...prev, optimistic]);
    setDraft("");

    try {
      const saved = await pageCommentsAdd(repoRoot, scope, bucket, id, author, body);
      setComments((prev) => prev.map((c) => (c.id === optimisticId ? saved : c)));
    } catch (e) {
      // Roll the optimistic row back and restore the draft so nothing is lost.
      setComments((prev) => prev.filter((c) => c.id !== optimisticId));
      setDraft(body);
      setError(String(e));
    } finally {
      setPosting(false);
    }
  }, [draft, posting, author, repoRoot, scope, bucket, id]);

  const toggleResolve = useCallback(
    async (comment: PageComment) => {
      const next = !comment.resolved_at;
      // Optimistic flip.
      setComments((prev) =>
        prev.map((c) =>
          c.id === comment.id
            ? { ...c, resolved_at: next ? new Date().toISOString() : null }
            : c,
        ),
      );
      try {
        const saved = await pageCommentsResolve(
          repoRoot,
          scope,
          bucket,
          id,
          comment.id,
          next,
        );
        setComments((prev) => prev.map((c) => (c.id === comment.id ? saved : c)));
      } catch (e) {
        // Revert on failure.
        setComments((prev) =>
          prev.map((c) =>
            c.id === comment.id ? { ...c, resolved_at: comment.resolved_at } : c,
          ),
        );
        setError(String(e));
      }
    },
    [repoRoot, scope, bucket, id],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const count = comments.length;

  return (
    <section className="mt-6 border-t border-line-soft pt-4">
      <header className="mb-3 flex items-baseline gap-2">
        <h3 className="text-sm font-medium text-text-1">Comments</h3>
        {count > 0 && <span className="text-xs text-text-3">{count}</span>}
      </header>

      {error && (
        <div className="mb-3 text-xs text-red">
          {error}
        </div>
      )}

      {loaded && count === 0 && (
        <p className="mb-3 text-xs text-text-3">
          No comments yet — start the conversation.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {comments.map((c) => {
          const stamp = relativeTime(c.created_at, now);
          const resolved = !!c.resolved_at;
          return (
            <li key={c.id} className="flex gap-2.5">
              <Avatar name={c.author} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-1">
                    {c.author}
                  </span>
                  {stamp && (
                    <span className="text-[11px] text-text-3">{stamp}</span>
                  )}
                  {resolved && (
                    <span className="text-[11px] text-text-3">· resolved</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void toggleResolve(c)}
                    className="ml-auto text-[11px] text-text-3 hover:text-text-1 transition-colors"
                  >
                    {resolved ? "Reopen" : "Resolve"}
                  </button>
                </div>
                <p
                  className={`mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed ${
                    resolved ? "text-text-3 line-through" : "text-text-2"
                  }`}
                >
                  {c.body}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Add a comment…"
          className="w-full resize-y rounded-md border border-line-soft bg-bg-2 px-2.5 py-2 text-[13px] text-text-1 placeholder:text-text-4 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-4">⌘↵ to comment</span>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={posting || !draft.trim()}
          >
            {posting ? "Posting…" : "Comment"}
          </Button>
        </div>
      </div>
    </section>
  );
}

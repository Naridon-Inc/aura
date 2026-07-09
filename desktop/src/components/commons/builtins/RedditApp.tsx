// Reddit — a real, first-party Commons builtin app.
//
// Browse any subreddit without leaving Aura. It reads Reddit's PUBLIC,
// credential-free listing JSON (`/r/<sub>/<sort>.json`) through the
// host-allowlisted `commons_app_fetch` Rust proxy — no OAuth, no API key, no
// tracking. Clicking a post opens its Reddit page in the OS browser. This is
// the reference builtin that proves the platform pitch: people can actually
// *do things* in the Commons app space, fully sandboxed at the host boundary.

import { useCallback, useEffect, useState } from "react";
import {
  ArrowBigUp,
  MessageSquare,
  RefreshCw,
  ExternalLink,
  Search,
} from "lucide-react";

import { api } from "../../../lib/api";

type Sort = "hot" | "new" | "top" | "rising";

const SORTS: { id: Sort; label: string }[] = [
  { id: "hot", label: "Hot" },
  { id: "new", label: "New" },
  { id: "top", label: "Top" },
  { id: "rising", label: "Rising" },
];

type Post = {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  score: number;
  comments: number;
  permalink: string;
  url: string;
  thumb: string | null;
  stickied: boolean;
  over18: boolean;
  createdUtc: number;
};

/** Pull the typed posts we render out of Reddit's raw listing JSON. Tolerant
 *  of missing fields — a malformed child is skipped, never thrown on. */
function parseListing(body: string): Post[] {
  const json = JSON.parse(body) as unknown;
  const children = (json as { data?: { children?: unknown[] } })?.data?.children;
  if (!Array.isArray(children)) return [];
  const out: Post[] = [];
  for (const c of children) {
    const d = (c as { data?: Record<string, unknown> })?.data;
    if (!d || typeof d.id !== "string" || typeof d.title !== "string") continue;
    const thumbRaw = typeof d.thumbnail === "string" ? d.thumbnail : "";
    const thumb = /^https?:\/\//.test(thumbRaw) ? thumbRaw : null;
    out.push({
      id: d.id,
      title: d.title,
      subreddit: typeof d.subreddit === "string" ? d.subreddit : "",
      author: typeof d.author === "string" ? d.author : "",
      score: typeof d.score === "number" ? d.score : 0,
      comments: typeof d.num_comments === "number" ? d.num_comments : 0,
      permalink: typeof d.permalink === "string" ? d.permalink : "",
      url: typeof d.url === "string" ? d.url : "",
      thumb,
      stickied: d.stickied === true,
      over18: d.over_18 === true,
      createdUtc: typeof d.created_utc === "number" ? d.created_utc : 0,
    });
  }
  return out;
}

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ago(createdUtc: number): string {
  if (!createdUtc) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - createdUtc));
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

async function openExternal(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* opener unavailable — silently no-op rather than crash the pane */
  }
}

export function RedditApp() {
  const [subreddit, setSubreddit] = useState("popular");
  const [draft, setDraft] = useState("popular");
  const [sort, setSort] = useState<Sort>("hot");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (sub: string, srt: Sort) => {
    const clean = sub.trim().replace(/^\/?(r\/)?/i, "") || "popular";
    setLoading(true);
    setError(null);
    try {
      const url = `https://www.reddit.com/r/${encodeURIComponent(
        clean,
      )}/${srt}.json?limit=30&raw_json=1`;
      const res = await api.commonsAppFetch("reddit", url);
      if (res.status === 404) {
        setPosts([]);
        setError(`r/${clean} not found`);
        return;
      }
      if (res.status === 403) {
        setPosts([]);
        setError(`r/${clean} is private, quarantined, or rate-limited`);
        return;
      }
      if (res.status >= 400) {
        setPosts([]);
        setError(`Reddit returned ${res.status}`);
        return;
      }
      setPosts(parseListing(res.body));
    } catch (e) {
      setPosts([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(subreddit, sort);
  }, [load, subreddit, sort]);

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const clean = draft.trim().replace(/^\/?(r\/)?/i, "");
      setSubreddit(clean || "popular");
    },
    [draft],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-0">
      {/* Toolbar — subreddit search + sort. Wraps so it stays usable when this
          app is sized to a narrow Commons rail, not just a full tab. */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 border-b border-line-soft">
        <img
          src="/app-icons/reddit.svg"
          alt=""
          className="h-4.5 w-4.5 flex-shrink-0"
          width={18}
          height={18}
        />
        <form onSubmit={submit} className="relative flex-1 min-w-[120px] max-w-[220px]">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-5 pointer-events-none"
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder="subreddit"
            aria-label="Subreddit"
            className="h-7 w-full pl-6 pr-2 rounded-md border border-line-soft bg-bg-1 text-[12px] text-text-1 placeholder:text-text-5 focus:outline-none focus:border-accent transition-colors"
          />
        </form>
        <button
          type="button"
          onClick={() => void load(subreddit, sort)}
          aria-label="Refresh"
          className="h-7 w-7 flex-shrink-0 inline-flex items-center justify-center rounded-md text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors order-last sm:order-none"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSort(s.id)}
              className={[
                "h-7 px-2 rounded-md text-[11.5px] transition-colors",
                sort === s.id
                  ? "bg-accent/15 text-accent"
                  : "text-text-3 hover:text-text-1 hover:bg-bg-2",
              ].join(" ")}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && posts.length === 0 ? (
          <SkeletonList />
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center px-6">
            <div className="text-[13px] text-text-2">{error}</div>
            <button
              type="button"
              onClick={() => void load(subreddit, sort)}
              className="h-8 px-3 rounded-md border border-line-soft bg-bg-2 text-[12px] text-text-1 hover:bg-bg-3 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : posts.length === 0 ? (
          <div className="py-16 text-center text-[12px] text-text-4">
            No posts here yet.
          </div>
        ) : (
          <ul className="divide-y divide-line-soft">
            {posts.map((p) => (
              <PostRow key={p.id} post={p} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PostRow({ post }: { post: Post }) {
  const href = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : post.url;
  return (
    <li>
      <button
        type="button"
        onClick={() => void openExternal(href)}
        className="group w-full flex items-start gap-3 px-3.5 py-2.5 text-left hover:bg-bg-1/60 transition-colors"
      >
        {/* Score */}
        <div className="flex flex-col items-center w-9 flex-shrink-0 pt-0.5 text-text-4">
          <ArrowBigUp size={15} className="text-text-5" />
          <span className="text-[11px] font-semibold tabular-nums text-text-3">
            {compactNum(post.score)}
          </span>
        </div>

        {/* Thumb */}
        {post.thumb ? (
          <img
            src={post.thumb}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            className="h-11 w-11 flex-shrink-0 rounded object-cover border border-line-soft bg-bg-2"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : null}

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[10.5px] font-medium text-text-3">
              r/{post.subreddit}
            </span>
            <span className="text-[10px] text-text-5">· u/{post.author}</span>
            {post.createdUtc ? (
              <span className="text-[10px] text-text-5">
                · {ago(post.createdUtc)}
              </span>
            ) : null}
            {post.over18 ? (
              <span className="text-[9px] font-semibold text-rose-400 border border-rose-500/40 rounded px-1">
                NSFW
              </span>
            ) : null}
          </div>
          <div className="text-[12.5px] leading-snug text-text-1 group-hover:text-accent transition-colors line-clamp-2">
            {post.title}
          </div>
          <div className="flex items-center gap-1 mt-1 text-[10.5px] text-text-4">
            <MessageSquare size={11} />
            <span className="tabular-nums">{compactNum(post.comments)}</span>
            <span>comments</span>
          </div>
        </div>

        <ExternalLink
          size={13}
          className="flex-shrink-0 mt-0.5 text-text-5 opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </button>
    </li>
  );
}

function SkeletonList() {
  return (
    <ul className="divide-y divide-line-soft animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 px-3.5 py-2.5">
          <div className="w-9 h-8 rounded bg-bg-2" />
          <div className="h-11 w-11 rounded bg-bg-2" />
          <div className="flex-1 space-y-1.5 pt-0.5">
            <div className="h-2.5 w-24 rounded bg-bg-2" />
            <div className="h-3 w-3/4 rounded bg-bg-2" />
            <div className="h-2.5 w-16 rounded bg-bg-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

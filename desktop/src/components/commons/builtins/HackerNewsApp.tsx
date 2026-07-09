// Hacker News — a real, first-party Commons builtin app.
//
// Reads the PUBLIC, credential-free Algolia HN Search API
// (`hn.algolia.com/api/v1/...`) through the host-allowlisted
// `commons_app_fetch` Rust proxy. One request per view returns fully
// hydrated stories (title / url / points / author / comments), so unlike a
// Firebase id-fan-out there's no N+1 — the feed paints from a single fetch.
// Clicking a story opens the article; the comment count opens the HN thread.
// No OAuth, no API key, no tracking — the second reference app proving the
// Commons space isn't a one-app demo.

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, RefreshCw, ExternalLink, ArrowUp } from "lucide-react";

import { api } from "../../../lib/api";

type Feed = "top" | "new" | "ask" | "show";

const FEEDS: { id: Feed; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "new", label: "New" },
  { id: "ask", label: "Ask" },
  { id: "show", label: "Show" },
];

type Story = {
  id: string;
  title: string;
  url: string | null;
  points: number;
  author: string;
  comments: number;
  createdUtc: number;
};

/** Build the Algolia endpoint for a feed. `front_page` is the curated Top
 *  list; `search_by_date` is chronological; ask/show filter by tag. */
function feedUrl(feed: Feed): string {
  const n = 30;
  switch (feed) {
    case "new":
      return `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=${n}`;
    case "ask":
      return `https://hn.algolia.com/api/v1/search?tags=ask_hn&hitsPerPage=${n}`;
    case "show":
      return `https://hn.algolia.com/api/v1/search?tags=show_hn&hitsPerPage=${n}`;
    case "top":
    default:
      return `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${n}`;
  }
}

/** Parse the typed stories out of an Algolia search response. Tolerant of
 *  missing fields — a malformed hit is skipped, never thrown on. */
function parseHits(body: string): Story[] {
  const json = JSON.parse(body) as unknown;
  const hits = (json as { hits?: unknown[] })?.hits;
  if (!Array.isArray(hits)) return [];
  const out: Story[] = [];
  for (const h of hits) {
    const d = h as Record<string, unknown>;
    const id = typeof d.objectID === "string" ? d.objectID : "";
    const title = typeof d.title === "string" ? d.title : "";
    if (!id || !title) continue;
    out.push({
      id,
      title,
      url: typeof d.url === "string" && d.url ? d.url : null,
      points: typeof d.points === "number" ? d.points : 0,
      author: typeof d.author === "string" ? d.author : "",
      comments: typeof d.num_comments === "number" ? d.num_comments : 0,
      createdUtc: typeof d.created_at_i === "number" ? d.created_at_i : 0,
    });
  }
  return out;
}

function compactNum(n: number): string {
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

/** The HN thread URL for a story id. */
function threadUrl(id: string): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

/** Short hostname for the source pill (e.g. `github.com`). */
function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function openExternal(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* opener unavailable — silently no-op rather than crash the pane */
  }
}

export function HackerNewsApp() {
  const [feed, setFeed] = useState<Feed>("top");
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: Feed) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.commonsAppFetch("hackernews", feedUrl(f));
      if (res.status >= 400) {
        setStories([]);
        setError(`Hacker News returned ${res.status}`);
        return;
      }
      setStories(parseHits(res.body));
    } catch (e) {
      setStories([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(feed);
  }, [load, feed]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-0">
      {/* Toolbar — feed switch. Wraps for narrow rail widths. */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 border-b border-line-soft">
        <img
          src="/app-icons/hackernews.svg"
          alt=""
          className="h-4.5 w-4.5 flex-shrink-0"
          width={18}
          height={18}
        />
        <div className="flex items-center gap-0.5 flex-1 min-w-0">
          {FEEDS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFeed(f.id)}
              className={[
                "h-7 px-2.5 rounded-md text-[11.5px] transition-colors",
                feed === f.id
                  ? "bg-accent/15 text-accent"
                  : "text-text-3 hover:text-text-1 hover:bg-bg-2",
              ].join(" ")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load(feed)}
          aria-label="Refresh"
          className="h-7 w-7 flex-shrink-0 inline-flex items-center justify-center rounded-md text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Feed */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && stories.length === 0 ? (
          <SkeletonList />
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center px-6">
            <div className="text-[13px] text-text-2">{error}</div>
            <button
              type="button"
              onClick={() => void load(feed)}
              className="h-8 px-3 rounded-md border border-line-soft bg-bg-2 text-[12px] text-text-1 hover:bg-bg-3 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : stories.length === 0 ? (
          <div className="py-16 text-center text-[12px] text-text-4">
            Nothing here right now.
          </div>
        ) : (
          <ol className="divide-y divide-line-soft">
            {stories.map((s, i) => (
              <StoryRow key={s.id} rank={i + 1} story={s} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function StoryRow({ rank, story }: { rank: number; story: Story }) {
  const host = hostOf(story.url);
  const open = story.url ?? threadUrl(story.id);
  return (
    <li className="group flex items-start gap-2.5 px-3.5 py-2.5 hover:bg-bg-1/60 transition-colors">
      <span className="w-5 flex-shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-text-5">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => void openExternal(open)}
          className="text-left w-full"
        >
          <span className="text-[12.5px] leading-snug text-text-1 group-hover:text-accent transition-colors line-clamp-2">
            {story.title}
          </span>
          {host ? (
            <span className="ml-1.5 text-[10px] text-text-5 whitespace-nowrap">
              ({host})
            </span>
          ) : null}
        </button>
        <div className="flex items-center gap-2 mt-1 text-[10.5px] text-text-4">
          <span className="inline-flex items-center gap-0.5">
            <ArrowUp size={11} className="text-text-5" />
            <span className="tabular-nums">{compactNum(story.points)}</span>
          </span>
          {story.author ? <span>by {story.author}</span> : null}
          {story.createdUtc ? <span>· {ago(story.createdUtc)}</span> : null}
          <button
            type="button"
            onClick={() => void openExternal(threadUrl(story.id))}
            className="inline-flex items-center gap-1 hover:text-accent transition-colors"
            title="Open the HN discussion"
          >
            <MessageSquare size={11} />
            <span className="tabular-nums">{compactNum(story.comments)}</span>
          </button>
        </div>
      </div>
      <ExternalLink
        size={13}
        className="flex-shrink-0 mt-0.5 text-text-5 opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </li>
  );
}

function SkeletonList() {
  return (
    <ul className="divide-y divide-line-soft animate-pulse">
      {Array.from({ length: 10 }).map((_, i) => (
        <li key={i} className="flex items-start gap-2.5 px-3.5 py-2.5">
          <div className="w-5 h-3 rounded bg-bg-2 mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-3/4 rounded bg-bg-2" />
            <div className="h-2.5 w-24 rounded bg-bg-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// Notes side-sheet. Two modes:
//
//   1. Feed — timed entries (author + ts + body + mentions). Scope tabs:
//        • Channel  → `.aura/team/channels/<channel>.feed.jsonl` (committed)
//        • Team     → `.aura/team/notes.feed.jsonl`               (committed)
//        • Mine     → `~/.aura/notes/<key>/<handle>.feed.jsonl`   (local-only)
//   2. Canvas — single markdown doc, unchanged from v0.2.8. Per-channel
//      lives at `.aura/team/channels/<channel>.notes.md` and team-wide
//      at `.aura/team/notes.md`. Committed via normal git.
//
// Trigger: `aura:open-channel-notes` window event with detail
//   { repoRoot, channel, mode?: "feed" | "canvas", scope?: "channel" | "team" | "user" }
// where `channel === "__team__"` opens the team-wide view. `mode` and
// `scope` default to "feed" + "channel" so the existing call site
// (`new CustomEvent("aura:open-channel-notes", {...})`) opens the new
// timed feed by default. Users can flip to Canvas inside the panel.

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MonacoEditor } from "../MonacoEditor";
import { TiptapEditor } from "../notes/TiptapEditor";
import { api, type NoteDoc, type NoteEntry, type TeamIdentity, type TeamMember } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Mode = "feed" | "canvas";
type CanvasView = "rendered" | "source";
type FeedScope = "channel" | "team" | "user";

type CanvasTarget =
  | { kind: "channel"; channel: string }
  | { kind: "team" };

type Props = {
  repoRoot: string;
};

const TEAM_SENTINEL = "__team__";
const AUTOSAVE_DELAY_MS = 600;
const MAX_BODY_BYTES = 16 * 1024;

function canvasPath(target: CanvasTarget): string {
  if (target.kind === "team") return ".aura/team/notes.md";
  return `.aura/team/channels/${target.channel}.notes.md`;
}

function relativeTime(secs: number): string {
  if (!secs) return "never";
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - secs);
  if (delta < 10) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

// Scope → backend wire form
function scopeKey(scope: FeedScope, channel: string | null, handle: string): string {
  if (scope === "team") return "team";
  if (scope === "user") return `user:${handle}`;
  // Channel scope — fall back to team if we somehow opened on the team
  // sentinel; this matches the old canvas behaviour where __team__ flipped
  // to team-wide.
  if (!channel || channel === TEAM_SENTINEL) return "team";
  return `channel:${channel}`;
}

// Split body around @mentions for inline rendering. We re-use the same
// boundary rules the Rust side does: a mention must follow whitespace or
// start-of-string and contain `[a-zA-Z0-9_\-.]+`. Output is an alternating
// list of plain text / mention chunks.
type Chunk = { kind: "text"; value: string } | { kind: "mention"; handle: string };
function chunkBody(body: string): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  let buf = "";
  const flushText = () => {
    if (buf) {
      out.push({ kind: "text", value: buf });
      buf = "";
    }
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : body[i - 1];
      const boundary = /\s|\(|\[/.test(prev) || i === 0;
      if (boundary) {
        let j = i + 1;
        while (j < body.length && /[A-Za-z0-9_\-.]/.test(body[j])) j++;
        if (j > i + 1) {
          flushText();
          out.push({ kind: "mention", handle: body.slice(i + 1, j) });
          i = j;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flushText();
  return out;
}

export function ChannelNotesPanel({ repoRoot }: Props) {
  // open + routing — Feed mode was retired in v0.2.13; the panel is now
  // Canvas-only. We keep the `mode` state variable so the existing
  // header/event-handler code keeps compiling, but force every transition
  // back to "canvas" below.
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("canvas");
  const [channel, setChannel] = useState<string | null>(null);
  const [feedScope, setFeedScope] = useState<FeedScope>("channel");

  // identity + members (used to attribute new feed entries + mention chip)
  const [identity, setIdentity] = useState<TeamIdentity | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);

  // feed state
  const [entries, setEntries] = useState<NoteEntry[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [mentionPickerAnchor, setMentionPickerAnchor] = useState<number | null>(null);

  // canvas state
  const [body, setBody] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  // "rendered" is the Slack-style canvas view; "source" is the raw
  // markdown editor for power users. Defaults to rendered.
  const [canvasView, setCanvasView] = useState<CanvasView>("rendered");

  // misc
  const [, setTick] = useState(0);
  const saveTimer = useRef<number | null>(null);
  const fetchTokenRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selfHandle = identity?.handle ?? "";
  const selfName = identity?.name || identity?.handle || "you";

  const canvasTarget: CanvasTarget = useMemo(
    () =>
      channel && channel !== TEAM_SENTINEL
        ? { kind: "channel", channel }
        : { kind: "team" },
    [channel],
  );

  const effectiveScope = useMemo(
    () => scopeKey(feedScope, channel, selfHandle || "me"),
    [feedScope, channel, selfHandle],
  );

  const titleLabel = useMemo(() => {
    if (mode === "canvas") {
      return canvasTarget.kind === "team"
        ? "Notes — team canvas"
        : `Notes — #${canvasTarget.channel} canvas`;
    }
    if (feedScope === "team") return "Notes — team feed";
    if (feedScope === "user") return "Notes — your private feed";
    if (!channel || channel === TEAM_SENTINEL) return "Notes — team feed";
    return `Notes — #${channel} feed`;
  }, [mode, feedScope, channel, canvasTarget]);

  // ── open / close ────────────────────────────────────────────────────
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { repoRoot?: string; channel?: string; mode?: Mode; scope?: FeedScope }
        | undefined;
      if (!detail) return;
      const ch = detail.channel ?? TEAM_SENTINEL;
      setChannel(ch);
      // If the caller landed on the team sentinel we promote scope so the
      // user lands on a meaningful feed immediately.
      const nextScope: FeedScope =
        detail.scope ?? (ch === TEAM_SENTINEL ? "team" : "channel");
      setFeedScope(nextScope);
      // Force canvas mode regardless of what the opener asked for — Feed
      // mode was retired in v0.2.13.
      setMode("canvas");
      setOpen(true);
    };
    window.addEventListener("aura:open-channel-notes", onOpen as EventListener);
    return () =>
      window.removeEventListener(
        "aura:open-channel-notes",
        onOpen as EventListener,
      );
  }, []);

  const closePanel = useCallback(() => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setOpen(false);
    setEntries([]);
    setBody("");
    setUpdatedAt(0);
    setFeedError(null);
    setCanvasError(null);
    setDraft("");
    setMentionPickerAnchor(null);
  }, []);

  // ── identity + members ──────────────────────────────────────────────
  useEffect(() => {
    if (!open || !repoRoot) return;
    let cancelled = false;
    void (async () => {
      try {
        const [id, man] = await Promise.all([
          api.teamIdentity(repoRoot),
          api.teamLoad(repoRoot),
        ]);
        if (cancelled) return;
        setIdentity(id);
        setMembers(man.members ?? []);
      } catch {
        if (cancelled) return;
        // Non-fatal — feed still works, attribution falls back to "anon".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot]);

  // ── feed load ───────────────────────────────────────────────────────
  const loadFeed = useCallback(
    async (signalToken: number) => {
      if (!repoRoot) return;
      if (feedScope === "user" && !selfHandle) {
        // No identity yet — wait for the identity effect to surface a
        // handle, then re-fetch.
        return;
      }
      setFeedLoading(true);
      setFeedError(null);
      try {
        const list = await api.notesFeedList(repoRoot, effectiveScope);
        if (signalToken !== fetchTokenRef.current) return;
        // Surface oldest first so the latest sits at the bottom near the
        // composer — matches chat conventions.
        list.sort((a, b) => a.ts - b.ts);
        setEntries(list);
      } catch (err) {
        if (signalToken !== fetchTokenRef.current) return;
        setFeedError(String(err));
      } finally {
        if (signalToken !== fetchTokenRef.current) return;
        setFeedLoading(false);
      }
    },
    [repoRoot, effectiveScope, feedScope, selfHandle],
  );

  useEffect(() => {
    if (!open || mode !== "feed") return;
    const token = ++fetchTokenRef.current;
    void loadFeed(token);
  }, [open, mode, effectiveScope, loadFeed]);

  // Scroll to bottom whenever entries change (initial load + new posts).
  useEffect(() => {
    if (mode !== "feed") return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, mode]);

  // ── canvas load ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || mode !== "canvas" || !repoRoot) return;
    const token = ++fetchTokenRef.current;
    setCanvasLoading(true);
    setCanvasError(null);
    const fetcher: Promise<NoteDoc> =
      canvasTarget.kind === "team"
        ? api.teamNotesRead(repoRoot)
        : api.channelNotesRead(repoRoot, canvasTarget.channel);
    fetcher
      .then((doc) => {
        if (token !== fetchTokenRef.current) return;
        setBody(doc.body);
        setUpdatedAt(doc.updated_at);
      })
      .catch((err) => {
        if (token !== fetchTokenRef.current) return;
        setCanvasError(String(err));
      })
      .finally(() => {
        if (token !== fetchTokenRef.current) return;
        setCanvasLoading(false);
      });
  }, [open, mode, canvasTarget, repoRoot]);

  // ── relative-time tick ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [open]);

  // ── canvas save (debounced + Cmd/Ctrl+S) ────────────────────────────
  const doSave = useCallback(
    async (nextBody: string) => {
      if (!repoRoot) return;
      setSaving(true);
      try {
        const doc =
          canvasTarget.kind === "team"
            ? await api.teamNotesWrite(repoRoot, nextBody)
            : await api.channelNotesWrite(repoRoot, canvasTarget.channel, nextBody);
        setUpdatedAt(doc.updated_at);
        setCanvasError(null);
      } catch (err) {
        setCanvasError(String(err));
      } finally {
        setSaving(false);
      }
    },
    [repoRoot, canvasTarget],
  );

  const scheduleSave = useCallback(
    (nextBody: string) => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void doSave(nextBody);
      }, AUTOSAVE_DELAY_MS);
    },
    [doSave],
  );

  const onBodyChange = useCallback(
    (next: string) => {
      setBody(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  const forceSave = useCallback(() => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void doSave(body);
  }, [body, doSave]);

  // ── feed: post a new entry ──────────────────────────────────────────
  // Feed mode retired in v0.2.13; callback kept (prefixed) for future
  // resurrection. TS6133-suppressed via `_` prefix.
  const _postEntry = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || posting) return;
    if (trimmed.length > MAX_BODY_BYTES) {
      setFeedError("note is too long (max 16 KB)");
      return;
    }
    setPosting(true);
    setFeedError(null);
    const handle = selfHandle || "anon";
    const name = selfName || handle;
    try {
      const entry = await api.notesFeedAdd(
        repoRoot,
        effectiveScope,
        trimmed,
        handle,
        name,
      );
      setEntries((prev) => [...prev, entry]);
      setDraft("");
    } catch (err) {
      setFeedError(String(err));
    } finally {
      setPosting(false);
    }
  }, [draft, posting, repoRoot, effectiveScope, selfHandle, selfName]);

  const _deleteEntry = useCallback(
    async (id: string) => {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      try {
        await api.notesFeedDelete(repoRoot, effectiveScope, id);
      } catch (err) {
        setFeedError(String(err));
        // Refetch so the UI doesn't drift from disk.
        const token = ++fetchTokenRef.current;
        void loadFeed(token);
      }
    },
    [repoRoot, effectiveScope, loadFeed],
  );

  // ── mention picker (lightweight): typing "@" with no body after it
  // opens an inline list of team handles; clicking inserts. We don't
  // need full inline autocomplete with arrow-key cursor for v0.2.11 —
  // the chunked render below shows the @ chip immediately on send.
  const _onDraftChange = useCallback(
    (next: string, caret: number) => {
      setDraft(next);
      // Detect if caret sits in a partial `@` token.
      const before = next.slice(0, caret);
      const atMatch = before.match(/(?:^|\s|\(|\[)@([A-Za-z0-9_\-.]*)$/);
      if (atMatch) setMentionPickerAnchor(caret - atMatch[1].length - 1);
      else setMentionPickerAnchor(null);
    },
    [],
  );

  const mentionQuery = useMemo(() => {
    if (mentionPickerAnchor === null) return "";
    return draft.slice(mentionPickerAnchor + 1).toLowerCase();
  }, [draft, mentionPickerAnchor]);

  const _mentionCandidates = useMemo(() => {
    if (mentionPickerAnchor === null) return [];
    const q = mentionQuery;
    return members
      .filter((m) => m.handle)
      .filter((m) => !q || m.handle.toLowerCase().startsWith(q) || m.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, mentionPickerAnchor, mentionQuery]);

  const _insertMention = useCallback(
    (handle: string) => {
      if (mentionPickerAnchor === null) return;
      const before = draft.slice(0, mentionPickerAnchor);
      const afterStart = mentionPickerAnchor + 1 + mentionQuery.length;
      const after = draft.slice(afterStart);
      const next = `${before}@${handle} ${after}`;
      setDraft(next);
      setMentionPickerAnchor(null);
      // Restore focus and place caret after the inserted mention.
      requestAnimationFrame(() => {
        const ta = composerRef.current;
        if (!ta) return;
        const pos = before.length + handle.length + 2;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    },
    [draft, mentionPickerAnchor, mentionQuery],
  );

  // ── keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Don't swallow Esc when a mention picker is open — close that first.
        if (mentionPickerAnchor !== null) {
          setMentionPickerAnchor(null);
          return;
        }
        e.preventDefault();
        closePanel();
        return;
      }
      if (mode === "canvas" && (e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        forceSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, mode, closePanel, forceSave, mentionPickerAnchor]);

  // Dead Feed callbacks (retired v0.2.13); kept for resurrection.
  void [_postEntry, _deleteEntry, _onDraftChange, _mentionCandidates, _insertMention];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={closePanel}
        aria-hidden
      />
      <div
        className="relative ml-auto flex h-full w-full max-w-[560px] flex-col border-l border-line-soft bg-bg-chrome shadow-2xl"
        role="dialog"
        aria-label={titleLabel}
      >
        {/* ── header ────────────────────────────────────────────────── */}
        <header className="flex h-[56px] shrink-0 items-center gap-2 border-b border-line-soft px-3">
          <span className="text-base leading-none text-text-3" aria-hidden>
            {"\u{1F4DD}"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-1">
              {titleLabel}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-text-4">
              {mode === "canvas" ? (
                <>
                  {canvasLoading ? (
                    <span className="flex items-center gap-1.5">
                      <AsciiSpinner />
                      Loading…
                    </span>
                  ) : (
                    <span>Last edited: {relativeTime(updatedAt)}</span>
                  )}
                  {saving && (
                    <span
                      className="flex items-center gap-1.5"
                      aria-label="Saving"
                    >
                      <AsciiSpinner />
                      Saving…
                    </span>
                  )}
                  {canvasError && (
                    <span className="truncate text-red" title={canvasError}>
                      {canvasError}
                    </span>
                  )}
                </>
              ) : (
                <>
                  {feedLoading ? (
                    <span className="flex items-center gap-1.5">
                      <AsciiSpinner />
                      Loading…
                    </span>
                  ) : (
                    <span>
                      {entries.length} {entries.length === 1 ? "note" : "notes"}
                    </span>
                  )}
                  {feedScope === "user" && (
                    <span className="rounded bg-bg-2 px-1 text-[10px] uppercase tracking-wide text-text-3">
                      local-only
                    </span>
                  )}
                  {feedError && (
                    <span className="truncate text-red" title={feedError}>
                      {feedError}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
          {mode === "canvas" && (
            <>
              <div
                className="mr-1 flex items-center rounded border border-line-soft bg-bg-1 p-0.5 text-[10px]"
                role="group"
                aria-label="Canvas view"
              >
                <button
                  type="button"
                  onClick={() => setCanvasView("rendered")}
                  className={`rounded px-1.5 py-0.5 transition-colors ${
                    canvasView === "rendered"
                      ? "bg-bg-2 text-text-1"
                      : "text-text-3 hover:text-text-1"
                  }`}
                  title="Slack-style canvas view"
                >
                  Canvas
                </button>
                <button
                  type="button"
                  onClick={() => setCanvasView("source")}
                  className={`rounded px-1.5 py-0.5 transition-colors ${
                    canvasView === "source"
                      ? "bg-bg-2 text-text-1"
                      : "text-text-3 hover:text-text-1"
                  }`}
                  title="Raw markdown source"
                >
                  Source
                </button>
              </div>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded text-text-3 hover:bg-bg-2 hover:text-text-1"
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("aura:open-file", {
                      detail: { path: canvasPath(canvasTarget), line: 1 },
                    }),
                  );
                  closePanel();
                }}
                title="Open in editor"
                aria-label="Open in editor"
              >
                {"⤢"}
              </button>
            </>
          )}
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded text-text-3 hover:bg-bg-2 hover:text-text-1"
            onClick={closePanel}
            title="Close"
            aria-label="Close"
          >
            {"×"}
          </button>
        </header>

        {/* ── body — Canvas only (Feed/Team/Mine retired in v0.2.13) ── */}
        <div className="min-h-0 flex-1 overflow-hidden bg-bg-1">
          {canvasView === "source" ? (
            <MonacoEditor
              value={body}
              language="markdown"
              onChange={onBodyChange}
              filePath={canvasPath(canvasTarget)}
              repoRoot={repoRoot}
            />
          ) : (
            <TiptapEditor
              value={body}
              onChange={onBodyChange}
              bare
              placeholder={
                canvasTarget.kind === "team"
                  ? "Team-wide canvas — start typing."
                  : `Canvas for #${canvasTarget.channel} — start typing.`
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── presentational sub-components ───────────────────────────────────────
//
// Feed-mode UI (retired v0.2.13). Kept exported as `_` symbols so the
// code is preserved for potential resurrection without triggering
// TS6133 / no-unused-locals. Not referenced by the active Canvas-only
// surface.

export function _ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 text-[12px] transition-colors ${
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-3 hover:bg-bg-2/60 hover:text-text-1"
      }`}
    >
      {children}
    </button>
  );
}

export function _ScopeTab({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      className={`rounded px-2 py-1 text-[11px] transition-colors ${
        active
          ? "bg-accent-blue/20 text-text-1"
          : disabled
            ? "cursor-not-allowed text-text-4"
            : "text-text-3 hover:bg-bg-2/60 hover:text-text-1"
      }`}
    >
      {children}
    </button>
  );
}

export function _EmptyState({ scope, channel }: { scope: FeedScope; channel: string | null }) {
  let line: string;
  if (scope === "user") line = "Your private scratchpad — only stored on this machine.";
  else if (scope === "team") line = "Team-wide running log. Committed via git.";
  else if (channel && channel !== TEAM_SENTINEL) line = `Channel log for #${channel}. Committed via git.`;
  else line = "Open notes from a channel header to post here.";
  return (
    <div className="m-auto max-w-[320px] text-center text-xs text-text-4">
      <div className="mb-1 text-text-3">No notes yet.</div>
      <div>{line}</div>
    </div>
  );
}

export function _FeedRow({
  entry,
  isMine,
  selfHandle,
  onDelete,
}: {
  entry: NoteEntry;
  isMine: boolean;
  selfHandle: string;
  onDelete: () => void;
}) {
  const chunks = useMemo(() => chunkBody(entry.body), [entry.body]);
  const initials = useMemo(() => {
    const src = entry.author_name || entry.author_handle || "?";
    const parts = src.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }, [entry.author_name, entry.author_handle]);

  return (
    <div className="group flex gap-2 rounded px-1 py-1 hover:bg-bg-2/40">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-2 text-[10px] font-medium text-text-1">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-[12px]">
          <span className="font-medium text-text-1">{entry.author_name || entry.author_handle}</span>
          <span className="text-text-4">@{entry.author_handle}</span>
          <span className="text-text-4">·</span>
          <span className="text-text-4" title={new Date(entry.ts * 1000).toLocaleString()}>
            {relativeTime(entry.ts)}
          </span>
          {isMine && (
            <button
              type="button"
              onClick={onDelete}
              className="ml-auto opacity-0 transition-opacity hover:text-red group-hover:opacity-100"
              title="Delete note"
            >
              Delete
            </button>
          )}
        </div>
        <div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-text-1">
          {chunks.map((c, i) =>
            c.kind === "text" ? (
              <span key={i}>{c.value}</span>
            ) : (
              <span
                key={i}
                className={`rounded px-1 ${
                  selfHandle && c.handle.toLowerCase() === selfHandle.toLowerCase()
                    ? "bg-accent/15 text-accent"
                    : "bg-accent-blue/20 text-accent-blue"
                }`}
              >
                @{c.handle}
              </span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

type FeedComposerProps = {
  value: string;
  onChange: (next: string, caret: number) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
  mentionCandidates: TeamMember[];
  onInsertMention: (handle: string) => void;
};

export const _FeedComposer = forwardRef<HTMLTextAreaElement, FeedComposerProps>(
  function FeedComposer(
    { value, onChange, onSubmit, disabled, placeholder, mentionCandidates, onInsertMention },
    ref,
  ) {
    return (
      <div className="relative shrink-0 border-t border-line-soft bg-bg-chrome p-2">
        {mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 mb-1 max-h-[200px] overflow-y-auto rounded border border-line-soft bg-bg-1 shadow-lg">
            {mentionCandidates.map((m) => (
              <button
                key={m.handle}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onInsertMention(m.handle);
                }}
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] hover:bg-bg-2"
              >
                <span className="font-medium text-text-1">@{m.handle}</span>
                {m.name && m.name !== m.handle && (
                  <span className="text-text-4">{m.name}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={2}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) =>
            onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (!disabled && value.trim()) onSubmit();
            }
          }}
          className="w-full resize-none rounded border border-line-soft bg-bg-1 px-2 py-1.5 text-[13px] leading-snug text-text-1 placeholder:text-text-4 focus:border-accent-blue focus:outline-none disabled:opacity-50"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-text-4">
          <span>Enter to post · Shift+Enter for newline · @ to mention</span>
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            className="rounded bg-accent-blue px-2 py-0.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Post
          </button>
        </div>
      </div>
    );
  },
);

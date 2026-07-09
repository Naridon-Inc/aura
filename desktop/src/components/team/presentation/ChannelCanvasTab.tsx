/** Team (chat) presentation — the inline channel Canvas tab.
 *
 *  A Slack-style markdown canvas that replaces the message stream in the
 *  center column when the "Canvas" tab is active — the same way Files /
 *  Bookmarks swap in. (Previously the Canvas affordance fired a window
 *  event that slid a panel in from the far side of the screen; tabs are
 *  expected to replace the detail in place, so this hosts the canvas
 *  inline instead.)
 *
 *  Backed by `.aura/team/channels/<channel>.notes.md` via the same
 *  channel_notes_read / channel_notes_write commands the side-sheet used.
 *  Edits autosave on a short debounce; ⌘/Ctrl+S forces a flush. */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type NoteDoc } from "../../../lib/api";
import { ChannelCanvasView } from "../../chat/ChannelCanvasView";

const AUTOSAVE_DELAY_MS = 600;

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

export function ChannelCanvasTab({
  repoRoot,
  channel,
  channelName,
  selfHandle,
}: {
  repoRoot: string;
  /** Channel slug the canvas is scoped to, or null for the team-wide doc. */
  channel: string | null;
  channelName: string;
  selfHandle: string;
}) {
  const [body, setBody] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveTimer = useRef<number | null>(null);
  const fetchTokenRef = useRef(0);

  const isTeam = !channel;

  // ── load ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!repoRoot) return;
    const token = ++fetchTokenRef.current;
    setLoading(true);
    setError(null);
    const fetcher: Promise<NoteDoc> = isTeam
      ? api.teamNotesRead(repoRoot)
      : api.channelNotesRead(repoRoot, channel!);
    fetcher
      .then((doc) => {
        if (token !== fetchTokenRef.current) return;
        setBody(doc.body);
        setUpdatedAt(doc.updated_at);
      })
      .catch((err) => {
        if (token !== fetchTokenRef.current) return;
        setError(String(err));
      })
      .finally(() => {
        if (token !== fetchTokenRef.current) return;
        setLoading(false);
      });
    return () => {
      // Flush any pending save when the channel changes / tab unmounts.
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [repoRoot, channel, isTeam]);

  // ── save (debounced + ⌘S) ───────────────────────────────────────────
  const doSave = useCallback(
    async (next: string) => {
      if (!repoRoot) return;
      setSaving(true);
      try {
        const doc = isTeam
          ? await api.teamNotesWrite(repoRoot, next)
          : await api.channelNotesWrite(repoRoot, channel!, next);
        setUpdatedAt(doc.updated_at);
        setError(null);
      } catch (err) {
        setError(String(err));
      } finally {
        setSaving(false);
      }
    },
    [repoRoot, channel, isTeam],
  );

  const onBodyChange = useCallback(
    (next: string) => {
      setBody(next);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void doSave(next);
      }, AUTOSAVE_DELAY_MS);
    },
    [doSave],
  );

  // ⌘/Ctrl+S forces an immediate flush.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (saveTimer.current !== null) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        void doSave(body);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [body, doSave]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-1">
      <div className="flex-shrink-0 flex items-center gap-2 px-3 h-7 text-[10.5px] text-text-4 border-b border-line-soft">
        <span aria-hidden>📝</span>
        <span className="truncate">
          {isTeam ? "Team canvas" : `#${channelName} canvas`}
        </span>
        <span className="text-text-5">·</span>
        <span>{loading ? "Loading…" : `Last edited ${relativeTime(updatedAt)}`}</span>
        {saving && (
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-text-4"
            aria-label="Saving"
          />
        )}
        {error && (
          <span className="truncate text-red-400" title={error}>
            {error}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ChannelCanvasView
          value={body}
          onChange={onBodyChange}
          selfHandle={selfHandle}
          placeholder={
            isTeam
              ? "Team-wide canvas — start typing."
              : `Canvas for #${channelName} — start typing.`
          }
        />
      </div>
    </div>
  );
}

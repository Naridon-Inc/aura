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
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { TiptapEditor } from "../../notes/TiptapEditor";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";

const AUTOSAVE_DELAY_MS = 600;

function relativeTime(secs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(secs, { empty: "never" });
}

export function ChannelCanvasTab({
  repoRoot,
  channel,
  channelName,
}: {
  repoRoot: string;
  /** Channel slug the canvas is scoped to, or null for the team-wide doc. */
  channel: string | null;
  channelName: string;
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
      <div className="flex-shrink-0 flex items-center gap-2 px-3 h-7 text-xs text-text-4 border-b border-line-soft">
        <span aria-hidden>📝</span>
        <span className="truncate">
          {isTeam ? "Team canvas" : `#${channelName} canvas`}
        </span>
        <span className="text-text-5">·</span>
        {loading ? (
          <span className="flex items-center gap-1.5">
            <AsciiSpinner className="text-xs" />
            Loading…
          </span>
        ) : (
          <span>Last edited {relativeTime(updatedAt)}</span>
        )}
        {saving && (
          <span className="flex items-center" aria-label="Saving">
            <AsciiSpinner className="text-xs" />
          </span>
        )}
        {error && (
          <span className="ml-auto truncate text-red" title={error}>
            couldn’t save
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <TiptapEditor
          value={body}
          onChange={onBodyChange}
          bare
          placeholder={
            isTeam
              ? "Team-wide canvas. Start typing."
              : `Canvas for #${channelName}. Start typing.`
          }
        />
      </div>
    </div>
  );
}

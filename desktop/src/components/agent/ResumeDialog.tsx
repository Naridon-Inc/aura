// Native /resume picker for Claude Code stream-mode tabs. Reads the
// session list straight off `~/.claude/projects/<encoded-cwd>/*.jsonl`
// (no TUI hop), surfaces it in the shared command dialog, and pins the
// chosen session id into the stream store — the next prompt fires with
// `--resume <id>`.
//
// The on-disk transcript is replayed into the bubble view after the pick so
// the pane isn't empty; the conversation itself carries on server-side.

import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeSession } from "../../lib/api";
import { refreshSessions } from "../../lib/sessionsCache";
import { setResumedHistory, setResumeSession } from "../../lib/agentStreamStore";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { sessionPromptTitle } from "../../lib/sessionPromptTitle";
import { Button } from "../ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { ErrorState, LoadingState } from "../ui/state";
import "../ui/resume-dialog.css";

type Props = {
  channel: string;
  repoRoot: string;
  open: boolean;
  onClose: () => void;
  /** Fired right after the user picks a session — the host should
   *  spawn (or focus) the agent's stream tab so the SessionInfoCard
   *  appears immediately and the next prompt has a place to send. */
  onResumed?: (session: ClaudeSession) => void;
};

// Sessions older than this sit behind "Show older". Tuned to 24h because the
// picker is for resuming work in progress; a day-old transcript almost
// certainly belongs to a different task.
const STALE_THRESHOLD_SECS = 24 * 60 * 60;

function isStale(s: ClaudeSession, nowSec: number): boolean {
  return s.mtime > 0 && nowSec - s.mtime > STALE_THRESHOLD_SECS;
}

export function ResumeDialog({ channel, repoRoot, open, onClose, onResumed }: Props) {
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Fresh sessions only by default — the picker used to be dominated by
  // hours-old transcripts nobody wanted to resume.
  const [showOlder, setShowOlder] = useState(false);
  // Rows dismissed with Hide. The JSONL on disk is Claude Code's own file and
  // is never touched; a reopen shows everything again.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSessions(null);
    setError(null);
    setQuery("");
    setHidden(new Set());
    refreshSessions(repoRoot)
      .then(setSessions)
      .catch((e) => setError(String(e)));
  }, [open, repoRoot]);

  const { fresh, stale } = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const shown = (sessions ?? []).filter((s) => !hidden.has(s.session_id));
    return {
      fresh: shown.filter((s) => !isStale(s, nowSec)),
      stale: shown.filter((s) => isStale(s, nowSec)),
    };
  }, [sessions, hidden]);

  function pick(s: ClaudeSession) {
    setResumeSession(channel, s);
    onResumed?.(s);
    onClose();
    // Replay the on-disk transcript into the bubble view so the user sees
    // what they were doing instead of an empty pane. A failure is non-fatal —
    // the live session still continues server-side.
    api
      .claudeLoadSession(s.file_path, 500)
      .then((events) => setResumedHistory(channel, events))
      .catch((e) => console.warn("claude_load_session failed:", e));
  }

  function hide(id: string) {
    setHidden((prev) => new Set(prev).add(id));
  }

  const workspace = repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
  const none = sessions !== null && sessions.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Resume a Claude session"
      description={`Pick a past Claude session in ${workspace} and press Enter to carry on from it.`}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={`Resume a Claude session in ${workspace}…`}
        aria-label="Find a session"
      />
      <CommandList className="ui-resume-list">
        {error ? (
          <ErrorState size="sm" title="Couldn’t read past sessions" message={error} />
        ) : sessions === null ? (
          <LoadingState label="Finding your past sessions…" />
        ) : none ? (
          <div className="ui-command-empty">No past Claude sessions in this workspace.</div>
        ) : (
          <>
            <CommandEmpty>No session matches.</CommandEmpty>
            {fresh.length > 0 && (
              <CommandGroup heading="Last 24 hours">
                {fresh.map((s) => (
                  <SessionRow key={s.session_id} session={s} onPick={pick} onHide={hide} />
                ))}
              </CommandGroup>
            )}
            {showOlder && stale.length > 0 && (
              <CommandGroup heading="Older">
                {stale.map((s) => (
                  <SessionRow key={s.session_id} session={s} onPick={pick} onHide={hide} stale />
                ))}
              </CommandGroup>
            )}
            {stale.length > 0 && (
              <CommandGroup forceMount>
                <CommandItem
                  forceMount
                  value="__older"
                  onSelect={() => setShowOlder((v) => !v)}
                  className="ui-resume-older"
                >
                  {showOlder
                    ? "Hide sessions older than a day"
                    : `Show ${stale.length} ${stale.length === 1 ? "session" : "sessions"} older than a day`}
                </CommandItem>
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function SessionRow({
  session: s,
  onPick,
  onHide,
  stale,
}: {
  session: ClaudeSession;
  onPick: (s: ClaudeSession) => void;
  onHide: (id: string) => void;
  stale?: boolean;
}) {
  // The last prompt names a session far better than the first (most open
  // with "hi"); the first is the fallback for an interrupted one. Both go
  // through sessionPromptTitle so task-notification XML never becomes a title.
  const last = sessionPromptTitle(s.last_prompt);
  const first = sessionPromptTitle(s.first_prompt);
  const title = last || first;
  const meta = [
    s.cwd_rel || null,
    s.session_id.slice(0, 8),
    `${s.turn_count} ${s.turn_count === 1 ? "turn" : "turns"}`,
    relativeAgeFromSecs(s.mtime),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <CommandItem
      value={`${title} ${first} ${s.cwd_rel ?? ""} ${s.session_id}`}
      onSelect={() => onPick(s)}
      className="ui-resume-row"
      data-stale={stale ? "" : undefined}
      title={first && last && first !== last ? `Started with: ${first}` : undefined}
    >
      <span className="ui-resume-label">
        {title || <em>Empty session</em>}
        <small>{meta}</small>
      </span>
      <Button
        size="xs"
        variant="ghost"
        className="ui-resume-hide"
        title="Hide from this list (the transcript stays on disk)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onHide(s.session_id);
        }}
      >
        Hide
      </Button>
    </CommandItem>
  );
}

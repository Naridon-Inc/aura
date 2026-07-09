// Native /resume picker for Claude Code stream-mode tabs. Reads the
// session list straight off `~/.claude/projects/<encoded-cwd>/*.jsonl`
// (no TUI hop), surfaces it as a list of conversations the user can
// pick from, and pins the chosen session id into the stream store —
// the next prompt fires with `--resume <id>`.
//
// The actual resumption is lazy: we don't replay the full session into
// the bubble view (that would cost a lot of tokens to re-render and
// the user already knows what they were doing). Instead we push a
// synthetic system bubble like "↺ resumed session <id>" so the user
// sees confirmation, then their next message threads onto the existing
// conversation server-side.

import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeSession } from "../../lib/api";
import { setResumedHistory, setResumeSession } from "../../lib/agentStreamStore";

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

// Sessions older than this are considered stale and hidden behind the
// "Show older" toggle. Tuned to 24h because the dialog is meant for
// resuming work-in-progress; a day-old transcript almost certainly
// belongs to a different task. The same cap is reused on the Cleanup
// affordance so the two filters agree on what "old" means.
const STALE_THRESHOLD_SECS = 24 * 60 * 60;

export function ResumeDialog({ channel, repoRoot, open, onClose, onResumed }: Props) {
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  // Default to "fresh sessions only" — the user reported the picker was
  // dominated by hours-old transcripts they didn't want to resume. The
  // toggle below brings older rows back when explicitly requested.
  const [showOlder, setShowOlder] = useState(false);
  // IDs the user has dismissed via the Cleanup affordance. We do NOT
  // delete the underlying JSONL (those are Claude Code's own files);
  // we just hide the row for this session of the dialog. Reopens
  // re-show everything from disk, which is the correct "Claude owns
  // these files" semantics.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSessions(null);
    setError(null);
    setActiveIdx(0);
    setHidden(new Set());
    api
      .claudeListSessions(repoRoot)
      .then(setSessions)
      .catch((e) => setError(String(e)));
  }, [open, repoRoot]);

  // Split the list into fresh (≤24h) vs stale. Counts in the strip
  // header tell the user what's behind the "Show older" toggle so they
  // don't think the dialog is missing sessions.
  const { stale, visible } = useMemo(() => {
    const all = sessions ?? [];
    const nowSec = Math.floor(Date.now() / 1000);
    const isStale = (s: ClaudeSession) =>
      s.mtime > 0 && nowSec - s.mtime > STALE_THRESHOLD_SECS;
    const freshList = all.filter((s) => !isStale(s) && !hidden.has(s.session_id));
    const staleList = all.filter((s) => isStale(s) && !hidden.has(s.session_id));
    return {
      stale: staleList,
      visible: showOlder ? [...freshList, ...staleList] : freshList,
    };
  }, [sessions, showOlder, hidden]);

  // Reset cursor when the visible list changes shape (filter toggle,
  // dismiss). Without this an "Enter" key with an out-of-range cursor
  // would pick the wrong row or no-op silently.
  useEffect(() => {
    if (activeIdx >= visible.length) setActiveIdx(0);
  }, [visible.length, activeIdx]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (visible.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(visible.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const target = visible[activeIdx];
        if (target) pick(target);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, visible, activeIdx]);

  function pick(s: ClaudeSession) {
    setResumeSession(channel, s);
    onResumed?.(s);
    onClose();
    // Replay the on-disk transcript into the bubble view so the user
    // sees what they were doing instead of an empty pane. Failures
    // are non-fatal — the live session can still continue server-side.
    api
      .claudeLoadSession(s.file_path, 500)
      .then((events) => setResumedHistory(channel, events))
      .catch((e) => console.warn("claude_load_session failed:", e));
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[70vh] bg-bg-2 border border-line rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 h-10 px-3 border-b border-line-soft bg-bg-chrome">
          <span className="text-text-1 text-[12.5px] font-medium">Resume Claude session</span>
          <span className="text-text-5 text-[10.5px] font-mono truncate">
            {shortRoot(repoRoot)}
          </span>
          {stale.length > 0 && (
            <button
              type="button"
              onClick={() => setShowOlder((v) => !v)}
              title={
                showOlder
                  ? "Hide sessions older than 24 hours"
                  : `Show ${stale.length} older session${stale.length === 1 ? "" : "s"} (>24h)`
              }
              className={`ml-2 text-[10.5px] px-2 h-6 rounded transition-colors ${
                showOlder
                  ? "bg-bg-card text-text-1 hover:bg-bg-hover"
                  : "text-text-4 hover:text-text-1 hover:bg-bg-1"
              }`}
            >
              {showOlder ? "Hide older" : `Show older · ${stale.length}`}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-text-4 hover:text-text-1 text-[11px] px-2 h-6 rounded hover:bg-bg-1 transition-colors"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {sessions === null && !error && (
            <div className="p-6 text-text-4 text-[12px]">loading sessions…</div>
          )}
          {error && (
            <div className="p-6 text-red text-[12px] font-mono whitespace-pre-wrap">
              {error}
            </div>
          )}
          {sessions && sessions.length === 0 && (
            <div className="p-6 text-text-4 text-[12px]">
              no past Claude Code sessions for this workspace.
            </div>
          )}
          {sessions && sessions.length > 0 && visible.length === 0 && (
            <div className="p-6 text-text-4 text-[12px] flex flex-col gap-2 items-start">
              <span>
                All sessions for this workspace are older than 24h.
              </span>
              {stale.length > 0 && !showOlder && (
                <button
                  type="button"
                  onClick={() => setShowOlder(true)}
                  className="text-[11.5px] text-accent hover:underline"
                >
                  Show {stale.length} older session{stale.length === 1 ? "" : "s"} ↗
                </button>
              )}
            </div>
          )}
          {visible.length > 0 && (
            <ul>
              {visible.map((s, i) => {
                // Prefer the last user prompt — most sessions open with
                // "hi" or "test" and the *last* thing the user typed is
                // far more identifying. Fall back to first if there's
                // no last (interrupted session). Both go through
                // cleanPrompt: scheduled-task / autonomous-loop turns
                // arrive as raw <task-notification> XML and would
                // otherwise dominate the row.
                const lastClean = cleanPrompt(s.last_prompt);
                const firstClean = cleanPrompt(s.first_prompt);
                const title = lastClean || firstClean;
                const nowSec = Math.floor(Date.now() / 1000);
                const isStale =
                  s.mtime > 0 && nowSec - s.mtime > STALE_THRESHOLD_SECS;
                return (
                  <li
                    key={s.session_id}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => pick(s)}
                    className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer border-b border-line-soft/50 group ${
                      i === activeIdx ? "bg-bg-card" : "hover:bg-bg-hover"
                    } ${isStale ? "opacity-70" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-text-1 text-[12.5px] truncate flex items-center gap-2">
                        {isStale && (
                          <span
                            title="Last activity > 24h ago"
                            className="text-[9.5px] uppercase tracking-wider text-text-4 border border-line-soft rounded px-1 py-0.5 flex-shrink-0"
                          >
                            stale
                          </span>
                        )}
                        <span className="truncate">
                          {title || (
                            <span className="text-text-4 italic">empty session</span>
                          )}
                        </span>
                      </div>
                      {/* Show the leading prompt as a quieter subtitle when
                          it differs from the title — gives the user
                          context for what the conversation started about. */}
                      {firstClean &&
                        lastClean &&
                        firstClean !== lastClean && (
                          <div className="text-text-4 text-[11px] truncate mt-0.5">
                            ↳ first: {firstClean}
                          </div>
                        )}
                      <div className="flex items-center gap-2 mt-1 text-[10.5px]">
                        {s.cwd_rel && (
                          <span
                            className="font-mono px-1.5 py-px rounded text-text-3"
                            style={{ background: "var(--color-bg-2)" }}
                            title={`cwd · ${s.cwd_rel}`}
                          >
                            {s.cwd_rel}
                          </span>
                        )}
                        <span className="text-text-5 font-mono">
                          {s.session_id.slice(0, 8)}
                        </span>
                        <span className="text-text-5">·</span>
                        <span className="text-text-4 tabular-nums">
                          {s.turn_count} turn{s.turn_count === 1 ? "" : "s"}
                        </span>
                        <span className="text-text-5">·</span>
                        <span className="text-text-5">{relAge(s.mtime)}</span>
                      </div>
                    </div>
                    {/* Cleanup affordance: hide a row the user has decided
                        is dead. We never touch the underlying JSONL on
                        disk — those are Claude Code's own files and
                        deleting them silently would lose the transcript
                        for /resume in the native CLI. */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setHidden((prev) => {
                          const next = new Set(prev);
                          next.add(s.session_id);
                          return next;
                        });
                      }}
                      title="Hide this session from the picker (keeps the on-disk transcript)"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-text-4 hover:text-red text-[10.5px] px-1.5 py-0.5 rounded hover:bg-bg-hover flex-shrink-0 self-center"
                    >
                      hide
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center gap-2 h-9 px-3 border-t border-line-soft text-[10.5px] text-text-5">
          <span>↑↓ navigate</span>
          <span>↵ resume</span>
          <span>esc close</span>
        </footer>
      </div>
    </div>
  );
}

function shortRoot(root: string): string {
  const parts = root.split("/").filter(Boolean);
  if (parts.length <= 2) return root;
  return ".../" + parts.slice(-2).join("/");
}

// Strip system-injected XML wrappers (autonomous-loop / scheduled-task /
// system-reminder / command-name turns) so the dialog row shows something
// the user can recognize. The raw payloads are 200+ char XML blobs that
// dominate the row otherwise. Falls back to a quiet label when there's
// nothing meaningful inside the wrapper.
function cleanPrompt(s: string | null | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  if (!trimmed) return "";

  // <task-notification> from ScheduleWakeup / scheduled-task fires.
  if (/^<task-notification[\s>]/i.test(trimmed)) {
    const summary = trimmed.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summary && summary[1].trim()) return `↻ scheduled · ${collapse(summary[1])}`;
    return "↻ scheduled task";
  }

  // <task> from agent dispatch.
  if (/^<task[\s>]/i.test(trimmed)) {
    const desc = trimmed.match(/<description>([\s\S]*?)<\/description>/i);
    if (desc && desc[1].trim()) return `▶ task · ${collapse(desc[1])}`;
    return "▶ subagent task";
  }

  // <command-name> — slash-command dispatch.
  if (/^<command-name>/i.test(trimmed)) {
    const cmd = trimmed.match(/<command-name>([\s\S]*?)<\/command-name>/i);
    if (cmd && cmd[1].trim()) return `/ ${collapse(cmd[1])}`;
    return "/ command";
  }

  // <system-reminder> — runtime nag, not a real prompt.
  if (/^<system-reminder>/i.test(trimmed)) {
    return "(system reminder)";
  }

  // Autonomous-loop sentinel.
  if (trimmed.includes("<<autonomous-loop")) {
    return "↻ autonomous loop";
  }

  // Generic XML opener — keep the user from seeing raw markup.
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.includes("</")) {
    return "(system message)";
  }

  return collapse(trimmed);
}

function collapse(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= 160) return flat;
  return flat.slice(0, 157) + "…";
}

function relAge(unixSecs: number): string {
  const ageS = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (ageS < 60) return `${ageS}s ago`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
  return `${Math.floor(ageS / 86400)}d ago`;
}

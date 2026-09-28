// Feed a Claude PTY tab's Chat view from the transcript the CLI is writing.
//
// Claude's own session log is live-tailed so the Chat view stays in sync with
// what the user types into the terminal: the backend watcher emits
// StreamEvents on `claude-session:<sid>`, and they are forwarded into the
// workspace activity channel and this tab's own transcript channel.
//
// WHICH log is the whole question. The CLI says so itself — Claude Code keeps a
// per-process registry the backend reads (`agentPtyClaudeSession`) — and this
// hook keeps asking, so a `/resume` or `/clear` typed into the terminal moves
// the chat with it. Before, the tab picked a file once on mount and tailed it
// forever, and after a `/resume` the terminal and the chat of one tab showed
// two different conversations.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type StreamEvent } from "../../lib/api";
import { refreshSessions } from "../../lib/sessionsCache";
import type { AgentTab } from "../../lib/editorStore";
import { useEditorStore } from "../../lib/editorStore";
import { isOwnWorktreeSession } from "../../lib/agentSessionScope";
import {
  getChannelEvents,
  persistLastSession,
  pushEvent,
  setResumedHistory,
} from "../../lib/agentStreamStore";
import {
  followClaudeSession,
  NO_BINDING,
  needsReplay,
  noteTranscriptSession,
  transcriptSessionOf,
  type ChatBinding,
} from "../../lib/claudeSessionFollow";

export function useClaudeTranscript(
  tab: AgentTab,
  channel: string,
  transcriptChannel: string,
) {
  const store = useEditorStore();

  useEffect(() => {
    if (tab.agentId !== "claude") return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let stopFollow: (() => void) | null = null;
    // Holds the in-flight watch-registration promise so cleanup can
    // sequence the unwatch *after* it settles. A bare boolean would miss
    // the window where the tab unmounts mid-`await` (flag still false →
    // unwatch skipped → backend polling task leaks).
    let watchStarted: Promise<unknown> | null = null;

    // Without a word from the CLI (a daemon-backed tab, an older Claude Code,
    // or a CLI that has not registered yet) the tab falls back to the
    // transcript list. Follow/bind ONLY a session launched from THIS worktree.
    // The list unions sibling worktrees + the main checkout, and binding to a
    // sibling's newest file is exactly what made a `granada` tab silently
    // reopen `zagreb`'s conversation. If this tab resumed a known own
    // session, that file is ours by id. Otherwise (a fresh tab) take this
    // worktree's newest own session that no sibling tab already claims, so
    // two fresh tabs launched together don't both grab the one newest file.
    const fromSessionList = async (): Promise<ChatBinding | null> => {
      const list = await refreshSessions(tab.repoRoot);
      const takenBySiblings = new Set(
        store.agentTabs
          .filter(
            (x) => x.sessionId !== tab.sessionId && x.repoRoot === tab.repoRoot,
          )
          .map((x) => x.resumeSessionId)
          .filter((v): v is string => !!v),
      );
      const boundOwn = tab.resumeSessionId
        ? list.find(
            (s) =>
              s.session_id === tab.resumeSessionId &&
              isOwnWorktreeSession(s, tab.repoRoot),
          )
        : undefined;
      const mine =
        boundOwn ??
        list.find(
          (s) =>
            isOwnWorktreeSession(s, tab.repoRoot) &&
            !takenBySiblings.has(s.session_id),
        ) ??
        list.find((s) => isOwnWorktreeSession(s, tab.repoRoot));
      // Nothing authored in this worktree yet (e.g. claude is still writing
      // its first line, or the tab is on a sibling's convo we won't adopt) —
      // leave the tab unbound rather than stamp a foreign session onto it.
      return mine ? { sessionId: mine.session_id, filePath: mine.file_path } : null;
    };

    const probe = () => api.agentPtyClaudeSession(tab.sessionId);

    // Point the Chat view at `target`. `first` is the mount-time bind; every
    // later call is the CLI having changed conversation under the tab.
    const bindTo = async (target: ChatBinding, first: boolean) => {
      // Stamp the DURABLE per-tab binding. Unlike the channel pin (shared by
      // every same-repo Claude tab), this rides on the tab itself and is
      // persisted with it — so "Start all" and a restart reopen the
      // conversation the CLI was last in, not the one the tab first opened.
      store.bindAgentResumeSession(tab.sessionId, target.sessionId);
      // The CLI has left the transcript being tailed; stop reading it before
      // the chat is refilled, so nothing from the old conversation lands on
      // top of the new one.
      if (!first) await api.claudeSessionUnwatch(tab.sessionId).catch(() => {});
      if (cancelled) return;
      if (!target.filePath) {
        // Claude writes the transcript with the first prompt, so right after
        // `/clear` (or on a fresh start) the conversation is real but empty.
        // Show it empty; the follow loop binds the file once it exists.
        if (transcriptSessionOf(transcriptChannel) !== target.sessionId) {
          setResumedHistory(transcriptChannel, []);
          noteTranscriptSession(transcriptChannel, target.sessionId);
        }
        return;
      }
      // Pin this tab's live session so a later shell restart resumes exactly
      // it (the mount-resume effect reads this first).
      persistLastSession(channel, {
        session_id: target.sessionId,
        file_path: target.filePath,
      });
      // Seed the bubble view with the session's EXISTING transcript before the
      // live watcher attaches. `claudeSessionWatch` only emits lines appended
      // after the point this tab was last read to, so without the seed a
      // remount (the in-memory channel is dropped on unmount — 5-min idle-drop,
      // or immediately on respawn) leaves the chat blank: the "starting from
      // zero" loss. A channel that still holds THIS conversation is kept, so a
      // brief detach or a live in-flight turn is never clobbered; one holding
      // another conversation is exactly what has to be replaced. Re-checked
      // after the await, since the live wire may have populated it meanwhile.
      const replay = () =>
        needsReplay(
          getChannelEvents(transcriptChannel).length,
          transcriptSessionOf(transcriptChannel),
          target.sessionId,
        );
      if (replay()) {
        try {
          // `tab.sessionId` goes to both this read and the watcher below:
          // the backend records how far this read got, and the watcher
          // resumes from exactly there.
          const history = await api.claudeLoadSession(
            target.filePath,
            undefined,
            tab.sessionId,
          );
          if (cancelled) return;
          if (replay()) setResumedHistory(transcriptChannel, history);
          // The workspace activity channel is shared by every same-repo tab;
          // it is only seeded when empty and never rewritten by one tab.
          if (first && getChannelEvents(channel).length === 0)
            setResumedHistory(channel, history);
        } catch {
          /* best-effort — a missing/locked file just means no pre-roll */
        }
        if (cancelled) return;
      }
      noteTranscriptSession(transcriptChannel, target.sessionId);
      watchStarted = api.claudeSessionWatch(tab.sessionId, target.filePath);
      await watchStarted;
    };

    (async () => {
      // Tiny grace period — gives claude a moment to register itself and
      // write its first line.
      await new Promise((r) => setTimeout(r, 500));
      if (cancelled) return;
      try {
        unlisten = await listen<StreamEvent>(
          `claude-session:${tab.sessionId}`,
          (e) => {
            pushEvent(channel, e.payload);
            pushEvent(transcriptChannel, e.payload, { passive: true });
          },
        );
        if (cancelled) {
          unlisten?.();
          return;
        }
        const live = await probe().catch(() => null);
        const initial = live
          ? { sessionId: live.session_id, filePath: live.file_path }
          : await fromSessionList();
        if (cancelled) return;
        if (initial) await bindTo(initial, true);
        if (cancelled) return;
        stopFollow = followClaudeSession({
          initial: initial ?? NO_BINDING,
          probe,
          rebind: (next) => bindTo(next, false),
        });
      } catch {
        /* best-effort */
      }
    })();

    return () => {
      cancelled = true;
      stopFollow?.();
      unlisten?.();
      // Sequence the unwatch *after* the registration settles. If the tab
      // unmounts while `claudeSessionWatch` is still in flight, firing
      // unwatch now would either no-op (watcher not yet in the map) or be
      // skipped entirely — both leak the 500ms polling task, which keeps
      // tailing the JSONL and pushing to cloud for the app's lifetime.
      // Chaining off the promise guarantees watch-then-unwatch ordering.
      if (watchStarted) {
        watchStarted
          .catch(() => {})
          .then(() => api.claudeSessionUnwatch(tab.sessionId))
          .catch(() => {});
      }
    };
    // `store` and `tab.resumeSessionId` are read at bind time on purpose: the
    // follow loop itself rewrites the binding, and re-running this effect on
    // that write would tear the tail down and rebuild it every switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId, tab.repoRoot, tab.agentId, channel, transcriptChannel]);
}

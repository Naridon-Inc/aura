//! Earlier conversations, one click from the composer. Lists every Aura
//! conversation in this workspace (live and saved, most recent first) and the
//! Claude Code sessions that can be brought in as a native chat. Picking one
//! opens it in the centre pane. `/resume` and the chat tab's "Chat history"
//! item open the same menu through `openChatHistory`, addressed to their own
//! conversation so a second mounted chat doesn't open its menu too.
//!
//! Inside Aura's panel on Home (a `ChatHost` with scope "aura") it lists every
//! conversation instead, wherever it was started, each row naming the
//! project(s) it covers — and a pick switches the panel rather than opening a
//! tab behind Home. Claude Code imports are a workspace's business, so the
//! panel leaves them out.

import { useCallback, useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { Button } from "../../ui/button";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { AgentIcon } from "../../agent/AgentIcon";
import { api, type ClaudeSession, type ManagerSummary } from "../../../lib/api";
import { useEditorStore } from "../../../lib/editorStore";
import { stripSteeringDirective } from "../../../lib/steeringDirective";
import { fetchSessions } from "../../../lib/sessionsCache";
import { fetchManagerList } from "../../../lib/managerCache";
import { relativeAgeFromDelta } from "../../../lib/relativeTime";
import { useChatHost } from "./chatHost";
import { OPEN_HISTORY_EVENT, historyRequestIsFor, isOnScreen } from "../../../lib/chatHistoryEvent";
import { projectsCaption, projectsTooltip } from "../../../lib/conversationProjects";
import { shortDateFromSecs } from "../../../lib/calendarDate";
import "../../ui/chat-surface.css";

/** Compact age for a row: relative inside a week, a date past it. */
function relTime(secs: number): string {
  const delta = Math.max(0, Date.now() / 1000 - secs);
  if (delta >= 604800) return shortDateFromSecs(secs);
  return relativeAgeFromDelta(delta);
}

export function ChatHistoryMenu({
  currentSessionId,
  repoRoot,
}: {
  currentSessionId: string | null;
  repoRoot: string | null;
}) {
  const editor = useEditorStore();
  const host = useChatHost();
  const auraScope = host?.scope === "aura";
  const openSession = (id: string, label: string) =>
    host ? host.openSession(id, label) : editor.openManager(id, label);
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ManagerSummary[] | null>(null);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    // Scoped to the open workspace: a conversation from another workspace
    // must never appear here, let alone be resumed into. The read joins the
    // one the sidebar's recents strip already has in flight.
    setSessions(null);
    // Aura's panel: every conversation, wherever it was started. Each row
    // names its projects, so nothing has to be hidden to stay legible.
    fetchManagerList(auraScope ? null : repoRoot)
      .then(setSessions)
      .catch(() => setSessions([]));
    if (repoRoot && !auraScope) {
      setClaudeSessions(null);
      fetchSessions(repoRoot)
        .then(setClaudeSessions)
        .catch(() => setClaudeSessions([]));
    } else {
      setClaudeSessions([]);
    }
  }, [repoRoot, auraScope]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!historyRequestIsFor(detail, currentSessionId, isOnScreen(triggerRef.current))) return;
      setOpen(true);
      load();
    };
    window.addEventListener(OPEN_HISTORY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_HISTORY_EVENT, onOpen);
  }, [load, currentSessionId]);

  const onOpenChange = (next: boolean) => {
    if (next) load();
    setOpen(next);
  };

  const pick = (s: ManagerSummary) => {
    openSession(s.id, stripSteeringDirective(s.objective ?? "").trim() || "Aura");
  };

  // Import a Claude Code transcript into a fresh native Aura conversation,
  // then open it the same way as an existing one.
  const importClaude = (sess: ClaudeSession) => {
    if (!repoRoot || importing) return;
    setImporting(sess.session_id);
    api
      .managerImportAgentSession("claude", repoRoot, sess.session_id)
      .then((newSid) => {
        // Named after what the conversation was about; "Aura" otherwise,
        // because it is a native Aura conversation now.
        const label = (sess.last_prompt || sess.first_prompt || "").trim().slice(0, 80);
        openSession(newSid, label || "Aura");
        setOpen(false);
      })
      .catch((e) => console.warn("[manager] import claude session failed", e))
      .finally(() => setImporting(null));
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          size="icon-sm"
          variant="ghost"
          aria-label="Chat history"
          title="Chat history"
        >
          <History />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="ui-chat-history-menu">
        <DropdownMenuLabel>Resume a conversation</DropdownMenuLabel>
        {sessions === null ? (
          <p className="ui-chat-history-note">
            <AsciiSpinner />
            Loading…
          </p>
        ) : sessions.length === 0 ? (
          <p className="ui-chat-history-note">No past conversations yet.</p>
        ) : (
          sessions.map((s) => {
            const isCurrent = s.id === currentSessionId;
            const tasks = s.task_count > 0 ? ` · ${s.done_count}/${s.task_count} tasks` : "";
            const where = auraScope ? projectsCaption(s) : "";
            return (
              <DropdownMenuItem key={s.id} disabled={isCurrent} onSelect={() => pick(s)}>
                <span className="ui-chat-history-title">
                  {s.objective?.trim() || "Untitled chat"}
                </span>
                {where && (
                  <span className="ui-chat-history-project" title={projectsTooltip(s)}>
                    {where}
                  </span>
                )}
                <DropdownMenuShortcut>
                  {isCurrent ? "Current" : `${relTime(s.updated_at)}${tasks}`}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            );
          })
        )}
        {claudeSessions && claudeSessions.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Resume from Claude Code</DropdownMenuLabel>
            {claudeSessions.map((sess) => {
              const label = (sess.last_prompt || sess.first_prompt || "").trim() || "Claude session";
              return (
                <DropdownMenuItem
                  key={sess.session_id}
                  disabled={importing != null && importing !== sess.session_id}
                  onSelect={(event) => {
                    // Stay open while the import runs; it closes on success.
                    event.preventDefault();
                    importClaude(sess);
                  }}
                >
                  <AgentIcon agentId="claude" size={14} />
                  <span className="ui-chat-history-title">{label}</span>
                  <DropdownMenuShortcut>
                    {importing === sess.session_id ? "Importing…" : relTime(sess.mtime)}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

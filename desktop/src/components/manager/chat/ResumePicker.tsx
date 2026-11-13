import { ChevronRight, Clock, MessageSquare, X } from "lucide-react";
import type { SlashResumeRow } from "../../../lib/chatSlashHandler";
import { AgentIcon } from "../../agent/AgentIcon";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import "../../ui/resume-picker.css";

// ── Resume picker ───────────────────────────────────────────────────
//
// `/resume` is an ACTION command, not an informational one: instead of
// dumping a markdown list and telling you to "open one from the Sessions
// list", it renders these live, clickable rows. Picking a row actually
// reopens that conversation (openManagerSession), so the command does the
// thing it names. Rows are the queued-messages strip's rows: a quiet
// subtitle (progress · when) and a chevron that brightens on hover.
// Ephemeral by design: the picker is not persisted to
// chat history (an action, not a record), so it never reappears stale on
// reload.
// Compact, composer-docked picker for an action slash command (`/resume`).
// It is the composer's docked strip (the frame queued messages and the crew
// use), flush above the composer, so it reads as composer chrome — not a
// bulky card floating mid-stream.
// One-line rows: glyph · title · faint timestamp · chevron. `onDismiss` lets
// the user close it without resuming (drops the ephemeral slashLog entry).
export function ResumePicker({
  sessions,
  docked,
  onPick,
  onDismiss,
}: {
  sessions: SlashResumeRow[];
  docked?: boolean;
  onPick: (row: SlashResumeRow) => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      className="ui-message-queue ui-resume-picker"
      data-docked={docked ? "" : undefined}
      aria-label="Resume a conversation"
    >
      <div className="ui-queue-caption">
        <span className="ui-resume-picker-title">
          <Clock size={12} />
          Resume a conversation
        </span>
        {onDismiss && (
          <Button type="button" variant="ghost" size="iconXs" onClick={onDismiss} aria-label="Dismiss">
            <X />
          </Button>
        )}
      </div>
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-label={`Resume ${s.title}`}
          onClick={() => onPick(s)}
          className="ui-queue-row ui-resume-row"
        >
          {/* A cross-agent row wears its agent's mark (so you can tell a
              Claude Code thread from a native Aura chat at a glance); a
              native chat keeps the neutral message glyph. */}
          {s.agentId ? (
            <AgentIcon agentId={s.agentId} size={13} />
          ) : (
            <MessageSquare size={12} className="ui-resume-glyph" />
          )}
          <span className="ui-queue-text">{s.title}</span>
          {/* Plain-language origin tag so it's unambiguous which kind of
              conversation each row is — the glyph alone isn't obvious to
              everyone. */}
          <Badge variant="outline">{s.kind === "claude-code" ? "Claude Code" : "Aura chat"}</Badge>
          {s.subtitle && <small>{s.subtitle}</small>}
          <ChevronRight size={13} className="ui-resume-chevron" />
        </button>
      ))}
    </div>
  );
}

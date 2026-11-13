// "Resume this chat elsewhere" — the sheet that carries an Aura chat into a
// real coding-agent CLI's own resume list, so a conversation held in Aura's
// store is never stranded if Aura isn't in front of you.
//
// Single-agent chat → move it cleanly into that one agent's CLI (it lands in
// `claude --resume` / `gemini` / `codex resume` and reopens as that agent's
// session). Multi-agent chat → replicate the whole transcript into EVERY agent
// it used; each reopens it as an *imported transcript* (the full conversation
// as opening context, not that vendor's private session internals) — the sheet
// says so plainly rather than implying a perfect native handoff. An agent with
// no on-disk resume format we can author, or whose CLI isn't installed, is
// shown but marked so the user knows why it can't receive the chat.
//
// All the heavy lifting already exists: `api.chatExportForAgent` writes the
// agent's native resume store at call time (so the chat appears in its list
// immediately) and returns where it landed + how to resume. This component is
// the awareness + one-click surface on top of it.

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, CornerDownRight } from "lucide-react";
import {
  api,
  type AgentDescriptor,
  type AgentExport,
  type ChatTurn,
} from "../../../lib/api";
import { AgentIcon } from "../../agent/AgentIcon";
import { Alert, AlertDescription } from "../../ui/alert";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { LoadingState } from "../../ui/state";
import {
  computeResumePortability,
  type ResumeAgentTarget,
} from "./resumePortability";
import "../../ui/resume-elsewhere.css";
import { readAgentsList } from "../../../lib/agentsListCache";

type SaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "done"; result: AgentExport }
  | { state: "error"; error: string };

type Props = {
  sessionId: string;
  chat: ChatTurn[];
  /** Open the agent in a terminal, resuming this chat. App.tsx handles the
   *  `aura:open-chat-in-agent` event (export + spawn the PTY). */
  onOpenInAgent: (agentId: string, agentLabel: string) => void;
  onClose: () => void;
};

/** The exact command that resumes the chat we just wrote, per agent. Only the
 *  three agents with a native resume store reach here. */
function resumeCommand(agentId: string, exp: AgentExport): string | null {
  if (exp.mode !== "resume" || !exp.resume_arg) return null;
  const id = agentId.toLowerCase();
  if (id === "gemini") return `gemini --session-file "${exp.resume_arg}"`;
  if (id === "codex") return `codex resume ${exp.resume_arg}`;
  return `claude --resume ${exp.resume_arg}`;
}

export function ResumeElsewhere({
  sessionId,
  chat,
  onOpenInAgent,
  onClose,
}: Props) {
  const [agents, setAgents] = useState<AgentDescriptor[] | null>(null);
  const [saves, setSaves] = useState<Record<string, SaveState>>({});

  useEffect(() => {
    let live = true;
    void readAgentsList()
      .then((list) => {
        if (live) setAgents(list);
      })
      .catch(() => {
        if (live) setAgents([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const port = useMemo(
    () => (agents ? computeResumePortability(chat, agents) : null),
    [agents, chat],
  );

  async function save(agentId: string): Promise<void> {
    setSaves((s) => ({ ...s, [agentId]: { state: "saving" } }));
    try {
      const result = await api.chatExportForAgent(agentId, sessionId);
      setSaves((s) => ({ ...s, [agentId]: { state: "done", result } }));
    } catch (e) {
      setSaves((s) => ({
        ...s,
        [agentId]: { state: "error", error: String(e) },
      }));
    }
  }

  async function saveAll(targets: ResumeAgentTarget[]): Promise<void> {
    await Promise.all(targets.filter((t) => t.canResume).map((t) => save(t.agentId)));
  }

  // The shared dialog closes on Esc, on the overlay and on its close button,
  // the same as every other transient sheet in the app.
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="ui-resume-elsewhere">
        <DialogHeader>
          <DialogTitle>Resume this chat elsewhere</DialogTitle>
          <DialogDescription>
            Land this conversation in a coding agent's own resume list so it's
            never stuck inside Aura.
          </DialogDescription>
        </DialogHeader>
        <div className="ui-resume-body">
          {port ? (
            <Body port={port} saves={saves} save={save} saveAll={saveAll} onOpenInAgent={onOpenInAgent} />
          ) : (
            <LoadingState label="Finding installed agents…" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Body({
  port,
  saves,
  save,
  saveAll,
  onOpenInAgent,
}: {
  port: ReturnType<typeof computeResumePortability>;
  saves: Record<string, SaveState>;
  save: (agentId: string) => void;
  saveAll: (targets: ResumeAgentTarget[]) => void;
  onOpenInAgent: (agentId: string, agentLabel: string) => void;
}) {
  // ── Single agent, and it has a CLI we can write ─────────────────────────
  if (port.kind === "single" && port.used[0]?.canResume) {
    const t = port.used[0];
    return (
      <>
        <p className="ui-resume-lead">
          This chat ran entirely on <strong>{t.label}</strong>.
          {" "}Move it into {t.label}'s own CLI. It'll show up in {t.label}'s
          resume list and reopen as that session.
        </p>
        <TargetRow
          target={t}
          state={saves[t.agentId] ?? { state: "idle" }}
          onSave={() => save(t.agentId)}
          onOpen={() => onOpenInAgent(t.agentId, t.label)}
          hero
        />
      </>
    );
  }

  // ── Two or more agents ran it ───────────────────────────────────────────
  if (port.kind === "multi") {
    const receivable = port.used.filter((t) => t.canResume);
    return (
      <>
        <p className="ui-resume-lead">
          This chat was worked by{" "}
          <strong>
            {port.used.map((t) => t.label).join(", ")}
          </strong>
          . I can make it resumable in each. The whole conversation lands in
          every agent's resume list.
        </p>
        <Alert>
          <AlertDescription>
            Heads-up: each agent reopens it as an <strong>imported transcript</strong>.
            The full conversation as its starting context, not that vendor's
            private session internals. Faithful to read; it just won't be that
            agent's own native session.
          </AlertDescription>
        </Alert>
        {receivable.length > 1 && (
          <Button size="sm" onClick={() => saveAll(port.used)}>
            Save to all {receivable.length} agents
          </Button>
        )}
        <div className="ui-resume-targets">
          {port.used.map((t) => (
            <TargetRow
              key={t.agentId}
              target={t}
              state={saves[t.agentId] ?? { state: "idle" }}
              onSave={() => save(t.agentId)}
              onOpen={() => onOpenInAgent(t.agentId, t.label)}
            />
          ))}
        </div>
      </>
    );
  }

  // ── Empty (no brain recorded), or a single non-CLI agent (e.g. an API key) ─
  // Fall back to "send a copy to any installed agent".
  const single = port.kind === "single" ? port.used[0] : null;
  return (
    <>
      <p className="ui-resume-lead">
        {single
          ? `${single.label} is built into Aura. It has no separate CLI to resume in. Send a copy to an installed agent instead:`
          : "Couldn't tell which agent produced this chat. Send a copy to any installed agent. The full conversation lands in its resume list:"}
      </p>
      {port.resumableInstalled.length === 0 ? (
        <Alert>
          <AlertDescription>
            No agent CLI that can receive a resumable copy is installed. Install
            Claude Code, Gemini, or Codex CLI to keep this chat resumable outside
            Aura.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="ui-resume-targets">
          {port.resumableInstalled.map((t) => (
            <TargetRow
              key={t.agentId}
              target={t}
              state={saves[t.agentId] ?? { state: "idle" }}
              onSave={() => save(t.agentId)}
              onOpen={() => onOpenInAgent(t.agentId, t.label)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TargetRow({
  target,
  state,
  onSave,
  onOpen,
  hero = false,
}: {
  target: ResumeAgentTarget;
  state: SaveState;
  onSave: () => void;
  onOpen: () => void;
  hero?: boolean;
}) {
  const cmd =
    state.state === "done" ? resumeCommand(target.agentId, state.result) : null;

  return (
    <div className="ui-resume-target" data-hero={hero ? "" : undefined}>
      <div className="ui-resume-target-head">
        <AgentIcon agentId={target.agentId} size={18} />
        <div className="ui-resume-target-name">
          <span>{target.label}</span>
          {target.turns > 0 && (
            <small>
              {target.turns} turn{target.turns === 1 ? "" : "s"} in this chat
            </small>
          )}
        </div>
        <RowAction target={target} state={state} onSave={onSave} onOpen={onOpen} hero={hero} />
      </div>

      {state.state === "error" && <p className="ui-resume-error">{state.error}</p>}

      {state.state === "done" && (
        <div className="ui-resume-done">
          {cmd && <CopyableCommand cmd={cmd} />}
          {state.result.transcript_path && (
            <small className="ui-resume-path">Saved to {state.result.transcript_path}</small>
          )}
          <Button type="button" variant="link" size="xs" onClick={onOpen}>
            <CornerDownRight />
            Open in a terminal now
          </Button>
        </div>
      )}
    </div>
  );
}

function RowAction({
  target,
  state,
  onSave,
  onOpen,
  hero,
}: {
  target: ResumeAgentTarget;
  state: SaveState;
  onSave: () => void;
  onOpen: () => void;
  hero: boolean;
}) {
  if (!target.available) {
    return <small className="ui-resume-why">CLI not installed</small>;
  }
  if (!target.canResume) {
    return <small className="ui-resume-why">no resume format</small>;
  }
  if (state.state === "saving") {
    return (
      <small className="ui-resume-why">
        <AsciiSpinner size={10} />
        Saving…
      </small>
    );
  }
  if (state.state === "done") {
    return (
      <small className="ui-resume-why" data-tone="green">
        <Check size={12} />
        In resume list
      </small>
    );
  }
  // idle / error → offer the action(s).
  return (
    <div className="ui-resume-actions">
      {hero && (
        <Button size="xs" onClick={onOpen}>
          Save & open
        </Button>
      )}
      <Button variant="secondary" size="xs" onClick={onSave}>
        {state.state === "error" ? "Retry" : hero ? "Save only" : "Save"}
      </Button>
    </div>
  );
}

function CopyableCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ui-resume-command">
      <code title={cmd}>{cmd}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? "Copied" : "Copy the resume command"}
        title={copied ? "Copied" : "Copy the resume command"}
        onClick={() => {
          void navigator.clipboard?.writeText(cmd);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

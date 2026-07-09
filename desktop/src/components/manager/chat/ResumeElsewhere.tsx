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
import {
  api,
  type AgentDescriptor,
  type AgentExport,
  type ChatTurn,
} from "../../../lib/api";
import { AgentIcon } from "../../agent/AgentIcon";
import { Button } from "../../ui/button";
import {
  computeResumePortability,
  type ResumeAgentTarget,
} from "./resumePortability";

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
    void api
      .agentsList()
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

  // Esc closes — matches every other transient sheet in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-lg border border-line-soft bg-bg-2 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5 border-b border-line-soft">
          <div>
            <div className="text-sm font-semibold text-fg-strong">
              Resume this chat elsewhere
            </div>
            <div className="text-xs text-fg-muted mt-0.5">
              Land this conversation in a coding agent's own resume list so it's
              never stuck inside Aura.
            </div>
          </div>
          <button
            type="button"
            className="icon-btn flex-shrink-0"
            title="Close"
            onClick={onClose}
          >
            <svg className="ico"><use href="#i-x" /></svg>
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {!port && (
            <div className="text-xs text-fg-muted py-4 text-center">
              Finding installed agents…
            </div>
          )}

          {port && <Body port={port} saves={saves} save={save} saveAll={saveAll} onOpenInAgent={onOpenInAgent} />}
        </div>
      </div>
    </div>
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
        <p className="text-xs text-fg-soft leading-relaxed">
          This chat ran entirely on <strong className="text-fg-strong">{t.label}</strong>.
          {" "}Move it into {t.label}'s own CLI — it'll show up in {t.label}'s
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
        <p className="text-xs text-fg-soft leading-relaxed">
          This chat was worked by{" "}
          <strong className="text-fg-strong">
            {port.used.map((t) => t.label).join(", ")}
          </strong>
          . I can make it resumable in each — the whole conversation lands in
          every agent's resume list.
        </p>
        <p className="text-[11px] text-fg-muted leading-relaxed rounded border border-line-soft bg-bg-3 px-2.5 py-2">
          Heads-up: each agent reopens it as an{" "}
          <strong className="text-fg-soft">imported transcript</strong> — the
          full conversation as its starting context, not that vendor's private
          session internals. Faithful to read; it just won't be that agent's own
          native session.
        </p>
        {receivable.length > 1 && (
          <Button
            variant="default"
            size="sm"
            className="w-full"
            onClick={() => saveAll(port.used)}
          >
            Save to all {receivable.length} agents
          </Button>
        )}
        <div className="space-y-2">
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

  // ── Empty (no brain recorded), or a single non-CLI agent (e.g. Aura Pro) ─
  // Fall back to "send a copy to any installed agent".
  const single = port.kind === "single" ? port.used[0] : null;
  return (
    <>
      <p className="text-xs text-fg-soft leading-relaxed">
        {single
          ? `${single.label} is built into Aura — it has no separate CLI to resume in. Send a copy to an installed agent instead:`
          : "Couldn't tell which agent produced this chat. Send a copy to any installed agent — the full conversation lands in its resume list:"}
      </p>
      {port.resumableInstalled.length === 0 ? (
        <p className="text-[11px] text-fg-muted leading-relaxed rounded border border-line-soft bg-bg-3 px-2.5 py-2">
          No agent CLI that can receive a resumable copy is installed. Install
          Claude Code, Gemini, or Codex CLI to keep this chat resumable outside
          Aura.
        </p>
      ) : (
        <div className="space-y-2">
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
    <div
      className={`rounded border border-line-soft px-2.5 py-2 ${
        hero ? "bg-bg-3" : "bg-bg-2"
      }`}
    >
      <div className="flex items-center gap-2">
        <AgentIcon agentId={target.agentId} size={18} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-fg-strong truncate">
            {target.label}
          </div>
          {target.turns > 0 && (
            <div className="text-[10.5px] text-fg-muted">
              {target.turns} turn{target.turns === 1 ? "" : "s"} in this chat
            </div>
          )}
        </div>
        <RowAction target={target} state={state} onSave={onSave} onOpen={onOpen} hero={hero} />
      </div>

      {state.state === "error" && (
        <div className="mt-1.5 text-[11px] text-rose-300 break-words">
          {state.error}
        </div>
      )}

      {state.state === "done" && (
        <div className="mt-2 space-y-1.5">
          {cmd && <CopyableCommand cmd={cmd} />}
          {state.result.transcript_path && (
            <div className="text-[10.5px] text-fg-muted break-all">
              Saved to {state.result.transcript_path}
            </div>
          )}
          <button
            type="button"
            className="text-[11px] text-accent hover:underline"
            onClick={onOpen}
          >
            Open in a terminal now →
          </button>
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
    return (
      <span className="text-[10.5px] text-fg-muted flex-shrink-0">
        CLI not installed
      </span>
    );
  }
  if (!target.canResume) {
    return (
      <span className="text-[10.5px] text-fg-muted flex-shrink-0">
        no resume format
      </span>
    );
  }
  if (state.state === "saving") {
    return (
      <span className="text-[10.5px] text-fg-muted flex-shrink-0">Saving…</span>
    );
  }
  if (state.state === "done") {
    return (
      <span className="text-[10.5px] text-emerald-300 flex-shrink-0">
        ✓ In resume list
      </span>
    );
  }
  // idle / error → offer the action(s).
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {hero && (
        <Button variant="default" size="xs" onClick={onOpen}>
          Save & open
        </Button>
      )}
      <Button variant="subtle" size="xs" onClick={onSave}>
        {state.state === "error" ? "Retry" : hero ? "Save only" : "Save"}
      </Button>
    </div>
  );
}

function CopyableCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 text-[10.5px] text-fg-soft bg-bg-3 rounded px-2 py-1 break-all">
        {cmd}
      </code>
      <button
        type="button"
        className="text-[10.5px] text-fg-muted hover:text-fg-soft flex-shrink-0"
        onClick={() => {
          void navigator.clipboard?.writeText(cmd);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

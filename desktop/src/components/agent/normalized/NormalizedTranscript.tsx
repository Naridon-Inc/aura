import { QuestionFlow } from "../../chat/QuestionFlow";
import { ChatHeader } from "../../chat/ChatHeader";
import { PlanPreview } from "../../chat/PlanPreview";
//! The engine-agnostic agent transcript.
//!
//! ONE renderer for every coding agent. It reads the tab's raw stream from the
//! store, runs it through the agent-protocol layer (`normalizeStream` picks the
//! adapter by manifest, `toTranscriptGroups` folds it into render rows), and
//! draws the result with the SAME calm chat cards the native Aura brain uses —
//! `StreamingBubble` for prose/thinking/tool runs, plus first-class cards for
//! the structured moments (questions, plans, todo checklists, permission
//! prompts, the result footer). Claude feeds it today; Codex/Gemini/Cursor
//! light up the instant their adapter lands — this file never changes.
//!
//! It is a faithful, read-only mirror of the agent's structured output: the
//! agent runs as a live TUI in the Terminal view, and questions/permissions
//! are answered there. This surface makes the run legible — "what did it read,
//! edit, run, decide" — the way Claude Code's own UI reads, instead of a wall
//! of raw terminal bytes. Interactive reply round-trips are a later wave
//! (they need the per-engine input transport); for now a structured prompt
//! offers a jump back to the terminal to answer.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onExternalAnchorClick } from "../../../lib/openExternal";
import {
  ArrowUp,
  ArrowDown,
  Search,
  Copy,
  Check,
  Square,
  X,
} from "lucide-react";
import "../chatView.css";
import {
  ComposerFrame,
  ComposerToolbar,
  ChatModePicker,
  promptForChatMode,
  type ChatMode,
} from "../../chat/ChatComposer";
import {
  TiptapComposer,
  type TiptapComposerHandle,
} from "../../manager/TiptapComposer";
import { manifestFor } from "../../../lib/agentProtocol";

import { api } from "../../../lib/api";
import { useAgentSession } from "../../../lib/agentSessionStore";
import { useAgentRecord } from "../../../lib/agentRecordStore";
import { AgentBlockTranscript } from "../chat/AgentBlockTranscript";
import { AgentChatComposer } from "../chat/AgentChatComposer";
import { buildTurnCost } from "../../../lib/turnCost";
import { TurnCostTip } from "../../TurnCostTip";
import { useAgentStream } from "../../../lib/agentStreamStore";
import { normalizeStream } from "../../../lib/agentProtocol";
import type {
  ErrorEvent,
  ImageEvent,
  RawEvent,
  PermissionRequestEvent,
  PlanEvent,
  QuestionSetEvent,
  ResultEvent,
  SessionInitEvent,
  TodoEvent,
} from "../../../lib/agentProtocol";
import { StreamingBubble } from "../../manager/chat/ToolCard";
import { MarkdownBody } from "../../manager/chat/Markdown";

import { toTranscriptGroups, type GroupUsage } from "./blockMap";
import { LinkifiedText } from "./TaskChip";

export function NormalizedTranscript({
  channel,
  agentId,
  repoRoot,
  ptySessionId,
  onRespondInTerminal,
  onSend,
  onStop,
  controls,
  modelControl,
  composerOptions,
  composerDocked = false,
  viewSwitcher,
}: {
  channel: string;
  agentId: string;
  repoRoot: string;
  ptySessionId: string;
  onRespondInTerminal?: () => void;
  onSend?: (text: string, mode?: ChatMode) => Promise<void>;
  onStop?: () => Promise<void>;
  controls?: ReactNode;
  modelControl?: ReactNode;
  composerOptions?: ReactNode;
  composerDocked?: boolean;
  viewSwitcher?: ReactNode;
}) {
  const { events, sessionId, running } = useAgentStream(channel);
  const sid = sessionId ?? ptySessionId;
  // Every PTY session is framed into (prompt, output) blocks by the backend,
  // whether or not its protocol has an adapter. That is the content the
  // fallback transcript below draws.
  const { blocks } = useAgentSession(ptySessionId);

  // Codex and Kimi don't stream their structure over the PTY — they run as
  // full TUIs and write the conversation to their own JSONL beside the
  // session. Reading the terminal instead would drag the CLI's furniture (the
  // echoed prompt, the composer placeholder, the status footer) into the chat
  // as if the agent had said it. Every other engine still comes from the
  // stream, and the tail doesn't run for them at all.
  const record = useAgentRecord(agentId, onSend ? null : repoRoot);
  const nativeRecord = !onSend && record.supported;
  const raw: unknown = nativeRecord ? record.records : events;
  const rawSid = nativeRecord ? (record.sessionId ?? sid) : sid;

  // "The agent is working" has two sources, because the two halves of the
  // chat have two data planes. A streamed engine says so on the wire
  // (`running`, flipped off by its `result`). A file-backed engine says
  // nothing at all — its record growing is the only evidence there is. Using
  // only the first meant Codex, Kimi, OpenCode and Pi never showed a typing
  // cursor and, worse, never showed the Stop button: the control the user
  // reached for to interrupt those agents did not exist.
  const busy = running || (nativeRecord && record.streaming);

  // `normalizeStream` returns null — not [] — when this engine has no adapter,
  // which is the difference between "structured, nothing yet" and "we do not
  // parse this engine". The first still wants the rich card view; the second
  // has to fall back, and used to mean the Chat view was hidden outright.
  const normalized = useMemo(
    () => normalizeStream(agentId, raw, rawSid),
    [agentId, raw, rawSid],
  );
  // A file-backed record lands a beat after the session starts. Until the
  // first record arrives there is nothing structured to draw, so the PTY
  // blocks hold the screen rather than an empty chat that looks broken.
  const structured =
    normalized != null && (!nativeRecord || record.records.length > 0);

  const groups = useMemo(
    () => toTranscriptGroups(normalized ?? [], rawSid),
    [normalized, rawSid],
  );

  const [deliveredAnswers, setDeliveredAnswers] = useState<Record<string, string>>({});
  const pendingQuestion = !onSend ? groups.find(group => group.kind === "question" && group.live && !deliveredAnswers[group.id]) : undefined;
  const questionDock = pendingQuestion?.kind === "question" ? <QuestionFlow key={pendingQuestion.id} docked questions={pendingQuestion.ev.questions.map(question => ({id:question.id, prompt:question.prompt, options: (question.options ?? []).map(option => ({id: option.optionId, label:option.label, description:option.description})), multiple:question.multiSelect, freeText:true}))} onSubmit={async answers => {
    const text = answers.map((answer, index) => {
      const question = pendingQuestion.ev.questions[index];
      const response = answer.skipped ? "(skipped)" : answer.text.trim() || answer.selected.map(id => question.options?.find(option => option.optionId === id)?.label ?? id).join(", ");
      return answers.length > 1 ? `${question.prompt}: ${response}` : response;
    }).join("\n");
    await api.agentPtySendPrompt(ptySessionId, text);
    setDeliveredAnswers(previous => ({...previous, [pendingQuestion.id]:text}));
  }} /> : null;
  const visibleGroups = groups.filter(group => group.id !== pendingQuestion?.id).map(group => group.kind === "question" && deliveredAnswers[group.id] ? {...group, live:false, ev:{...group.ev, partial:false, resolution:{text:deliveredAnswers[group.id], isError:false}}} : group);

  return (
    <ChatTimeline
      viewSwitcher={viewSwitcher}
      groups={visibleGroups}
      running={busy}
      fallback={
        !structured ? (
          <AgentBlockTranscript
            blocks={blocks}
            repoRoot={repoRoot}
            running={busy}
          />
        ) : undefined
      }
      agentId={agentId}
      repoRoot={repoRoot}
      onRespondInTerminal={onRespondInTerminal}
      controls={<>{controls}{questionDock}</>}
      composer={
        onSend ? (
          <AgentComposer
            ptySessionId={ptySessionId}
            repoRoot={repoRoot}
            running={busy}
            onSend={onSend}
            onStop={onStop}
            modelControl={modelControl}
            options={composerOptions}
            docked={composerDocked}
          />
        ) : (
          <AgentChatComposer
            agentId={agentId}
            ptySessionId={ptySessionId}
            repoRoot={repoRoot}
            running={busy}
            onSwitchToTerminal={onRespondInTerminal}
          />
        )
      }
    />
  );
}

/** Shared reading surface: keeps long sessions navigable without mounting
 * thousands of markdown and tool trees at once. Search spans all loaded rows. */
export function ChatTimeline({
  viewSwitcher,
  fallback,
  groups,
  running,
  agentId,
  repoRoot,
  onRespondInTerminal,
  composer,
  controls,
}: {
  fallback?: ReactNode;
  viewSwitcher?: ReactNode;
  groups: ReturnType<typeof toTranscriptGroups>;
  running: boolean;
  agentId: string;
  repoRoot: string;
  onRespondInTerminal?: () => void;
  composer?: ReactNode;
  controls?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(100);
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stuck = useRef(true);
  const matches = useMemo(
    () =>
      query.trim()
        ? groups.filter((g) =>
            JSON.stringify(g)
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
          )
        : groups,
    [groups, query],
  );
  const visible = matches.slice(-visibleCount);
  const agentLabel =
    agentId === "aura-manager" ? "Aura" : manifestFor(agentId).label;
  const usage = useMemo(() => {
    let context = 0,
      tokens = 0,
      any = false;
    for (const g of groups)
      if (g.kind === "stream" && g.usage) {
        context = g.usage.context;
        tokens += g.usage.output;
        any = true;
      }
    return any ? { context, tokens } : null;
  }, [groups]);
  useEffect(() => {
    const el = scrollRef.current;
    const sel = window.getSelection();
    if (
      el &&
      stuck.current &&
      !query &&
      !(
        sel &&
        !sel.isCollapsed &&
        sel.anchorNode &&
        el.contains(sel.anchorNode)
      )
    )
      el.scrollTop = el.scrollHeight;
  }, [groups, running, query]);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  function jumpLatest() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setAtBottom(true);
  }
  async function copy() {
    const text = groups
      .map((g) => {
        if (g.kind === "user") return `You: ${g.text}`;
        if (g.kind === "stream")
          return g.blocks
            .map((b) =>
              b.kind === "text" || b.kind === "reasoning"
                ? b.text
                : JSON.stringify(b),
            )
            .join("\n");
        return JSON.stringify(g);
      })
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError("");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError("Could not copy. Select the text and copy it manually.");
    }
  }
  return (
    <section
      className="aura-chat chat-workspace"
      aria-label={`${agentId === "aura-manager" ? "Aura" : manifestFor(agentId).label} conversation`}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "f") {
          e.preventDefault();
          setSearchOpen(true);
        }
        if (e.key === "Escape" && searchOpen) {
          setSearchOpen(false);
          setQuery("");
        }
      }}
    >
      <ChatHeader title={agentLabel} workspace={repoRoot} status={running ? "Working" : undefined} switcher={viewSwitcher} actions={<>
          <button
            className="chat-heading-search"
            type="button"
            aria-label="Search conversation"
            aria-expanded={searchOpen}
            title="Search conversation (⌘F / Ctrl+F)"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search size={15} />
            <span className="chat-heading-action-label">Search</span>
          </button>
          <button
            className="chat-icon-button"
            type="button"
            aria-label={copied ? "Copied conversation" : "Copy conversation"}
            disabled={!groups.length}
            onClick={() => void copy()}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
</>} />
      {searchOpen && (
        <div className="chat-search">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleCount(100);
            }}
            placeholder="Find messages, files or tools…"
            aria-label="Search messages"
          />
          <span aria-live="polite">
            {query ? `${matches.length} matches` : ""}
          </span>
          <button
            type="button"
            className="chat-icon-button"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {copyError && (
        <p role="alert" className="chat-notice">
          {copyError}
        </p>
      )}
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) {
            stuck.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            setAtBottom(stuck.current);
          }
        }}
      >
        {fallback ??
          (groups.length === 0 ? (
            <div className="chat-empty">
              <h2>New conversation</h2>
              <p>
                Send a message to{" "}
                {agentId === "aura-manager"
                  ? "Aura"
                  : manifestFor(agentId).label}
                .
              </p>
            </div>
          ) : (
            <div className="chat-reading-column">
              {matches.length > visibleCount && (
                <button
                  className="chat-history-button"
                  type="button"
                  onClick={() => {
                    stuck.current = false;
                    const el = scrollRef.current;
                    const height = el?.scrollHeight ?? 0;
                    const top = el?.scrollTop ?? 0;
                    setVisibleCount((n) => n + 100);
                    requestAnimationFrame(() => {
                      if (el) el.scrollTop = top + el.scrollHeight - height;
                    });
                  }}
                >
                  Show earlier activity · {matches.length - visibleCount} more
                </button>
              )}
              {matches.length === 0 && (
                <p className="chat-no-results">
                  No matches for “{query}”. Try a different word.
                </p>
              )}
              <TranscriptRows
                groups={
                  query
                    ? visible
                    : visible.filter((group) => group.kind !== "init")
                }
                running={running && !query}
                repoRoot={repoRoot}
                onRespondInTerminal={onRespondInTerminal}
              />
            </div>
          ))}
      </div>
      {!atBottom && !query && (
        <button type="button" className="chat-jump" onClick={jumpLatest}>
          <ArrowDown size={14} />
          {running ? "Follow live response" : "Jump to latest"}
        </button>
      )}
      {usage && <SessionUsageStrip usage={usage} />}
      {controls}
      {composer}
    </section>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

/** The Chat view's own composer — same calm look as the Aura manager chat,
 *  but it injects straight into the agent's live PTY child via
 *  `agent_pty_send_prompt` (the bracketed-paste path the terminal uses).
 *  So you can answer / steer the agent from the readable Chat view without
 *  flipping to the raw terminal. Mid-run sends queue into the agent the same
 *  way typing in the terminal would. */
export function AgentComposer({
  ptySessionId,
  repoRoot = null,
  running,
  onSend,
  onStop,
  modelControl,
  options,
  docked = false,
}: {
  ptySessionId: string;
  repoRoot?: string | null;
  running: boolean;
  onSend?: (text: string, mode?: ChatMode) => Promise<void>;
  onStop?: () => Promise<void>;
  modelControl?: ReactNode;
  options?: ReactNode;
  docked?: boolean;
}) {
  const draftKey = `aura.chat.draft.${ptySessionId}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [mode, setMode] = useState<ChatMode>(() => {
    try {
      const saved = sessionStorage.getItem(`${draftKey}.mode`);
      return saved === "plan" || saved === "ask" ? saved : "build";
    } catch {
      return "build";
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, text);
    } catch {
      /* storage unavailable */
    }
  }, [draftKey, text]);
  const taRef = useRef<TiptapComposerHandle | null>(null);
  const canSend = text.trim().length > 0 && !sending && !(onSend && running);

  async function send() {
    const t = text.trim();
    if (!t || sendLock.current || (onSend && running)) return;
    sendLock.current = true;
    setSending(true);
    setError(null);
    try {
      await (onSend
        ? onSend(t, mode)
        : api.agentPtySendPrompt(ptySessionId, promptForChatMode(t, mode)));
      setText("");
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        /* storage unavailable */
      }
      taRef.current?.clear();
    } catch (e) {
      setError(`Message was not sent. Your draft is saved. ${String(e)}`);
    } finally {
      sendLock.current = false;
      setSending(false);
      taRef.current?.focus();
    }
  }

  return (
    <div className={`chat-composer ${docked ? "has-docked-control" : ""}`}>
      <div className="mx-auto w-full max-w-[760px]">
        <ComposerFrame className={docked ? "composer-docked" : ""}>
          <TiptapComposer
            key={ptySessionId}
            ref={taRef}
            repoRoot={repoRoot}
            initialMarkdown={text}
            busy={sending}
            ariaLabel="Message the agent"
            onChange={setText}
            onSubmit={() => void send()}
            onEscapeWhileBusy={() => {
              if (onStop) void onStop().catch((e) => setError(String(e)));
            }}
            placeholder={
              running
                ? "Write a follow-up…"
                : "Ask to make changes, @mention files, run /commands"
            }
          />
          <ComposerToolbar
            mode={
              <ChatModePicker
                value={mode}
                modes={["build", "plan", "ask"]}
                disabled={running}
                onChange={(value) => {
                  setMode(value);
                  try {
                    sessionStorage.setItem(`${draftKey}.mode`, value);
                  } catch {}
                }}
              />
            }
            model={modelControl}
            options={options}
            actions={
              <>
                {running && onStop && (
                  <button
                    type="button"
                    className="chat-stop"
                    aria-label="Stop response"
                    onClick={() =>
                      void onStop().catch((e) => setError(String(e)))
                    }
                  >
                    <Square size={14} /> Stop
                  </button>
                )}
                <button
                  aria-label="Send message"
                  type="button"
                  className="chat-send"
                  disabled={!canSend}
                  onClick={() => void send()}
                  title="Send (↵)"
                >
                  <ArrowUp size={16} aria-hidden />
                </button>
              </>
            }
          />
        </ComposerFrame>
        {error && (
          <div role="alert" className="mt-2 text-[12px] text-red-400">
            {error}
          </div>
        )}
        <div className="chat-compose-hint">
          {running
            ? onSend
              ? "You can draft your next message while this runs."
              : "Messages queue in this session."
            : "Enter to send · Shift+Enter for a new line"}
        </div>
      </div>
    </div>
  );
}

// ── User prose ────────────────────────────────────────────────────────────

function UserRow({ text, repoRoot }: { text: string; repoRoot: string }) {
  return (
    <div className="self-end min-w-0 max-w-[88%] break-words">
      <div className="chat-user-message whitespace-pre-wrap break-words">
        <LinkifiedText text={text} repoRoot={repoRoot} />
      </div>
    </div>
  );
}

// ── Session-init chip ───────────────────────────────────────────────────────

function InitChip({ ev }: { ev: SessionInitEvent }) {
  const tools = ev.tools?.length ?? 0;
  return (
    <div className="flex items-center gap-2 text-[11px] text-text-3">
      <span className="font-medium">{ev.model ?? "session"}</span>
      {tools > 0 && <span>· {tools} tools</span>}
    </div>
  );
}

// ── Structured-prompt scaffold ──────────────────────────────────────────────

/** Shared shell for the question / plan / permission cards — a calm bordered
 *  card with a header and an optional "answer in the terminal" jump. */
function PromptCard({
  label,
  children,
  onRespondInTerminal,
}: {
  label: string;
  children: ReactNode;
  onRespondInTerminal?: () => void;
}) {
  return (
    <div className="chat-record">
      <div className="chat-record-label">{label}</div>
      <div>{children}</div>
      {onRespondInTerminal && (
        <button
          type="button"
          onClick={onRespondInTerminal}
          className="chat-record-action"
        >
          Answer in Terminal
        </button>
      )}
    </div>
  );
}

function QuestionSetCard({
  ev,
  onRespondInTerminal,
}: {
  ev: QuestionSetEvent;
  onRespondInTerminal?: () => void;
}) {
  const resolved = ev.partial === false || ev.answer != null;
  return (
    <PromptCard
      label={
        resolved
          ? "Question closed"
          : ev.questions.length > 1
            ? `${ev.questions.length} questions`
            : "Question"
      }
      onRespondInTerminal={resolved ? undefined : onRespondInTerminal}
    >
      <div className="flex flex-col gap-3">
        {ev.questions.map((q, index) => (
          <div key={`${q.id}:${index}`}>
            <div className="text-[13px] font-medium text-text-1">
              {q.prompt}
            </div>
            {!resolved && q.multiSelect && (
              <p className="text-[11px] text-text-3">
                Multiple selections allowed
              </p>
            )}
            <ul className="chat-question-options">
              {q.options?.map((o, i) => (
                <li key={`${o.optionId}:${i}`}>
                  {o.label}
                  {o.description && (
                    <span className="text-text-3"> — {o.description}</span>
                  )}
                </li>
              ))}
            </ul>
            {!resolved && q.freeText && (
              <p className="text-[11px] text-text-3">
                You can also write an answer.
              </p>
            )}
          </div>
        ))}
        {(ev.resolution?.text || ev.answer) && (
          <div className="whitespace-pre-wrap text-[12px] text-text-3">
            {ev.resolution?.text ?? ev.answer}
          </div>
        )}
        {!resolved && (
          <p className="text-[11.5px] text-text-3">
            Select your answers in Terminal.
          </p>
        )}
      </div>
    </PromptCard>
  );
}

function PlanCard({
  ev,
  onRespondInTerminal,
}: {
  ev: PlanEvent;
  onRespondInTerminal?: () => void;
}) {
  const heading =
    ev.markdown?.match(/^#{1,2}\s+(.+)$/m)?.[1] ?? "Implementation plan";
  return (
    <PlanPreview
      title={heading}
      status={ev.awaitingApproval ? "Ready for review" : ev.decision === "approved" ? "Approved" : ev.decision === "rejected" ? "Declined" : "Plan"}
      meta={
        ev.entries.length
          ? `${ev.entries.length} task${ev.entries.length === 1 ? "" : "s"}`
          : undefined
      }
      actions={
        ev.awaitingApproval && onRespondInTerminal ? (
          <button
            type="button"
            className="chat-plan-secondary"
            onClick={onRespondInTerminal}
          >
            Review in Terminal
          </button>
        ) : undefined
      }
    >
      {ev.markdown ? (
        <MarkdownBody source={ev.markdown} />
      ) : (
        <ol className="chat-plan-tasks">
          {ev.entries.map((e, i) => (
            <li key={i}>
              <TodoMark status={e.status ?? "pending"} />
              <span>{e.content}</span>
            </li>
          ))}
        </ol>
      )}
    </PlanPreview>
  );
}

function TodoCard({ ev }: { ev: TodoEvent }) {
  return (
    <div className="chat-record">
      <div className="chat-record-label">Checklist</div>
      <div className="flex flex-col gap-1">
        {ev.todos.map((t, i) => (
          <div
            key={t.id ?? i}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <TodoMark status={t.status} />
            <span
              style={{
                color:
                  t.status === "completed"
                    ? "var(--color-text-3)"
                    : "var(--color-text-1)",
                textDecoration:
                  t.status === "completed" ? "line-through" : undefined,
              }}
            >
              {t.status === "in_progress" && t.activeForm
                ? t.activeForm
                : t.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TodoMark({
  status,
}: {
  status: "pending" | "in_progress" | "completed";
}) {
  return (
    <span
      className="chat-task-mark"
      aria-label={
        status === "completed"
          ? "Completed"
          : status === "in_progress"
            ? "In progress"
            : "Pending"
      }
    >
      {status === "completed" ? (
        <Check size={11} />
      ) : status === "in_progress" ? (
        "−"
      ) : (
        ""
      )}
    </span>
  );
}

function PermissionCard({
  ev,
  onRespondInTerminal,
}: {
  ev: PermissionRequestEvent;
  onRespondInTerminal?: () => void;
}) {
  return (
    <PromptCard
      label={
        ev.partial === false ? "Permission request closed" : "Asking permission"
      }
      onRespondInTerminal={
        ev.partial === false ? undefined : onRespondInTerminal
      }
    >
      <div className="text-[13px] font-medium text-text-1">{ev.title}</div>
      <div className="mt-1 text-[12px] text-text-3 font-mono break-all">
        {ev.toolName}
      </div>
      {ev.partial !== false && (
        <div className="mt-2 text-[11.5px] leading-relaxed text-text-3">
          Review and answer the permission request in Terminal.
        </div>
      )}
    </PromptCard>
  );
}

// ── Per-response token footer ──────────────────────────────────────────────

/** A short token count: 45230 → "45.2k", 980 → "980". */
function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

/** A faint line under each response: how much context the model was working
 *  with, and how many tokens it wrote back. Honest per-call data lifted from
 *  Claude's `message.usage` — no estimate. Hidden when there's nothing to show. */
function UsageFooter({ usage }: { usage: GroupUsage }) {
  const bits: string[] = [];
  if (usage.context > 0) bits.push(`${compactTokens(usage.context)} context`);
  if (usage.output > 0) bits.push(`${compactTokens(usage.output)} tokens`);
  if (bits.length === 0) return null;
  return (
    <div
      className="self-start pl-0.5 text-[10.5px] text-text-4 select-text"
      title="Context fed to the model for this response, and the tokens it wrote back."
    >
      {bits.join(" · ")}
    </div>
  );
}

/** A slim always-visible strip: what THIS AI session has cost so far. Not
 *  "remaining" (a CLI agent exposes no quota) — the honest consumed total,
 *  in the chat where you're using the AI. The cross-AI breakdown lives on the
 *  Usage page. */
function SessionUsageStrip({
  usage,
}: {
  usage: { context: number; tokens: number };
}) {
  return (
    <div
      className="flex-shrink-0 flex items-center justify-end gap-1.5 px-4 py-1 text-[10.5px] text-text-4 border-b border-line-soft/60"
      title="Current context and total output tokens for this conversation."
    >
      <span>{compactTokens(usage.context)} context</span>
      <span>·</span>
      <span>{compactTokens(usage.tokens)} output tokens</span>
    </div>
  );
}

function ResultFooter({ ev }: { ev: ResultEvent }) {
  const cost = buildTurnCost({model: null, agent: null, startMs: ev.durationMs != null ? ev.ts - ev.durationMs : null, endMs: ev.ts, inputTokens: ev.usage?.inputTokens, outputTokens: ev.usage?.outputTokens, cacheRead: ev.usage?.cacheRead, cacheWrite: ev.usage?.cacheWrite, sessionCostUsd: ev.costUsd, sessionIsRunTotal: true});
  const ok = ev.subtype === "success";
  const cancelled = ev.subtype === "cancelled";
  const bits: string[] = [];
  if (ev.durationMs != null && ev.durationMs > 0)
    bits.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
  if (ev.usage?.outputTokens != null)
    bits.push(`${ev.usage.outputTokens.toLocaleString()} output tokens`);
  if (ev.totalTokens != null)
    bits.push(`${ev.totalTokens.toLocaleString()} total tokens`);
  if (ev.costUsd != null) bits.push(`$${ev.costUsd.toFixed(3)}`);
  return (
    <div className="text-[11px] text-text-3 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {ok ? "Done" : cancelled ? "Cancelled" : "Ended with an error"}
        </span>
        {bits.length > 0 && <TurnCostTip cost={cost}><span>· {bits.join(" · ")}</span></TurnCostTip>}
      </div>
      {ev.text && (
        <div className="mt-2">
          <MarkdownBody source={ev.text} />
        </div>
      )}
      {ev.errors?.map((error, i) => (
        <div key={i} role="alert" className="mt-1 whitespace-pre-wrap break-words">
          {error}
        </div>
      ))}
      {ev.stopReason && <div className="mt-1">{ev.stopReason}</div>}
    </div>
  );
}

// ── Inline image ────────────────────────────────────────────────────────────

/** A picture in the conversation — a screenshot the user attached, or one the
 *  agent read back / produced. Shown as a bounded thumbnail; click opens the
 *  full-size image in a new tab. Aligned right for the user, left for the
 *  agent, matching the prose bubbles. */
function ImageBubble({ ev }: { ev: ImageEvent }) {
  const [failed, setFailed] = useState(false);
  if (failed || !/^image\/(png|jpeg|gif|webp|avif)$/i.test(ev.mediaType)) {
    return (
      <RawPayloadCard
        ev={{
          ...ev,
          kind: "raw",
          label: "Image unavailable",
          payload: { mediaType: ev.mediaType, data: ev.data },
        }}
      />
    );
  }
  const src = `data:${ev.mediaType};base64,${ev.data}`;
  const mine = ev.role === "user";
  return (
    <div className={mine ? "self-end max-w-[88%]" : "self-start max-w-[88%]"}>
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        onClick={onExternalAnchorClick}
        title="Open full size"
        className="block rounded-lg overflow-hidden"
        style={{ border: "1px solid var(--color-line-soft)" }}
      >
        <img
          src={src}
          loading="lazy"
          onError={() => setFailed(true)}
          alt={mine ? "Attached image" : "Image from the agent"}
          className="block max-h-[360px] w-auto max-w-full object-contain bg-bg-2"
        />
      </a>
    </div>
  );
}

function ErrorRow({ ev }: { ev: ErrorEvent }) {
  return (
    <div
      className="rounded-lg px-3 py-2 text-[12.5px]"
      style={{
        background:
          "color-mix(in srgb, var(--color-negative, #dc2626) 8%, transparent)",
        color: "var(--color-negative, #dc2626)",
        border:
          "1px solid color-mix(in srgb, var(--color-negative, #dc2626) 28%, transparent)",
      }}
    >
      {ev.message}
    </div>
  );
}

/** Unknown content stays available as inert text; no payload is executed. */
function RawPayloadCard({ ev }: { ev: RawEvent }) {
  const [all, setAll] = useState(false);
  let text: string;
  try {
    text =
      typeof ev.payload === "string"
        ? ev.payload
        : (JSON.stringify(ev.payload, null, 2) ?? String(ev.payload));
  } catch {
    text = String(ev.payload);
  }
  const limit = 12_000;
  return (
    <details className="rounded-lg border border-line-soft px-3 py-2 text-[12px] text-text-3">
      <summary className="cursor-pointer">
        {ev.label} · additional content
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all select-text">
        {all ? text : text.slice(0, limit)}
      </pre>
      {!all && text.length > limit && (
        <button
          type="button"
          className="mt-2 underline"
          onClick={() => setAll(true)}
        >
          Show all {text.length.toLocaleString()} characters
        </button>
      )}
    </details>
  );
}

/** The provider-independent transcript body, also used by the coverage harness. */
export function TranscriptRows({
  groups,
  running = false,
  repoRoot,
  onRespondInTerminal,
}: {
  groups: import("./blockMap").TranscriptGroup[];
  running?: boolean;
  repoRoot: string;
  onRespondInTerminal?: () => void;
}) {
  return (
    <>
      {groups.map((g, i) => {
        const isLast = i === groups.length - 1;
        switch (g.kind) {
          case "init":
            return <InitChip key={g.id} ev={g.ev} />;
          case "user":
            return <UserRow key={g.id} text={g.text} repoRoot={repoRoot} />;
          case "stream":
            return (
              <div key={g.id} className="flex flex-col gap-1">
                <StreamingBubble
                  blocks={g.blocks}
                  streaming={running && isLast}
                />
                {g.usage && <UsageFooter usage={g.usage} />}
              </div>
            );
          case "question":
            return (
              <QuestionSetCard
                key={g.id}
                ev={g.ev}
                onRespondInTerminal={onRespondInTerminal}
              />
            );
          case "plan":
            return (
              <PlanCard
                key={g.id}
                ev={g.ev}
                onRespondInTerminal={onRespondInTerminal}
              />
            );
          case "todo":
            return <TodoCard key={g.id} ev={g.ev} />;
          case "permission":
            return (
              <PermissionCard
                key={g.id}
                ev={g.ev}
                onRespondInTerminal={onRespondInTerminal}
              />
            );
          case "result":
            return <ResultFooter key={g.id} ev={g.ev} />;
          case "error":
            return <ErrorRow key={g.id} ev={g.ev} />;
          case "image":
            return <ImageBubble key={g.id} ev={g.ev} />;
          case "raw":
            return <RawPayloadCard key={g.id} ev={g.ev} />;
          case "status":
            return (
              <div key={g.id} role="status" className="text-[12px] text-text-3">
                {g.ev.message ??
                  (g.ev.state === "retry"
                    ? "Retrying"
                    : g.ev.state === "busy"
                      ? "Working"
                      : "Idle")}
                {g.ev.attempt != null && ` · attempt ${g.ev.attempt}`}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

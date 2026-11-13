import { QuestionFlow } from "../../chat/QuestionFlow";
import { PermissionRequest, PlanReview } from "../../ui/chat-decisions";
import { QuestionRecord } from "../../chat/QuestionRecord";
import { Button } from "../../ui/button";
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
import { writeClipboardText } from "../../../lib/clipboard";
import { ImageLightbox } from "../../media/ImageLightbox";
import { ArrowDown, Search, Check, X } from "lucide-react";
import {
  TimelineMenuItems,
  TimelineToolsContext,
  TimelineViewSwitch,
} from "./timelineTools";
import "../chatView.css";
import "../../chat/ChatComposer.css";
import "../../ui/chat-composer.css";
import "../../ui/transcript-chips.css";
import { promptForChatMode, type ChatMode } from "../../chat/composer/chatMode";
import { useComposerSuggestions, type SlashItem } from "../../chat/composer/useComposerSuggestions";
import { ComposerTurnMenu } from "../../chat/composer/ComposerTurnMenu";
import { Composer } from "../../ui/composer";
import { ComposerAddMenu } from "../../ui/composer-tools";
import { ChatNotice } from "../../ui/chat-surface";
import { ChatStatus, Message, MessageActions, MessageBody } from "../../ui/message";
import { UnsupportedMessage } from "../../ui/transcript-content";
import { manifestFor } from "../../../lib/agentProtocol";

import { api } from "../../../lib/api";
import { useAgentSession } from "../../../lib/agentSessionStore";
import { useAgentRecord } from "../../../lib/agentRecordStore";
import { AgentBlockTranscript } from "../chat/AgentBlockTranscript";
import { AgentChatComposer } from "../chat/AgentChatComposer";
import { buildTurnCost } from "../../../lib/turnCost";
import { turnUsage } from "../../manager/chat/turnUsage";
import { formatDuration } from "../../../lib/duration";
import { TurnFooter } from "../../ui/transcript-patterns";
import { CompactionSummary } from "../../ui/chat-recovery";
import { useAgentStream } from "../../../lib/agentStreamStore";
import { useAgentEvent } from "../../../lib/agentEventStore";
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
import { TurnActivity } from "../../manager/chat/TurnActivity";
import { splitSettledTurn } from "./turnSplit";
import { ThinkingLine } from "../../manager/chat/StatusLine";
import { MarkdownBody } from "../../manager/chat/Markdown";

import { useComposerOverlayHeight } from "../../chat/composerOverlay";
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
  agentCommands,
  viewSwitcher,
  overlay = false,
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
  /** Slash commands the running agent published (ACP `available_commands`). */
  agentCommands?: SlashItem[];
  viewSwitcher?: ReactNode;
  /** The pane is showing a content surface — its terminal — and this
   *  transcript is mounted behind it so the composer survives the flip. The
   *  conversation itself goes invisible (keeping its scroll position, which
   *  unmounting or `display: none` would both throw away) and the dock stays
   *  as a strip over the content. See `composerCollapse`. */
  overlay?: boolean;
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

  // A terminal agent reports its turns through its hooks — the same signal
  // the tab's mark breathes on. A streamed tab has no hooks, so it asks
  // nothing here.
  const turn = useAgentEvent(onSend ? null : ptySessionId);
  const cliWorking = turn.status.kind === "in_progress";

  // "The agent is working" has three sources, because the chat has three data
  // planes. A streamed engine says so on the wire (`running`, flipped off by
  // its `result`). A file-backed engine says nothing at all — its record
  // growing is the only evidence there is. And a terminal agent writes a
  // transcript that records finished messages only: no turn start, no turn
  // end. Reading only that, a Claude tab driven from its terminal sat in the
  // Chat view looking finished while the CLI beside it said "Hatching… (22s)",
  // and each reply appeared from nowhere once it was done. Its hooks say what
  // the transcript cannot.
  const busy = running || (nativeRecord && record.streaming) || cliWorking;

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
      overlay={overlay}
      groups={visibleGroups}
      running={busy}
      runningSince={cliWorking ? turn.startedAt : null}
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
            agentCommands={agentCommands}
          />
        ) : (
          <AgentChatComposer
            agentId={agentId}
            ptySessionId={ptySessionId}
            repoRoot={repoRoot}
            running={busy}
            onSwitchToTerminal={onRespondInTerminal}
            docked={questionDock != null}
            overlay={overlay}
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
  runningSince = null,
  agentId,
  repoRoot,
  onRespondInTerminal,
  composer,
  controls,
  overlay = false,
}: {
  fallback?: ReactNode;
  viewSwitcher?: ReactNode;
  /** Mounted behind a content surface: the conversation goes invisible and the
   *  dock becomes a strip floating over whatever is showing. */
  overlay?: boolean;
  groups: ReturnType<typeof toTranscriptGroups>;
  running: boolean;
  /** When the running turn began, if the source knows. The working line counts
   *  from here so opening the chat mid-turn shows the turn's real age. */
  runningSince?: number | null;
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
  const dockRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // The dock is what a content surface underneath has to clear, so the dock is
  // what reports its height — padding included, card excluded from nothing.
  useComposerOverlayHeight(dockRef, { active: overlay });
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
    // Through Rust: this button's click gesture is spent by the time the
    // webview would be asked, and WebKit refuses a write without one.
    if (await writeClipboardText(text)) {
      setCopied(true);
      setCopyError("");
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopyError("Could not copy. Select the text and copy it manually.");
    }
  }
  return (
    <TimelineToolsContext.Provider
      value={{
        switcher: viewSwitcher,
        overlay,
        searchOpen,
        onToggleSearch: () => {
          if (searchOpen) setQuery("");
          setSearchOpen((v) => !v);
        },
        canCopy: groups.length > 0,
        copied,
        onCopy: () => void copy(),
      }}
    >
      <section
        className="aura-chat chat-workspace"
        // Everything this flag moves is in the stylesheet: the conversation goes
        // invisible, the dock becomes a bottom strip, and the pane behind takes
        // the clicks the strip does not want. One attribute rather than six
        // conditional class names.
        data-chat-overlay={overlay || undefined}
        aria-label={`${agentLabel} conversation`}
        // Click-focusable, not tabbable. Clicking in the transcript to read or
        // select otherwise leaves focus on `body`, and a key pressed there never
        // reaches this surface at all: ⌘F worked only until you touched the
        // page, and ⌘V had nothing to catch it (see AgentChatComposer).
        tabIndex={-1}
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
            <Button
              type="button"
              variant="ghost"
              size="iconXs"
              aria-label="Close search"
              onClick={() => {
                setSearchOpen(false);
                setQuery("");
              }}
            >
              <X />
            </Button>
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
            (groups.length === 0 && !running ? (
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
                {matches.length === 0 && query && (
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
                {/* The CLI keeps "Hatching… (22s)" under the conversation for
                    the whole turn — between replies, through a long command,
                    before the first word lands. This is that line. Keyed on the
                    start so a turn that opens while the line is up restarts its
                    count instead of carrying the last one's. */}
                {running && !query && (
                  <ThinkingLine
                    key={runningSince ?? "live"}
                    label="Working…"
                    startedAt={runningSince}
                  />
                )}
              </div>
            ))}
        </div>
        {!atBottom && !query && (
          <button type="button" className="chat-jump" onClick={jumpLatest}>
            <ArrowDown size={14} />
            {running ? "Follow live response" : "Jump to latest"}
          </button>
        )}
        {/* The dock shares the transcript's reading column and its ground — no
            band of its own. Usage, docked cards and the composer all sit in it. */}
        <div className="chat-dock" ref={dockRef}>
          {usage && <SessionUsageStrip usage={usage} />}
          {controls}
          {composer}
        </div>
      </section>
    </TimelineToolsContext.Provider>
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
  agentCommands,
}: {
  ptySessionId: string;
  repoRoot?: string | null;
  running: boolean;
  onSend?: (text: string, mode?: ChatMode) => Promise<void>;
  onStop?: () => Promise<void>;
  modelControl?: ReactNode;
  options?: ReactNode;
  docked?: boolean;
  agentCommands?: SlashItem[];
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
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const caret = taRef.current?.selectionStart ?? text.length;
  const { suggestions, resolvePick } = useComposerSuggestions({
    repoRoot,
    before: text.slice(0, caret),
    agentRows: agentCommands,
  });
  const chooseMode = (value: ChatMode) => {
    setMode(value);
    try {
      sessionStorage.setItem(`${draftKey}.mode`, value);
    } catch {
      /* storage unavailable */
    }
  };

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
    } catch (e) {
      setError(`Message was not sent. Your draft is saved. ${String(e)}`);
    } finally {
      sendLock.current = false;
      setSending(false);
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }

  return (
    <div className="agent-chat-composer">
      <Composer
        className={docked ? "composer-docked" : ""}
        value={text}
        onChange={setText}
        onSend={() => void send()}
        onStop={onStop ? () => void onStop().catch((e) => setError(String(e))) : undefined}
        running={running}
        disabled={sending}
        // Drafting the next message while a turn runs is allowed; sending it
        // waits for the turn to end, so the send control steps aside.
        sendDisabled={!!onSend && running}
        context={
          running ? (
            <span>
              {onSend
                ? "You can draft your next message while this runs."
                : "Messages queue in this session."}
            </span>
          ) : undefined
        }
        ariaLabel="Message the agent"
        placeholder={
          running
            ? "Write a follow-up…"
            : "Ask to make changes, @mention files, run /commands"
        }
        suggestions={suggestions}
        onSuggestionSelect={(pick) => setText((prev) => resolvePick(pick, prev) ?? prev)}
        planMode={mode === "plan"}
        onPlanModeChange={running ? undefined : (on) => chooseMode(on ? "plan" : "build")}
        textareaRef={taRef}
        onKeyDown={(e) => {
          if (e.key === "Escape" && running && onStop) {
            e.preventDefault();
            void onStop().catch((err) => setError(String(err)));
          }
        }}
        // This composer sends text only, so the add menu holds the turn's
        // mode and the conversation's own tools rather than attachments.
        renderAddMenu={() => (
          <ComposerAddMenu
            onPlan={running ? undefined : () => chooseMode(mode === "plan" ? "build" : "plan")}
            planMode={mode === "plan"}
          >
            <ComposerTurnMenu
              mode={mode}
              modes={["build", "plan", "ask"]}
              modeDisabled={running}
              onModeChange={chooseMode}
            />
            <TimelineMenuItems />
            {options}
          </ComposerAddMenu>
        )}
        footer={
          <>
            {modelControl}
            <TimelineViewSwitch />
          </>
        }
      />
      {error && <ChatNotice onDismiss={() => setError(null)}>{error}</ChatNotice>}
    </div>
  );
}

// ── User prose ────────────────────────────────────────────────────────────

function UserRow({ text, repoRoot }: { text: string; repoRoot: string }) {
  return (
    <Message role="user">
      <div className="ui-chat-user-stack">
        <MessageBody tone="user">
          <LinkifiedText text={text} repoRoot={repoRoot} />
        </MessageBody>
        <MessageActions text={text} />
      </div>
    </Message>
  );
}

// ── Session-init chip ───────────────────────────────────────────────────────

/** The seam where the run ran out of context and its earlier turns were
 *  summarised back into it.
 *
 *  The handoff arrives on the user channel, so it used to render as a message
 *  the person had sent — a thousand words of "1. Primary Request and Intent"
 *  in a bubble styled to say they typed it. It is not a message, but it is not
 *  nothing either: the agent's memory of the conversation changed here, and a
 *  reader who cannot see that is left wondering why it suddenly refers to work
 *  no visible turn describes. So it is a rule across the column, and the
 *  summary is one click away for anyone who wants to know what was kept. */
function CompactionSeam({ summary }: { summary: string }) {
  return (
    <CompactionSummary>
      {summary ? <p className="whitespace-pre-wrap break-words">{summary}</p> : null}
    </CompactionSummary>
  );
}

function InitChip({ ev }: { ev: SessionInitEvent }) {
  const tools = ev.tools?.length ?? 0;
  return (
    <div className="ui-turn-footer ui-transcript-facts">
      <span className="ui-turn-fact">{ev.model ?? "session"}</span>
      {tools > 0 && <span className="ui-turn-fact">{tools} tools</span>}
    </div>
  );
}

// ── Structured prompts ──────────────────────────────────────────────────────

function QuestionSetCard({
  ev,
  onRespondInTerminal,
}: {
  ev: QuestionSetEvent;
  onRespondInTerminal?: () => void;
}) {
  const resolved = ev.partial === false || ev.answer != null;
  return (
    <QuestionRecord
      title={
        resolved
          ? "Question closed"
          : ev.questions.length > 1
            ? `${ev.questions.length} questions`
            : "Question"
      }
      questions={ev.questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        multiple: q.multiSelect,
        options: (q.options ?? []).map((o, i) => ({
          id: `${o.optionId}:${i}`,
          label: o.label,
          description: o.description,
        })),
      }))}
      answer={ev.resolution?.text ?? ev.answer}
      actions={
        !resolved && onRespondInTerminal ? (
          <Button type="button" variant="outline" size="sm" onClick={onRespondInTerminal}>
            Answer in Terminal
          </Button>
        ) : undefined
      }
    />
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
    <PlanReview
      className="chat-plan-review"
      collapsible
      title={heading}
      status={ev.awaitingApproval ? "Ready for review" : ev.decision === "approved" ? "Approved" : ev.decision === "rejected" ? "Declined" : "Plan"}
      meta={
        ev.entries.length
          ? `${ev.entries.length} task${ev.entries.length === 1 ? "" : "s"}`
          : undefined
      }
      actions={
        ev.awaitingApproval && onRespondInTerminal ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onRespondInTerminal}
          >
            Review in Terminal
          </Button>
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
    </PlanReview>
  );
}

function TodoCard({ ev }: { ev: TodoEvent }) {
  const done = ev.todos.filter((t) => t.status === "completed").length;
  return (
    <PlanReview
      className="chat-plan-review"
      title="Checklist"
      status={`${done} of ${ev.todos.length} done`}
    >
      <ol className="chat-plan-tasks">
        {ev.todos.map((t, i) => (
          <li key={t.id ?? i} data-status={t.status}>
            <TodoMark status={t.status} />
            <span>
              {t.status === "in_progress" && t.activeForm
                ? t.activeForm
                : t.content}
            </span>
          </li>
        ))}
      </ol>
    </PlanReview>
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

/** A permission the agent asked for in Terminal, drawn as the shared
 *  permission request. Its answers live in Terminal, so the one choice here
 *  is the way there; once closed it keeps the request and offers nothing. */
function PermissionCard({
  ev,
  onRespondInTerminal,
}: {
  ev: PermissionRequestEvent;
  onRespondInTerminal?: () => void;
}) {
  const open = ev.partial !== false;
  return (
    <PermissionRequest
      title={ev.title}
      agent={open ? "Asking permission" : "Permission request closed"}
      command={ev.toolName}
      choices={
        open && onRespondInTerminal
          ? [{ id: "terminal", label: "Answer in Terminal", primary: true }]
          : []
      }
      onChoose={() => onRespondInTerminal?.()}
    />
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
      className="ui-turn-footer ui-transcript-facts"
      title="Context fed to the model for this response, and the tokens it wrote back."
    >
      {bits.map((bit) => (
        <span key={bit} className="ui-turn-fact">
          {bit}
        </span>
      ))}
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
      className="ui-turn-footer ui-transcript-facts ui-session-usage"
      title="Current context and total output tokens for this conversation."
    >
      <span className="ui-turn-fact">{compactTokens(usage.context)} context</span>
      <span className="ui-turn-fact">{compactTokens(usage.tokens)} output tokens</span>
    </div>
  );
}

/** How the run ended, as the shared turn footer: how long it took (which
 *  opens the tokens and cost it reported), copy, and the outcome. A closing
 *  message is the agent's answer; errors are error rows. */
function ResultFooter({ ev }: { ev: ResultEvent }) {
  const cost = buildTurnCost({model: null, agent: null, startMs: ev.durationMs != null ? ev.ts - ev.durationMs : null, endMs: ev.ts, inputTokens: ev.usage?.inputTokens, outputTokens: ev.usage?.outputTokens, cacheRead: ev.usage?.cacheRead, cacheWrite: ev.usage?.cacheWrite, sessionCostUsd: ev.costUsd, sessionIsRunTotal: true});
  const { usage, usageNote } = turnUsage(cost);
  if (ev.totalTokens != null) usage.push({ label: "Total tokens", value: ev.totalTokens.toLocaleString() });
  const outcome = ev.subtype === "success" ? "Done" : ev.subtype === "cancelled" ? "Cancelled" : "Ended with an error";
  return (
    <div className="flex flex-col">
      {ev.text && (
        <Message role="assistant">
          <MessageBody className="ui-chat-answer">
            <MarkdownBody source={ev.text} />
          </MessageBody>
        </Message>
      )}
      {ev.errors?.map((error, i) => (
        <ChatStatus key={i} state="error">
          {error}
        </ChatStatus>
      ))}
      <TurnFooter
        duration={ev.durationMs != null && ev.durationMs > 0 ? formatDuration(ev.durationMs / 1000) : null}
        text={ev.text ?? ""}
        usage={usage}
        usageNote={usageNote}
      >
        <span className="ui-turn-fact">{outcome}</span>
        {ev.stopReason && <span className="ui-turn-fact">{ev.stopReason}</span>}
      </TurnFooter>
    </div>
  );
}

// ── Inline image ────────────────────────────────────────────────────────────

/** A picture in the conversation — a screenshot the user attached, or one the
 *  agent read back / produced. Shown as a bounded thumbnail; click fills the
 *  window with it. Aligned right for the user, left for the agent, matching
 *  the prose bubbles. */
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
  // This used to be an `<a href>` to the data URL, opened through the system
  // opener. Inside the webview that is two dead ends at once: the anchor has
  // no tab to open, and the opener will not hand the OS a megabyte of base64.
  // Clicking a screenshot in a transcript did nothing at all. The lightbox
  // the chat already uses opens it in place, and brings Copy and Save with it.
  return (
    <div className={mine ? "self-end max-w-[88%]" : "self-start max-w-[88%]"}>
      <ImageLightbox
        src={src}
        alt={mine ? "Attached image" : "Image from the agent"}
        onError={() => setFailed(true)}
        className="chat-media"
      />
    </div>
  );
}

function ErrorRow({ ev }: { ev: ErrorEvent }) {
  return <ChatStatus state="error">{ev.message}</ChatStatus>;
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
    <UnsupportedMessage type={ev.label} raw={all ? text : text.slice(0, limit)}>
      {!all && text.length > limit && (
        <Button type="button" variant="ghost" size="xs" onClick={() => setAll(true)}>
          Show all {text.length.toLocaleString()} characters
        </Button>
      )}
    </UnsupportedMessage>
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
          case "compaction":
            return <CompactionSeam key={g.id} summary={g.summary} />;
          case "stream": {
            // A turn still being written stays in emission order — watching it
            // work is the point while it is working. Once it has settled, the
            // steps fold into one quiet roll-up and the answer stands on its
            // own, which is what the manager chat already does with its turns
            // (TurnActivity) and what an agent's flat stream needs a split to
            // reach.
            const live = running && isLast;
            const { steps, answer } = live
              ? { steps: [], answer: g.blocks }
              : splitSettledTurn(g.blocks);
            return (
              <div key={g.id} className="flex flex-col gap-1">
                {steps.length > 0 && <TurnActivity blocks={steps} />}
                {answer.length > 0 && (
                  <StreamingBubble blocks={answer} streaming={live} />
                )}
                {g.usage && <UsageFooter usage={g.usage} />}
              </div>
            );
          }
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
              <ChatStatus key={g.id} state={g.ev.state === "idle" ? "empty" : "working"}>
                {g.ev.message ??
                  (g.ev.state === "retry"
                    ? "Retrying"
                    : g.ev.state === "busy"
                      ? "Working"
                      : "Idle")}
                {g.ev.attempt != null && ` · attempt ${g.ev.attempt}`}
              </ChatStatus>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

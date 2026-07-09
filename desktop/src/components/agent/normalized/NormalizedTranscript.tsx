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
import { ArrowUp } from "lucide-react";

import { api } from "../../../lib/api";
import { useAgentStream } from "../../../lib/agentStreamStore";
import { normalizeStream } from "../../../lib/agentProtocol";
import type {
  ErrorEvent,
  ImageEvent,
  PermissionRequestEvent,
  PlanEvent,
  QuestionSetEvent,
  ResultEvent,
  SessionInitEvent,
  TodoEvent,
} from "../../../lib/agentProtocol";
import { StreamingBubble } from "../../manager/chat/ToolCard";
import { MarkdownBody } from "../../manager/chat/Markdown";
import { Button } from "../../ui/button";
import { toTranscriptGroups, type GroupUsage } from "./blockMap";
import { LinkifiedText } from "./TaskChip";

export function NormalizedTranscript({
  channel,
  agentId,
  repoRoot,
  ptySessionId,
  onRespondInTerminal,
}: {
  channel: string;
  agentId: string;
  repoRoot: string;
  /** The Tauri PTY handle this transcript mirrors. Typing in the composer
   *  injects straight into THIS child via `agent_pty_send_prompt`, so the
   *  Chat view answers the agent without flipping to the raw terminal. */
  ptySessionId: string;
  /** Jump back to the live Terminal view (where the agent's prompts are
   *  actually answered). Shown on question / permission / plan cards. */
  onRespondInTerminal?: () => void;
}) {
  const { events, sessionId, running } = useAgentStream(channel);
  const sid = sessionId ?? "";

  const groups = useMemo(() => {
    const normalized = normalizeStream(agentId, events, sid) ?? [];
    return toTranscriptGroups(normalized);
  }, [agentId, events, sid]);

  // Running cost of THIS AI session, accreted from the same per-response usage
  // the footers show. `context` is the conversation's current size (the latest
  // response's context — it grows as the thread does, it doesn't sum); `tokens`
  // is everything the model has written across the session. We can't show
  // "remaining" — a CLI agent gives us no quota — but this is the honest "how
  // much have I used on this one" the chat was missing.
  const sessionUsage = useMemo(() => {
    let context = 0;
    let tokens = 0;
    let any = false;
    for (const g of groups) {
      if (g.kind === "stream" && g.usage) {
        any = true;
        context = g.usage.context; // latest wins → current thread size
        tokens += g.usage.output;
      }
    }
    return any ? { context, tokens } : null;
  }, [groups]);

  // Stick to the bottom as new content lands, like a live chat. Watching only
  // `groups.length` misses the common case where the trailing group is one
  // long streaming paragraph that grows in place (no new group) — the view
  // would freeze while text appended below the fold. Fold in the tail group's
  // prose length so each char-drip tick re-pins to the bottom.
  const tailLen = useMemo(() => {
    const last = groups[groups.length - 1];
    if (!last || last.kind !== "stream") return 0;
    return last.blocks.reduce(
      (n, b) => n + (b.kind === "text" || b.kind === "reasoning" ? b.text.length : 0),
      0,
    );
  }, [groups]);

  // Auto-scroll, but NEVER fight the reader. A live (often background) agent
  // drips characters every few ms; the old code re-pinned to the bottom on
  // every tick via `scrollIntoView`, which (a) walks every scroll ancestor —
  // visible flicker — and (b) yanks the viewport out from under any text the
  // user is mid-select. Two guards fix both: only re-pin when the user is
  // already parked at the bottom (scrolled up = they're reading history, leave
  // them), and never while a text selection is live inside the transcript. We
  // scroll the container's own `scrollTop` (not `scrollIntoView`) so only this
  // pane moves, never an ancestor.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stuckToBottomRef = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stuckToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stuckToBottomRef.current) return;
    // A live, non-collapsed selection anchored inside this pane means the user
    // is actively selecting — re-pinning would collapse it. Hands off.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [groups.length, running, tailLen]);

  return (
    <div className="aura-chat h-full w-full flex flex-col min-h-0">
      {sessionUsage && <SessionUsageStrip usage={sessionUsage} />}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ userSelect: "text" }}
      >
        {groups.length === 0 ? (
          <div className="h-full w-full flex items-center justify-center px-6">
            <div className="text-center max-w-[340px]">
              <div className="text-[13px] font-medium text-text-2">
                Ready when you are
              </div>
              <div className="mt-1 text-[12px] leading-relaxed text-text-3">
                Type below to talk to the agent — your message goes straight to
                it. As it works, this fills in with a clean, readable view of
                what it reads, edits, runs and decides. The live terminal is a
                tab away.
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[760px] px-5 py-4 flex flex-col gap-3">
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
                      ptySessionId={ptySessionId}
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
                default:
                  return null;
              }
            })}
          </div>
        )}
      </div>
      <AgentComposer ptySessionId={ptySessionId} running={running} />
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

/** The Chat view's own composer — same calm look as the Aura manager chat,
 *  but it injects straight into the agent's live PTY child via
 *  `agent_pty_send_prompt` (the bracketed-paste path the terminal uses).
 *  So you can answer / steer the agent from the readable Chat view without
 *  flipping to the raw terminal. Mid-run sends queue into the agent the same
 *  way typing in the terminal would. */
function AgentComposer({
  ptySessionId,
  running,
}: {
  ptySessionId: string;
  running: boolean;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = text.trim().length > 0;

  // Grow the textarea with its content, capped so a long paste doesn't eat the
  // transcript. Mirrors the manager composer's auto-size feel.
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  async function send() {
    const t = text.trim();
    if (!t) return;
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    try {
      await api.agentPtySendPrompt(ptySessionId, t);
    } catch (e) {
      console.warn("[agent-chat] send failed:", e);
    }
    taRef.current?.focus();
  }

  return (
    <div className="flex-shrink-0 border-t border-line-soft bg-bg-1 px-3 py-2.5">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-end gap-2 rounded-lg border border-line-soft bg-bg-2 px-2.5 py-2 transition-colors focus-within:border-accent/40">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Message the agent — sent straight into its session"
            className="flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-text-1 outline-none placeholder:text-text-4"
            style={{ maxHeight: 160 }}
          />
          <Button
            type="button"
            variant="default"
            size="sm"
            className="font-mono"
            disabled={!canSend}
            onClick={() => void send()}
            title="Send (↵)"
          >
            <ArrowUp aria-hidden />
            <span className="send-kbd">⏎</span>
          </Button>
        </div>
        <div className="mt-1 px-0.5 text-[10.5px] text-text-4">
          {running
            ? "The agent is working — your message queues into its session."
            : "Replies run in the live agent. Switch to Terminal for its full controls."}
        </div>
      </div>
    </div>
  );
}

// ── User prose ────────────────────────────────────────────────────────────

function UserRow({ text, repoRoot }: { text: string; repoRoot: string }) {
  return (
    <div className="self-end max-w-[88%]">
      <div
        className="rounded-lg px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
          color: "var(--color-text-1)",
          border: "1px solid color-mix(in srgb, var(--color-accent) 22%, transparent)",
        }}
      >
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
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: "var(--color-accent)" }}
      />
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
    <div
      className="rounded-lg overflow-hidden"
      style={{
        background: "var(--color-bg-1)",
        border: "1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-line-soft))",
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{
          color: "var(--color-accent)",
          background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
        }}
      >
        {label}
      </div>
      <div className="px-3 py-2.5">{children}</div>
      {onRespondInTerminal && (
        <button
          type="button"
          onClick={onRespondInTerminal}
          className="w-full px-3 py-1.5 text-[11.5px] font-medium text-left transition-colors hover:opacity-90"
          style={{
            color: "var(--color-text-2)",
            borderTop: "1px solid var(--color-line-soft)",
            background: "color-mix(in srgb, var(--color-bg-2) 60%, transparent)",
          }}
        >
          Answer in the terminal ↡
        </button>
      )}
    </div>
  );
}

function QuestionSetCard({
  ev,
  ptySessionId,
  onRespondInTerminal,
}: {
  ev: QuestionSetEvent;
  ptySessionId: string;
  onRespondInTerminal?: () => void;
}) {
  // The option the user clicked, keyed by `${questionId}:${optionId}`. Clicking
  // sends the option's text straight into the live agent over the SAME PTY
  // transport the composer uses (`agent_pty_send_prompt`) — so picking an
  // answer here lands in the agent exactly as if the user had typed it, no
  // flip to the terminal. We mark it optimistically so the card reads as
  // answered the instant it's clicked.
  const [picked, setPicked] = useState<Record<string, string>>({});

  async function pick(questionId: string, optionId: string, answer: string) {
    setPicked((p) => ({ ...p, [questionId]: optionId }));
    try {
      await api.agentPtySendPrompt(ptySessionId, answer);
    } catch (e) {
      console.warn("[agent-chat] answer failed:", e);
    }
  }

  return (
    <PromptCard
      label={ev.questions.length > 1 ? `${ev.questions.length} questions` : "Question"}
      onRespondInTerminal={onRespondInTerminal}
    >
      <div className="flex flex-col gap-3">
        {ev.questions.map((q) => {
          const answered = picked[q.id];
          return (
            <div key={q.id}>
              <div className="text-[13px] font-medium text-text-1">{q.prompt}</div>
              {q.options && q.options.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1">
                  {q.options.map((o) => {
                    const isPicked = answered === o.optionId;
                    return (
                      <button
                        key={o.optionId}
                        type="button"
                        onClick={() => void pick(q.id, o.optionId, o.label)}
                        className="flex items-start gap-2 px-2 py-1.5 rounded text-[12.5px] text-left transition-colors"
                        style={{
                          background: isPicked
                            ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
                            : "var(--color-bg-2)",
                          color: "var(--color-text-2)",
                          border: isPicked
                            ? "1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)"
                            : "1px solid transparent",
                          cursor: "pointer",
                        }}
                      >
                        <span
                          className="text-text-1"
                          style={isPicked ? { color: "var(--color-accent)" } : undefined}
                        >
                          {isPicked ? "✓ " : ""}
                          {o.label}
                        </span>
                        {o.description && (
                          <span className="text-text-3">— {o.description}</span>
                        )}
                      </button>
                    );
                  })}
                  <div className="text-[10.5px] text-text-3 mt-0.5">
                    {answered
                      ? "Sent to the agent."
                      : q.multiSelect
                        ? "Pick the closest — it goes straight to the agent."
                        : "Click an answer — it goes straight to the agent."}
                  </div>
                </div>
              )}
            </div>
          );
        })}
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
  return (
    <PromptCard
      label={ev.awaitingApproval ? "Plan — awaiting your go-ahead" : "Plan"}
      onRespondInTerminal={ev.awaitingApproval ? onRespondInTerminal : undefined}
    >
      {ev.markdown ? (
        <MarkdownBody source={ev.markdown} />
      ) : (
        <ol className="list-decimal pl-4 flex flex-col gap-1 text-[13px] text-text-1">
          {ev.entries.map((e, i) => (
            <li key={i}>{e.content}</li>
          ))}
        </ol>
      )}
    </PromptCard>
  );
}

function TodoCard({ ev }: { ev: TodoEvent }) {
  return (
    <div
      className="rounded-lg px-3 py-2.5"
      style={{
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line-soft)",
      }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-3 mb-1.5">
        Checklist
      </div>
      <div className="flex flex-col gap-1">
        {ev.todos.map((t, i) => (
          <div key={t.id ?? i} className="flex items-center gap-2 text-[12.5px]">
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
              {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TodoMark({ status }: { status: "pending" | "in_progress" | "completed" }) {
  const color =
    status === "completed"
      ? "var(--color-positive, #16a34a)"
      : status === "in_progress"
        ? "var(--color-accent)"
        : "var(--color-line-strong, var(--color-line-soft))";
  return (
    <span
      className="inline-block w-3 h-3 rounded-full flex-shrink-0"
      style={{
        border: `1.5px solid ${color}`,
        background:
          status === "completed"
            ? color
            : status === "in_progress"
              ? "color-mix(in srgb, var(--color-accent) 30%, transparent)"
              : "transparent",
      }}
    />
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
    <PromptCard label="Asking permission" onRespondInTerminal={onRespondInTerminal}>
      <div className="text-[13px] font-medium text-text-1">{ev.title}</div>
      <div className="mt-1 text-[12px] text-text-3 font-mono break-all">
        {ev.toolName}
      </div>
      {/* The agent only stops to ask because it's not on full autonomy. We
          deliberately don't wire Allow/Deny buttons here: a wrong guess at a
          permission gate could auto-approve something destructive, and the
          exact keystroke differs per agent. The honest cure is the Approvals
          control — set it to Full autonomy and the agent just runs, like a
          normal Claude Code session. Until then, answer in the terminal. */}
      <div className="mt-2 text-[11.5px] leading-relaxed text-text-3">
        It's pausing because it isn't running on full autonomy. Set{" "}
        <span className="font-medium text-text-2">Approvals → Full autonomy</span>{" "}
        in the composer to let it run without asking.
      </div>
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
function SessionUsageStrip({ usage }: { usage: { context: number; tokens: number } }) {
  return (
    <div
      className="flex-shrink-0 flex items-center justify-end gap-1.5 px-4 py-1 text-[10.5px] text-text-4 border-b border-line-soft/60"
      title="This conversation's current size and the tokens this AI has written so far. CLI agents don't report how much you have left, so this is what's been used, not what remains."
    >
      <span className="font-medium text-text-3">This session</span>
      <span>·</span>
      <span>{compactTokens(usage.context)} context</span>
      <span>·</span>
      <span>{compactTokens(usage.tokens)} tokens used</span>
    </div>
  );
}

function ResultFooter({ ev }: { ev: ResultEvent }) {
  const ok = ev.subtype === "success";
  const bits: string[] = [];
  if (ev.durationMs != null) bits.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
  if (ev.usage?.outputTokens) bits.push(`${ev.usage.outputTokens.toLocaleString()} tok`);
  if (ev.costUsd != null) bits.push(`$${ev.costUsd.toFixed(3)}`);
  return (
    <div className="flex items-center gap-2 text-[11px] text-text-3 pt-1">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{
          background: ok
            ? "var(--color-positive, #16a34a)"
            : "var(--color-negative, #dc2626)",
        }}
      />
      <span className="font-medium">{ok ? "Done" : "Ended with an error"}</span>
      {bits.length > 0 && <span>· {bits.join(" · ")}</span>}
    </div>
  );
}

// ── Inline image ────────────────────────────────────────────────────────────

/** A picture in the conversation — a screenshot the user attached, or one the
 *  agent read back / produced. Shown as a bounded thumbnail; click opens the
 *  full-size image in a new tab. Aligned right for the user, left for the
 *  agent, matching the prose bubbles. */
function ImageBubble({ ev }: { ev: ImageEvent }) {
  const src = `data:${ev.mediaType || "image/png"};base64,${ev.data}`;
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
        background: "color-mix(in srgb, var(--color-negative, #dc2626) 8%, transparent)",
        color: "var(--color-negative, #dc2626)",
        border: "1px solid color-mix(in srgb, var(--color-negative, #dc2626) 28%, transparent)",
      }}
    >
      {ev.message}
    </div>
  );
}

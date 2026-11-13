// Chat surface for the `openai-compat` agent kind. Drives any HTTP
// endpoint that speaks OpenAI's `/v1/chat/completions` shape — Ollama,
// HuggingFace TGI, Together, Groq, OpenRouter, a self-hosted vLLM, …
//
// Unlike the PTY-backed agent kinds in this folder, this surface owns
// the message list locally (React state) and ferries SSE deltas back
// from `cmd_openai_compat.rs` via the `openai-compat:chunk:<profile>`
// Tauri event. Each user turn mints a `turn_id` so concurrent profiles
// can stream without their bubbles cross-pollinating.
//
// Markdown rendering reuses `MarkdownView`'s react-markdown + remark-gfm
// pipeline. Code blocks fall back to react-markdown's default `<pre>`
// styling — we don't pull in syntax highlighting here because the
// chat-surface intent is "show the model's prose"; users who want
// editor-grade rendering open the agent's output in a file tab.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type OpenAiCompatProfile } from "../../lib/api";
import type { AgentTab } from "../../lib/editorStore";
import {
  accumulateCompletion,
  type CompletionState,
} from "../../lib/chatCompletion";
import { Eraser, RotateCcw } from "lucide-react";
import { Composer } from "../ui/composer";
import { ModelPicker } from "../ui/model-picker";
import { openModelSettings } from "../chat/model/openModelSettings";
import { ComposerAddMenu } from "../ui/composer-tools";
import { ChatNotice } from "../ui/chat-surface";
import "../chat/ChatComposer.css";
import "../ui/chat-composer.css";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TimelineMenuItems } from "./normalized/timelineTools";
import { ChatTimeline } from "./normalized/NormalizedTranscript";
import { toTranscriptGroups } from "./normalized/blockMap";
import type { NormalizedEvent } from "../../lib/agentProtocol";

type Props = {
  tab: AgentTab;
};

type ChatRole = "user" | "assistant" | "system";

type Message = CompletionState & {
  /** Stable client-side id. Also used as the React key. */
  id: string;
  role: ChatRole;
  content: string;
  /** True while the streamer is still appending into this bubble. */
  streaming?: boolean;
  /** Non-empty when the request errored mid-flight. */
  error?: string;
  cancelled?: boolean;
};

// localStorage key — keeps the conversation across reloads/restarts so
// the user doesn't lose their thread on shell update. Bound to (session,
// profile) so multiple chat tabs on the same workspace stay separated.
function historyKey(sessionId: string, profile: string | undefined): string {
  return `aura.openai-compat.chat.${sessionId}.${profile ?? "_"}`;
}

function loadHistory(
  sessionId: string,
  profile: string | undefined,
): Message[] {
  try {
    const raw = localStorage.getItem(historyKey(sessionId, profile));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (
      parsed
        .filter(
          (m): m is Message =>
            m &&
            typeof m.id === "string" &&
            (m.role === "user" ||
              m.role === "assistant" ||
              m.role === "system") &&
            typeof m.content === "string",
        )
        // Strip the in-flight flag from any message that was mid-stream when
        // the shell died; otherwise the "Stop" button would appear forever.
        .map((m) => ({
          ...m,
          streaming: false,
          error: m.streaming
            ? "Response interrupted when the app closed. Partial output is saved."
            : m.error,
        }))
    );
  } catch {
    return [];
  }
}

function saveHistory(
  sessionId: string,
  profile: string | undefined,
  list: Message[],
) {
  try {
    localStorage.setItem(historyKey(sessionId, profile), JSON.stringify(list));
  } catch {
    /* quota — ignore */
  }
}

function newId(): string {
  // Cheap monotonic id good enough for in-process keying. We don't need
  // crypto-grade entropy — collisions would only matter for the React
  // diff, and the timestamp + random tail rules that out in practice.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function OpenAiCompatChatView({ tab }: Props) {
  const profileName = tab.openaiCompatProfile ?? "";
  const [profile, setProfile] = useState<OpenAiCompatProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>(() =>
    loadHistory(tab.sessionId, profileName),
  );
  const [composer, setComposer] = useState(() => {
    try {
      return sessionStorage.getItem(`aura.model-draft.${tab.sessionId}`) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`aura.model-draft.${tab.sessionId}`, composer);
    } catch {
      /* draft preference */
    }
  }, [composer, tab.sessionId]);
  const [streaming, setStreaming] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const stuckToBottom = useRef(true);
  // Track the turn id of the in-flight assistant bubble. Used by the
  // Stop button to call `openai_compat_cancel` and by the event
  // listener to know which bubble to append into.
  const activeTurnRef = useRef<{ turnId: string; assistantId: string } | null>(
    null,
  );
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Resolve the profile on mount / profile-change so the header can show
  // its display name + model. We fetch the live profile rather than
  // trusting the AgentTab so a Settings edit immediately reflects here.
  useEffect(() => {
    let cancelled = false;
    if (!profileName) {
      setProfile(null);
      setProfileError(
        "This chat tab isn't bound to a profile yet. Open Settings → Local & Custom Models to add one, then re-open this tab.",
      );
      return;
    }
    api
      .openaiCompatProfilesList()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((p) => p.name === profileName);
        if (!found) {
          setProfile(null);
          setProfileError(
            `Profile "${profileName}" no longer exists. Open Settings → Local & Custom Models to recreate it.`,
          );
          return;
        }
        setProfile(found);
        setProfileError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setProfileError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [profileName]);

  // Subscribe to stream chunks. One channel per profile — every running
  // tab using the same profile will see chunks for every turn, but each
  // turn carries its own id so we only mutate the matching assistant
  // bubble.
  useEffect(() => {
    if (!profileName) return;
    setStreamReady(false);
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const stop = await listen<{
        profile: string;
        turn_id: string;
        kind: "delta" | "done" | "error" | "event";
        data?: unknown;
        content?: string;
        message?: string;
      }>(`openai-compat:chunk:${profileName}`, (e) => {
        const payload = e.payload;
        const active = activeTurnRef.current;
        if (!active || active.turnId !== payload.turn_id) return;
        if (payload.kind === "event") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === active.assistantId
                ? accumulateCompletion(m, payload.data)
                : m,
            ),
          );
        } else if (payload.kind === "delta") {
          const chunk = payload.content ?? "";
          if (!chunk) return;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === active.assistantId);
            if (idx < 0) return prev;
            const next = prev.slice();
            next[idx] = {
              ...next[idx],
              content: next[idx].content + chunk,
              streaming: true,
            };
            return next;
          });
        } else if (payload.kind === "done") {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === active.assistantId);
            if (idx < 0) return prev;
            const next = prev.slice();
            next[idx] = { ...next[idx], streaming: false };
            return next;
          });
          setStreaming(false);
          activeTurnRef.current = null;
        } else if (payload.kind === "error") {
          const msg = payload.message ?? "stream error";
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === active.assistantId);
            if (idx < 0) return prev;
            const next = prev.slice();
            next[idx] = {
              ...next[idx],
              streaming: false,
              error: msg,
            };
            return next;
          });
          setStreaming(false);
          activeTurnRef.current = null;
        }
      });
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
      setStreamReady(true);
    })().catch((e) => {
      if (!cancelled)
        setSendError(`Could not connect to the response stream. ${String(e)}`);
    });
    return () => {
      cancelled = true;
      unlisten?.();
      const active = activeTurnRef.current;
      activeTurnRef.current = null;
      if (active) {
        saveHistory(
          tab.sessionId,
          profileName,
          messagesRef.current.map((m) =>
            m.id === active.assistantId
              ? {
                  ...m,
                  streaming: false,
                  error:
                    "Response interrupted when the tab closed. Partial output is saved.",
                }
              : m,
          ),
        );
        void api.openaiCompatCancel(profileName, active.turnId).catch(() => {});
      }
    };
  }, [profileName, tab.sessionId]);

  // Persist history on every change so a shell crash mid-conversation
  // doesn't lose the thread. Strip the volatile `streaming` flag at
  // load time (see loadHistory).
  useEffect(() => {
    saveHistory(tab.sessionId, profileName, messages);
  }, [tab.sessionId, profileName, messages]);

  // Auto-scroll to the bottom on new content unless the user has
  // scrolled up to read history. We compare the saved scroll position
  // against a near-bottom threshold so a tiny manual offset (the user
  // glancing at the previous turn) doesn't fight every streamed token.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const selection = window.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      selection.anchorNode &&
      el.contains(selection.anchorNode)
    )
      return;
    if (stuckToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const text = composer.trim();
    if (!text) return;
    if (!profile) return;
    if (activeTurnRef.current || !streamReady) return;
    setSendError(null);
    setCleared(null);

    const userMsg: Message = {
      id: newId(),
      role: "user",
      content: text,
    };
    const assistantMsg: Message = {
      id: newId(),
      role: "assistant",
      content: "",
      streaming: true,
    };
    const turnId = newId();
    activeTurnRef.current = {
      turnId,
      assistantId: assistantMsg.id,
    };
    setStreaming(true);
    setComposer("");
    // Snapshot the chat history we want to send up — everything we have
    // so far PLUS this user turn. We pass `role`+`content` only so the
    // Rust side doesn't have to know about our internal id/streaming
    // flags.
    const baseHistory = messagesRef.current
      .filter((m) => !m.error && !m.cancelled)
      .map(({ role, content }) => ({ role, content }));
    const payload = [
      ...baseHistory,
      { role: userMsg.role, content: userMsg.content },
    ];
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      await api.openaiCompatChat(profile.name, turnId, payload);
    } catch (e) {
      if (activeTurnRef.current?.turnId !== turnId) return;
      const msg = String(e);
      setSendError(msg);
      setComposer((current) => current || text);
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantMsg.id);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], streaming: false, error: msg };
        return next;
      });
      setStreaming(false);
      activeTurnRef.current = null;
    }
  }, [composer, profile, streamReady]);

  const stop = useCallback(async () => {
    const active = activeTurnRef.current;
    if (!active || !profile) return;
    try {
      await api.openaiCompatCancel(profile.name, active.turnId);
      if (activeTurnRef.current?.turnId !== active.turnId) return;
      activeTurnRef.current = null;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === active.assistantId
            ? { ...m, streaming: false, cancelled: true }
            : m,
        ),
      );
      setStreaming(false);
    } catch (e) {
      setSendError(`Could not stop the response. ${String(e)}`);
    }
  }, [profile]);

  const [cleared, setCleared] = useState<Message[] | null>(null);
  const clear = useCallback(() => {
    if (streaming) return;
    setCleared(messagesRef.current);
    setMessages([]);
  }, [streaming]);

  // Keyboard model: Enter sends, Shift+Enter adds a newline. Familiar
  // from every other chat surface in the shell (Composer, Manager).
  const displayLabel = profile?.name ?? profileName ?? "Local Model";
  const subtitle = useMemo(() => {
    if (!profile) return tab.sessionId.slice(0, 8) + " · openai-compat";
    return `${profile.model} · ${shortBase(profile.base_url)}`;
  }, [profile, tab.sessionId]);

  const groups = useMemo(() => {
    const normalized: NormalizedEvent[] = [];
    for (const m of messages) {
      const env = {
        sessionId: tab.sessionId,
        turnId: m.id,
        ts: 0,
        source: m.role === "user" ? ("user" as const) : ("agent" as const),
      };
      if (m.role === "system") {
        normalized.push({
          ...env,
          id: m.id,
          kind: "raw",
          label: "System context",
          payload: m.content,
        });
        continue;
      }
      if (m.reasoning)
        normalized.push({
          ...env,
          id: `${m.id}:reasoning`,
          kind: "reasoning",
          text: m.reasoning,
          partial: m.streaming,
        });
      if (m.content)
        normalized.push({
          ...env,
          id: m.id,
          kind: "text",
          role: m.role,
          text: m.content,
          partial: m.streaming,
        });
      if (m.refusal)
        normalized.push({
          ...env,
          id: `${m.id}:refusal`,
          kind: "text",
          role: "assistant",
          text: m.refusal,
        });
      for (const t of m.tools ?? [])
        normalized.push({
          ...env,
          id: `${m.id}:tool:${t.index}`,
          kind: "raw",
          label: `Tool request · ${t.name || "receiving arguments"}`,
          payload: {
            ...t,
            status: "Requested by the model. This chat does not execute tools.",
          },
        });
      for (const [i, part] of (m.parts ?? []).entries())
        normalized.push({
          ...env,
          id: `${m.id}:part:${i}`,
          kind: "raw",
          label: "Model content",
          payload: part,
        });
      if (m.usage)
        normalized.push({
          ...env,
          id: `${m.id}:usage`,
          kind: "usage",
          contextTokens: m.usage.input,
          outputTokens: m.usage.output,
        });
      if (m.role === "assistant" && !m.streaming)
        normalized.push({
          ...env,
          id: `${m.id}:result`,
          kind: "result",
          subtype: m.cancelled ? "cancelled" : m.error ? "error" : "success",
          text:
            m.error ??
            (m.finishReason === "length"
              ? "Output limit reached. Continue the conversation for more."
              : m.finishReason === "content_filter"
                ? "The provider filtered part of this response."
                : undefined),
          errors: m.error ? [m.error] : undefined,
          totalTokens: m.usage?.total,
        });
    }
    return toTranscriptGroups(normalized, tab.sessionId);
  }, [messages, tab.sessionId]);
  return (
    <ChatTimeline
      groups={groups}
      running={streaming}
      agentId="openai-compat"
      repoRoot={tab.repoRoot}
      controls={
        <>
          {cleared && (
            <ChatNotice onDismiss={() => setCleared(null)}>
              Conversation cleared.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setMessages(cleared);
                  setCleared(null);
                }}
              >
                Undo
              </button>
            </ChatNotice>
          )}
          {profileError && <ChatNotice>{profileError}</ChatNotice>}
          {sendError && <ChatNotice>{sendError}</ChatNotice>}
        </>
      }
      composer={
        <div className="agent-chat-composer">
          <Composer
            value={composer}
            onChange={setComposer}
            onSend={() => void send()}
            onStop={() => void stop()}
            running={streaming}
            disabled={!profile || !streamReady}
            ariaLabel="Message the model"
            textareaRef={composerRef}
            placeholder={
              profile ? `Message ${profile.model}…` : "Set up a model in Settings"
            }
            // No mode and no files: this chat can only ask — it has no tools
            // to run and nothing to edit — so its menu is the conversation's.
            renderAddMenu={() => (
              <ComposerAddMenu>
                <TimelineMenuItems />
                <DropdownMenuSeparator />
                {!streaming && messages.some((m) => m.error || m.cancelled) && (
                  <DropdownMenuItem
                    onSelect={() => {
                      const last = [...messages].reverse().find((m) => m.role === "user");
                      if (last) setComposer(last.content);
                      requestAnimationFrame(() => composerRef.current?.focus());
                    }}
                  >
                    <RotateCcw />
                    Retry last message
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!messages.length || streaming} onSelect={clear}>
                  <Eraser />
                  Clear conversation
                </DropdownMenuItem>
              </ComposerAddMenu>
            )}
            footer={
              // The endpoint this tab is bound to serves one model, so the
              // picker lists that one; Edit goes to where endpoints are set up.
              <ModelPicker
                models={[
                  {
                    id: profile?.model || displayLabel,
                    name: profile?.model || displayLabel,
                    provider: subtitle,
                  },
                ]}
                value={{ model: profile?.model || displayLabel }}
                onChange={() => {}}
                onEdit={() => openModelSettings("local-models")}
                disabled={!profile}
              />
            }
          />
        </div>
      }
    />
  );
}

function shortBase(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

// Minimal markdown component map — code blocks render in a tinted
// surface, links open in a new tab. Kept inline so this surface
// doesn't pull a styling dep across the agent folder.

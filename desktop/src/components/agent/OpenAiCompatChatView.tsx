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
import { onExternalAnchorClick } from "../../lib/openExternal";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCallouts } from "../markdown/remarkCallouts";
import { calloutFromBlockquote } from "../markdown/Callout";
import { api, type OpenAiCompatProfile } from "../../lib/api";
import type { AgentTab } from "../../lib/editorStore";
import { AgentIcon, brandFor } from "./AgentIcon";

type Props = {
  tab: AgentTab;
};

type ChatRole = "user" | "assistant" | "system";

type Message = {
  /** Stable client-side id. Also used as the React key. */
  id: string;
  role: ChatRole;
  content: string;
  /** True while the streamer is still appending into this bubble. */
  streaming?: boolean;
  /** Non-empty when the request errored mid-flight. */
  error?: string;
};

// localStorage key — keeps the conversation across reloads/restarts so
// the user doesn't lose their thread on shell update. Bound to (session,
// profile) so multiple chat tabs on the same workspace stay separated.
function historyKey(sessionId: string, profile: string | undefined): string {
  return `aura.openai-compat.chat.${sessionId}.${profile ?? "_"}`;
}

function loadHistory(sessionId: string, profile: string | undefined): Message[] {
  try {
    const raw = localStorage.getItem(historyKey(sessionId, profile));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is Message =>
          m &&
          typeof m.id === "string" &&
          typeof m.role === "string" &&
          typeof m.content === "string",
      )
      // Strip the in-flight flag from any message that was mid-stream when
      // the shell died; otherwise the "Stop" button would appear forever.
      .map((m) => ({ ...m, streaming: false }));
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
  const [composer, setComposer] = useState("");
  const [streaming, setStreaming] = useState(false);
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
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const stop = await listen<{
        profile: string;
        turn_id: string;
        kind: "delta" | "done" | "error";
        content?: string;
        message?: string;
      }>(`openai-compat:chunk:${profileName}`, (e) => {
        const payload = e.payload;
        const active = activeTurnRef.current;
        if (!active || active.turnId !== payload.turn_id) return;
        if (payload.kind === "delta") {
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
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [profileName]);

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
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const send = useCallback(async () => {
    const text = composer.trim();
    if (!text) return;
    if (!profile) return;
    if (streaming) return;

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
      .filter((m) => !m.error)
      .map(({ role, content }) => ({ role, content }));
    const payload = [...baseHistory, { role: userMsg.role, content: userMsg.content }];
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      await api.openaiCompatChat(profile.name, turnId, payload);
    } catch (e) {
      const msg = String(e);
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
  }, [composer, profile, streaming]);

  const stop = useCallback(async () => {
    const active = activeTurnRef.current;
    if (!active || !profile) return;
    try {
      await api.openaiCompatCancel(profile.name, active.turnId);
    } catch (e) {
      console.warn("[openai-compat] cancel failed:", e);
    }
    // Don't tear down activeTurnRef here — the cancel races against
    // in-flight chunks; we let the eventual `done` payload do the
    // bookkeeping so the assistant bubble shows whatever made it
    // through before the upstream tore down.
  }, [profile]);

  const clear = useCallback(() => {
    if (streaming) return;
    setMessages([]);
  }, [streaming]);

  // Keyboard model: Enter sends, Shift+Enter adds a newline. Familiar
  // from every other chat surface in the shell (Composer, Manager).
  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const brand = brandFor("openai-compat");
  const displayLabel = profile?.name ?? profileName ?? "Local Model";
  const subtitle = useMemo(() => {
    if (!profile) return tab.sessionId.slice(0, 8) + " · openai-compat";
    return `${profile.model} · ${shortBase(profile.base_url)}`;
  }, [profile, tab.sessionId]);

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      {/* Header — same chrome shape as AgentSurface's PTY header so
          tab strip + workpane feel cohesive across kinds. */}
      <div
        className="flex items-center gap-2.5 h-11 px-3 border-b bg-bg-chrome"
        style={{
          borderBottomColor: `color-mix(in srgb, ${brand.fg} 22%, var(--color-line-soft))`,
          boxShadow: `inset 0 -2px 0 0 color-mix(in srgb, ${brand.fg} 38%, transparent)`,
        }}
      >
        <div
          className="flex items-center justify-center flex-shrink-0"
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: brand.bg,
            border: `1px solid ${brand.ring}`,
          }}
        >
          <AgentIcon agentId="openai-compat" size={20} />
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-text-1 text-base font-semibold truncate">
            {displayLabel}
          </span>
          <span className="text-text-5 text-2xs font-mono truncate">
            {subtitle}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {profile?.api_key ? null : profile ? (
            <span
              className="text-2xs font-mono px-1.5 py-0.5 rounded"
              style={{
                // "No key set" is a caveat you may need to act on, not a
                // feature — the amber slot, same as every other warning chip.
                color: "var(--color-amber)",
                background: "color-mix(in srgb, var(--color-amber) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-amber) 40%, transparent)",
              }}
              title="No API key set. Fine for Ollama, required for hosted endpoints."
            >
              no-key
            </span>
          ) : null}
          <button
            type="button"
            onClick={clear}
            disabled={messages.length === 0 || streaming}
            className="px-2 h-6 rounded text-xs font-medium border transition-colors disabled:opacity-40"
            style={{
              background: "color-mix(in srgb, var(--color-bg-1) 70%, transparent)",
              color: "var(--color-text-3)",
              borderColor: "var(--color-line-soft)",
            }}
            title="Clear conversation"
          >
            Clear
          </button>
        </div>
      </div>

      {profileError && (
        <div
          role="alert"
          className="px-4 py-2 text-sm border-b"
          style={{
            color: "var(--color-red)",
            background: "color-mix(in srgb, var(--color-red) 10%, transparent)",
            borderBottomColor: "color-mix(in srgb, var(--color-red) 40%, transparent)",
          }}
        >
          {profileError}
        </div>
      )}

      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ background: "var(--color-bg-content)" }}
      >
        <div className="max-w-[860px] mx-auto px-6 py-5 flex flex-col gap-4">
          {messages.length === 0 && (
            <div className="text-text-5 text-base py-8 text-center">
              {profile
                ? `Send a message to ${profile.model}.`
                : "Configure a profile in Settings → Local & Custom Models."}
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
        </div>
      </div>

      <div
        className="flex-shrink-0 border-t px-4 py-3 flex gap-2 items-end"
        style={{
          borderTopColor: "var(--color-line-soft)",
          background: "var(--color-bg-1)",
        }}
      >
        <textarea
          ref={composerRef}
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder={
            profile
              ? `Message ${profile.model} (Enter to send, Shift+Enter for newline)`
              : "Pick a profile in Settings first"
          }
          disabled={!profile || streaming}
          rows={2}
          className="flex-1 min-w-0 resize-none rounded bg-bg-0 border border-line-soft text-text-1 text-base px-3 py-2 placeholder:text-text-5 focus:outline-none focus:border-line disabled:opacity-50"
        />
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            className="px-3 h-9 rounded text-sm font-medium border transition-colors"
            style={{
              background: "color-mix(in srgb, var(--color-red) 10%, transparent)",
              color: "var(--color-red)",
              borderColor: "color-mix(in srgb, var(--color-red) 40%, transparent)",
            }}
            title="Stop the in-flight turn"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!composer.trim() || !profile}
            className="px-4 h-9 rounded text-sm font-medium border transition-colors disabled:opacity-40"
            style={{
              background: brand.bg,
              color: brand.fg,
              borderColor: brand.ring,
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const align = isUser ? "items-end" : "items-start";
  const bg = isUser
    ? "color-mix(in srgb, var(--color-bg-3) 100%, transparent)"
    : "color-mix(in srgb, var(--color-bg-1) 80%, transparent)";
  const border = isUser ? "var(--color-line-soft)" : "var(--color-line-soft)";
  const roleLabel = isUser ? "You" : "Assistant";
  return (
    <div className={`flex flex-col ${align} gap-1 w-full`}>
      <span className="section-label">
        {roleLabel}
      </span>
      <div
        className="max-w-[90%] rounded-lg px-3.5 py-2 text-md leading-[1.55] text-text-1"
        style={{
          background: bg,
          border: `1px solid ${border}`,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {isUser ? (
          // User text isn't markdown — render as plain text so backticks
          // and asterisks come through literally (the model rendering them
          // back is enough).
          <span>{message.content}</span>
        ) : message.content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkCallouts]} components={mdComponents()}>
            {message.content}
          </ReactMarkdown>
        ) : (
          <span
            className="inline-block w-1.5 h-3 align-baseline animate-pulse"
            style={{ background: "var(--color-text-3)" }}
            aria-label="streaming"
          />
        )}
        {message.streaming && message.content && (
          <span
            className="inline-block w-1.5 h-3 ml-0.5 align-baseline animate-pulse"
            style={{ background: "var(--color-text-3)" }}
            aria-label="streaming"
          />
        )}
        {message.error && (
          <div
            className="mt-2 text-sm"
            style={{ color: "var(--color-red)" }}
            role="alert"
          >
            {message.error}
          </div>
        )}
      </div>
    </div>
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
function mdComponents() {
  return {
    p: (p: any) => <p {...p} className="my-2 first:mt-0 last:mb-0" />,
    a: (p: any) => (
      <a
        {...p}
        target="_blank"
        rel="noreferrer"
        onClick={onExternalAnchorClick}
        className="text-accent hover:underline"
      />
    ),
    ul: (p: any) => <ul {...p} className="list-disc pl-5 my-2 space-y-1" />,
    ol: (p: any) => <ol {...p} className="list-decimal pl-5 my-2 space-y-1" />,
    code: ({ inline, className, children, ...rest }: any) => {
      if (inline) {
        return (
          <code
            className="bg-bg-3 text-text-1 px-1 py-[1px] rounded text-base font-mono"
            {...rest}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          className={`${className ?? ""} block font-mono text-base`}
          {...rest}
        >
          {children}
        </code>
      );
    },
    pre: (p: any) => (
      <pre
        className="bg-bg-0 border border-line-soft my-2 p-3 rounded overflow-x-auto"
        {...p}
      />
    ),
    h1: (p: any) => <h1 {...p} className="text-lg font-semibold mt-3 mb-2" />,
    h2: (p: any) => <h2 {...p} className="text-lg font-semibold mt-3 mb-2" />,
    h3: (p: any) => <h3 {...p} className="text-md font-semibold mt-3 mb-1" />,
    blockquote: (p: any) =>
      calloutFromBlockquote(p.className, p.children) ?? (
        <blockquote
          {...p}
          className="border-l-2 border-line pl-3 text-text-3 my-2"
        />
      ),
  };
}

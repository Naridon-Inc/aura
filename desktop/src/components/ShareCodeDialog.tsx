// "Share to teammate" dialog. Fires when the user hits Cmd+Shift+S in
// the editor (or invokes "Share to chat…" from a context menu). Carries
// a code snippet payload — filename, language, line range, body — and
// asks the user to pick a chat target (channel or DM). On confirm it
// posts a fenced-code message via `chat_send` and (optionally) opens
// the chat panel scrolled to the new message.
//
// Listens for the global custom event `aura:share-code-to-chat` so any
// surface that has access to a selection (Monaco editor, AgentTerminal,
// SearchResults, …) can dispatch the same payload shape and reuse this
// UI.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import {
  MODAL_FOOTER,
  MODAL_HEADER,
  MODAL_PANEL,
  MODAL_TITLE,
} from "./ui/modalSurface";
import { cn } from "../lib/utils";
import { api, type TeamMember } from "../lib/api";

type Payload = {
  filePath?: string;
  language?: string;
  lineStart?: number;
  lineEnd?: number;
  code: string;
};

type ShareTarget =
  | { kind: "channel"; channel: string; label: string }
  | { kind: "dm"; channel: string; label: string; handle: string };

type Props = {
  repoRoot: string;
};

const EVENT = "aura:share-code-to-chat";

export function ShareCodeDialog({ repoRoot }: Props) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [comment, setComment] = useState("");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [selfHandle, setSelfHandle] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onShare(e: Event) {
      const detail = (e as CustomEvent).detail as Payload | undefined;
      if (!detail || !detail.code) return;
      setPayload(detail);
      setComment("");
      setError(null);
      setSelectedKey(null);
    }
    window.addEventListener(EVENT, onShare);
    return () => window.removeEventListener(EVENT, onShare);
  }, []);

  // Lazy-load team data when the dialog opens.
  useEffect(() => {
    if (!payload) return;
    Promise.all([
      api.teamLoad(repoRoot).catch(() => null),
      api.teamIdentity(repoRoot).catch(() => null),
    ]).then(([t, ident]) => {
      setMembers(t?.members ?? []);
      setChannels(t?.channels ?? ["general"]);
      setSelfHandle(ident?.handle ?? null);
    });
  }, [payload, repoRoot]);

  const targets = useMemo<ShareTarget[]>(() => {
    const out: ShareTarget[] = [];
    for (const c of channels) {
      out.push({ kind: "channel", channel: c, label: `#${c}` });
    }
    for (const m of members) {
      if (!m.handle || m.handle === selfHandle) continue;
      out.push({
        kind: "dm",
        channel: dmChannel(selfHandle ?? "", m.handle),
        handle: m.handle,
        label: `@${m.handle}${m.name ? ` · ${m.name}` : ""}`,
      });
    }
    return out;
  }, [channels, members, selfHandle]);

  // Default-select the first target so Enter works immediately.
  useEffect(() => {
    if (!selectedKey && targets.length > 0) {
      setSelectedKey(targetKey(targets[0]));
    }
  }, [targets, selectedKey]);

  const close = useCallback(() => {
    setPayload(null);
    setComment("");
    setSelectedKey(null);
    setError(null);
  }, []);

  // Esc closes.
  useEffect(() => {
    if (!payload) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payload, close]);

  async function send() {
    if (!payload || !selectedKey) return;
    const target = targets.find((t) => targetKey(t) === selectedKey);
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      const body = formatBody(payload, comment, target);
      await api.chatSend({
        repoRoot,
        channel: target.channel,
        body,
      });
      // Fire a follow-up event so CommsPanel can flip to the channel.
      window.dispatchEvent(
        new CustomEvent("aura:focus-chat-channel", {
          detail: { channel: target.channel },
        }),
      );
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  if (!payload) return null;

  return (
    // Scoped to the pane it opens over (absolute, not fixed), but the scrim,
    // panel and header match every other dialog in the app.
    <div
      className="absolute inset-0 z-50 bg-black/55 backdrop-blur-[3px] flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Share to chat"
    >
      <div className={cn(MODAL_PANEL, "w-[560px] max-w-full flex flex-col max-h-[80vh]")}>
        <div className={MODAL_HEADER}>
          <span className={MODAL_TITLE}>Share to chat</span>
          {payload.filePath && (
            <span className="ml-2 text-[10.5px] text-text-5 font-mono truncate">
              {shortPath(payload.filePath)}
              {payload.lineStart && payload.lineEnd && payload.lineStart !== payload.lineEnd
                ? `:${payload.lineStart}-${payload.lineEnd}`
                : payload.lineStart
                  ? `:${payload.lineStart}`
                  : ""}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-[14px] text-text-4 hover:text-text-1 px-1.5 py-0.5 rounded hover:bg-bg-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto space-y-3">
          {/* Snippet preview */}
          <div className="border border-line-soft rounded bg-bg-content overflow-hidden">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-5 border-b border-line-soft flex items-center gap-2">
              <span>Snippet</span>
              <span className="font-mono text-text-4 normal-case">
                {payload.language || "text"}
              </span>
              <span className="ml-auto text-text-4 normal-case">
                {payload.code.split("\n").length} lines
              </span>
            </div>
            <pre className="px-3 py-2 text-[11.5px] text-text-2 font-mono leading-5 max-h-44 overflow-y-auto whitespace-pre">
              {payload.code}
            </pre>
          </div>

          {/* Optional comment */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-5 block mb-1">
              Add a note (optional)
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="Quick context for the reader…"
              className="w-full bg-bg-content border border-line-soft rounded px-2 py-1.5 text-[12.5px] text-text-1 leading-5 focus:outline-none focus:border-line resize-y"
            />
          </div>

          {/* Target picker */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-5 block mb-1">
              Send to
            </label>
            {targets.length === 0 ? (
              <div className="text-[11.5px] text-text-5 italic px-1">
                No teammates or channels yet. Open the Chat panel to claim
                your identity first.
              </div>
            ) : (
              <ul className="max-h-44 overflow-y-auto border border-line-soft rounded">
                {targets.map((t) => {
                  const key = targetKey(t);
                  const active = key === selectedKey;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => setSelectedKey(key)}
                        onDoubleClick={() => {
                          setSelectedKey(key);
                          send();
                        }}
                        className={`w-full text-left px-2.5 py-1.5 text-[12px] flex items-center gap-2 ${
                          active
                            ? "bg-bg-2 text-text-1"
                            : "text-text-3 hover:bg-bg-2 hover:text-text-1"
                        }`}
                      >
                        <span className="font-mono text-text-4 w-3 text-center">
                          {t.kind === "channel" ? "#" : "@"}
                        </span>
                        <span className="truncate">{t.label.replace(/^[#@]/, "")}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error && (
            <div className="text-[11.5px] text-red bg-red/10 border border-red/20 rounded px-2 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className={MODAL_FOOTER}>
          <Button variant="ghost" size="xs" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="xs"
            disabled={!selectedKey || sending}
            onClick={send}
          >
            {sending ? "Sending…" : "Share"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

function targetKey(t: ShareTarget): string {
  return `${t.kind}|${t.channel}`;
}

function dmChannel(self: string, other: string): string {
  const pair = [self, other].sort();
  return `dm:${pair[0]}:${pair[1]}`;
}

function formatBody(p: Payload, comment: string, target: ShareTarget): string {
  const lines: string[] = [];
  if (comment.trim()) lines.push(comment.trim());
  if (p.filePath) {
    const range =
      p.lineStart && p.lineEnd && p.lineStart !== p.lineEnd
        ? `:${p.lineStart}-${p.lineEnd}`
        : p.lineStart
          ? `:${p.lineStart}`
          : "";
    lines.push(`📎 \`${shortPath(p.filePath)}${range}\``);
  }
  const lang = p.language || "";
  lines.push("```" + lang);
  lines.push(p.code.replace(/\n$/, ""));
  lines.push("```");
  // target included only for self-traceability; not strictly needed for the body
  void target;
  return lines.join("\n");
}

function shortPath(p: string): string {
  if (!p) return "";
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 3 ? p : `…/${segs.slice(-3).join("/")}`;
}

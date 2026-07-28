/** Team (chat) presentation — the message composer + mention state + Aura slash handlers.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ALargeSmall,
  AtSign,
  Bold,
  Braces,
  ChevronRight,
  Code2,
  FileText,
  Italic,
  Laptop,
  Layers3,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Mic,
  Pause,
  Play,
  Plus,
  Quote,
  Smile,
  SquarePen,
  Strikethrough,
  Trash2,
  Underline,
  Video,
  Workflow,
} from "lucide-react";
import { api, type TeamMember } from "../../../lib/api";
import { FileUploadButton } from "../../chat/FileUploadButton";
import { type ChatAttachment } from "../../chat/FileAttachment";
import { RepoFilePicker } from "../../chat/RepoFilePicker";
import { RepoFileChip, type RepoFileAttachment } from "../../chat/RepoFileChip";
import {
  relay as auraRelay,
  type IntentRelayPayload,
  type PrReviewRelayPayload,
  type ProveRelayPayload,
  type SnapshotRelayPayload,
} from "../../../lib/auraRelay";
import { animalForName, tintForName } from "../../../lib/identityColors";
import { composerHint, type Conversation } from "../domain";
import { ArrowUpIcon } from "./icons";

// ── Aura-native chat slash handlers ──────────────────────────────────
//
// `/intent <text>` — log an intent against the repo, then post the
//                    resulting intent record as a structured relay card.
// `/snapshot <path>` — take a durable file snapshot, relay a card.
// `/prove <goal>` — run `aura goal-trace` and relay the verdict.
// `/pr-review [base]` — run `aura pr-review --json` and relay verdict.
//
// All four are best-effort: a CLI failure surfaces as a fallthrough plain
// chat message so the user's text isn't lost. The handler returns `true`
// when it consumed the message (so the Composer skips its default send).

async function handleAuraSlash(
  body: string,
  repoRoot: string,
  channel: string,
): Promise<boolean> {
  const head = body.split(/\s+/, 1)[0]?.toLowerCase();
  const rest = body.slice(head?.length ?? 0).trim();
  switch (head) {
    case "/intent":
      return slashIntent(rest, repoRoot, channel);
    case "/snapshot":
      return slashSnapshot(rest, repoRoot, channel);
    case "/prove":
      return slashProve(rest, repoRoot, channel);
    case "/pr-review":
    case "/review":
      return slashPrReview(rest, repoRoot, channel);
    default:
      return false;
  }
}

async function slashIntent(
  text: string,
  repoRoot: string,
  channel: string,
): Promise<boolean> {
  const subject = text.trim();
  if (!subject) {
    // Empty `/intent` falls through so the catalog popup keeps working.
    return false;
  }
  try {
    const ts = await api.auraLogIntent(repoRoot, subject, "aura-shell");
    const payload: IntentRelayPayload = {
      ts,
      subject,
      agent_id: "aura-shell",
    };
    await auraRelay({ repoRoot, channel }, "intent", payload);
    return true;
  } catch (e) {
    console.warn("/intent failed:", e);
    return false;
  }
}

async function slashSnapshot(
  path: string,
  repoRoot: string,
  channel: string,
): Promise<boolean> {
  const target = path.trim();
  if (!target) return false;
  try {
    await api.auraSnapshot(repoRoot, target);
    const payload: SnapshotRelayPayload = {
      path: target,
      ts: Math.floor(Date.now() / 1000),
    };
    await auraRelay({ repoRoot, channel }, "snapshot", payload);
    return true;
  } catch (e) {
    console.warn("/snapshot failed:", e);
    return false;
  }
}

async function slashProve(
  goal: string,
  repoRoot: string,
  channel: string,
): Promise<boolean> {
  const g = goal.trim();
  if (!g) return false;
  try {
    const r = await api.auraCli(repoRoot, ["goal-trace", "--goal", g]);
    const ok = r.status === 0;
    const text = r.stdout || r.stderr || "";
    // Best-effort parse of "N nodes matched" / gap markers from the CLI
    // text output. The CLI is human-formatted, not JSON, so we just
    // surface heuristic counts; the receiving card degrades gracefully
    // when fields are missing.
    const nodesMatch = text.match(/(\d+)\s+(?:logic\s+)?nodes?\s+(?:matched|wired|exist)/i);
    const gaps: string[] = [];
    const gapRe = /(?:gap|missing|unwired)\s*[:\-]\s*([^\n]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = gapRe.exec(text)) !== null && gaps.length < 8) {
      gaps.push(m[1].trim());
    }
    const payload: ProveRelayPayload = {
      goal: g,
      ok,
      nodes_matched: nodesMatch ? Number(nodesMatch[1]) : undefined,
      gaps: gaps.length > 0 ? gaps : undefined,
    };
    await auraRelay({ repoRoot, channel }, "prove", payload);
    return true;
  } catch (e) {
    console.warn("/prove failed:", e);
    return false;
  }
}

async function slashPrReview(
  arg: string,
  repoRoot: string,
  channel: string,
): Promise<boolean> {
  const base = arg.trim() || "main";
  try {
    const r = await api.auraCli(repoRoot, ["pr-review", "--base", base, "--json"]);
    let verdict: PrReviewRelayPayload["verdict"] = "ok";
    let violations: number | undefined;
    let undocumented: number | undefined;
    let headline: string | undefined;
    try {
      const j = JSON.parse(r.stdout || "{}") as Record<string, unknown>;
      const vRaw = (j.violations ?? j.violation_count) as number | unknown[] | undefined;
      if (Array.isArray(vRaw)) violations = vRaw.length;
      else if (typeof vRaw === "number") violations = vRaw;
      const uRaw = (j.undocumented ?? j.undocumented_count) as number | unknown[] | undefined;
      if (Array.isArray(uRaw)) undocumented = uRaw.length;
      else if (typeof uRaw === "number") undocumented = uRaw;
      if (typeof j.headline === "string") headline = j.headline;
      if (typeof j.summary === "string" && !headline) headline = j.summary;
    } catch {
      // Non-JSON output — fall back to text scraping for counts so the
      // card still has something meaningful.
      const text = r.stdout || r.stderr || "";
      const vMatch = text.match(/(\d+)\s+violation/i);
      if (vMatch) violations = Number(vMatch[1]);
      const uMatch = text.match(/(\d+)\s+undocumented/i);
      if (uMatch) undocumented = Number(uMatch[1]);
    }
    if (r.status !== 0 || (violations != null && violations > 0)) {
      verdict = violations && violations > 0 ? "fail" : "warn";
    } else if (undocumented != null && undocumented > 0) {
      verdict = "warn";
    }
    const payload: PrReviewRelayPayload = {
      base,
      verdict,
      violations,
      undocumented,
      headline,
    };
    await auraRelay({ repoRoot, channel }, "pr_review", payload);
    return true;
  } catch (e) {
    console.warn("/pr-review failed:", e);
    return false;
  }
}

// ── composer ─────────────────────────────────────────────────────────

export function Composer({
  conv,
  repoRoot,
  members,
  onSend,
  placeholder,
  textareaRef,
}: {
  conv: Conversation;
  repoRoot: string;
  members: TeamMember[];
  onSend: (
    body: string,
    attachments?: ChatAttachment[],
    repoFiles?: RepoFileAttachment[],
  ) => Promise<void> | void;
  placeholder?: string;
  /** Optional external ref so parents (thread view) can focus this. */
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Surfaced when a send throws (offline / cloud down). Without this the
  // spinner just stops and the text sits there — a non-engineer reads that
  // as "I pressed send and nothing happened." The draft is kept so they can
  // retry; cleared the moment they edit or a send succeeds.
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [repoFiles, setRepoFiles] = useState<RepoFileAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [uploadOpenRequest, setUploadOpenRequest] = useState(0);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [emojiPickerPosition, setEmojiPickerPosition] = useState({ left: 0, bottom: 62 });
  const [recordingVoice, setRecordingVoice] = useState(false);
  const dropZoneId = useId();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const lastTypingSentRef = useRef<number>(0);

  // Throttled typing pulse — fired on every meaningful keystroke at most
  // once every 2.5s. Cloud-side TTL is 5s so this keeps the indicator
  // alive without flooding the socket.
  const pulseTyping = useCallback(() => {
    if (!conv.channel) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2500) return;
    lastTypingSentRef.current = now;
    void (async () => {
      try {
        const ident = await api.deviceIdentity();
        window.dispatchEvent(
          new CustomEvent("aura:ws-send", {
            detail: {
              kind: "typing",
              channel: conv.channel,
              device_id: ident.device_id,
              display: ident.display_name || ident.device_id,
            },
          }),
        );
      } catch {
        /* device identity unreachable — non-fatal */
      }
    })();
  }, [conv.channel]);

  // Mirror our textarea ref into the optional external ref so the
  // thread view can call `.focus()` from the "Reply" pill.
  useEffect(() => {
    if (textareaRef) textareaRef.current = taRef.current;
  }, [textareaRef]);

  // @mention autocomplete — when the caret-preceding token is `@xyz`,
  // suggest matching team handles.
  const mentionState = useMentionState(draft, members, taRef);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [addMenuOpen]);

  // Auto-grow textarea with content; cap at ~7 lines (140px). The
  // scrollbar is only armed once content actually exceeds the cap —
  // otherwise a single-line draft shows no scrollbar the instant it's
  // focused (the "large scrollbar on click" complaint). Horizontal
  // overflow stays hidden permanently (wrapping handles long words).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const full = ta.scrollHeight;
    const next = Math.min(full, 140);
    ta.style.height = `${next}px`;
    ta.style.overflowY = full > 140 ? "auto" : "hidden";
  }, [draft]);

  async function send() {
    const body = draft.trim();
    if (!body && attachments.length === 0 && repoFiles.length === 0) return;
    if (sending) return;
    setSending(true);
    setSendError(null);
    try {
      // Aura-native slash commands — only intercepted when the message
      // starts with one we own AND the conversation has a real channel
      // (channels/customs/DMs, not the project pseudo-feed). Anything
      // unknown falls through to the normal chat send.
      const slashHandled =
        body && conv.channel
          ? await handleAuraSlash(body, repoRoot, conv.channel)
          : false;
      if (slashHandled) {
        setDraft("");
        setAttachments([]);
        setRepoFiles([]);
        return;
      }
      await onSend(body, attachments, repoFiles);
      setDraft("");
      setAttachments([]);
      setRepoFiles([]);
    } catch {
      // Keep the draft + attachments intact so the message isn't lost; just
      // tell the user it didn't go through. Plain language, no error codes.
      setSendError("Couldn't send — check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  function acceptMention(handle: string) {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    const token = draft.slice(0, caret).match(/@[a-zA-Z0-9_.\-]*$/);
    const start = mentionState?.start ?? (token ? caret - token[0].length : caret);
    const end = mentionState?.end ?? caret;
    const next = draft.slice(0, start) + `@${handle} ` + draft.slice(end);
    setDraft(next);
    setMentionPickerOpen(false);
    requestAnimationFrame(() => {
      if (ta) {
        const pos = start + handle.length + 2;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  const hasPending = attachments.length > 0 || repoFiles.length > 0;

  const insertText = (text: string) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? start;
    setDraft((value) => value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const formatSelection = () => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? start;
    if (start === end) {
      insertText("**bold**");
      return;
    }
    setDraft((value) => `${value.slice(0, start)}**${value.slice(start, end)}**${value.slice(end)}`);
  };

  const wrapSelection = (before: string, after = before) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? start;
    const selected = draft.slice(start, end) || "text";
    setDraft((value) =>
      `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`,
    );
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const insertCodeBlock = () => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? start;
    const selected = draft.slice(start, end) || "code";
    const leadingBreak = start > 0 && !draft.slice(0, start).endsWith("\n") ? "\n" : "";
    const trailingBreak = end < draft.length && !draft.slice(end).startsWith("\n") ? "\n" : "";
    const before = `${leadingBreak}\`\`\`\n`;
    const after = `\n\`\`\`${trailingBreak}`;
    setDraft((value) => `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`);
    requestAnimationFrame(() => {
      ta?.focus();
      const selectionStart = start + before.length;
      ta?.setSelectionRange(selectionStart, selectionStart + selected.length);
    });
  };

  const openMentionPicker = () => {
    setEmojiPickerOpen(false);
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    if (!/@[a-zA-Z0-9_.\-]*$/.test(before)) insertText("@");
    setMentionPickerOpen(true);
  };

  const toggleEmojiPicker = () => {
    setMentionPickerOpen(false);
    const next = !emojiPickerOpen;
    if (next) {
      const composer = composerRef.current?.getBoundingClientRect();
      const trigger = emojiButtonRef.current?.getBoundingClientRect();
      if (composer && trigger) {
        const pickerWidth = 310;
        const desiredLeft = trigger.left - composer.left - 8;
        const maxLeft = Math.max(8, composer.width - pickerWidth - 8);
        setEmojiPickerPosition({
          left: Math.min(Math.max(8, desiredLeft), maxLeft),
          bottom: composer.bottom - trigger.top + 8,
        });
      }
    }
    setEmojiPickerOpen(next);
  };

  const mentionQuery = mentionState?.query ?? "";
  const specialMentions = [
    { handle: "channel", label: "Notify everyone in this channel." },
    { handle: "everyone", label: "Notify everyone in your workspace." },
    { handle: "here", label: "Notify every online member in this channel." },
  ].filter((item) => item.handle.startsWith(mentionQuery));
  const mentionMembers = (mentionState?.matches ?? members.filter((member) =>
    !mentionQuery || `${member.handle} ${member.name}`.toLowerCase().includes(mentionQuery),
  )).slice(0, 8);
  const showMentionPicker =
    (mentionPickerOpen || !!mentionState) &&
    (specialMentions.length > 0 || mentionMembers.length > 0);

  return (
    <div
      ref={composerRef}
      data-os-drop="composer"
      data-os-drop-id={dropZoneId}
      className="slack-composer-wrap flex-shrink-0 relative bg-bg-content"
    >
      {showMentionPicker ? (
        <div className="slack-mention-picker">
          {specialMentions.map((item) => (
            <button key={item.handle} type="button" onClick={() => acceptMention(item.handle)}>
              <span className="slack-mention-special">♧</span>
              <strong>@{item.handle}</strong>
              <small>{item.label}</small>
            </button>
          ))}
          {mentionMembers.map((m) => (
            <button
              key={m.handle}
              type="button"
              onClick={() => acceptMention(m.handle)}
            >
              <span
                className="slack-mention-avatar"
                style={{ background: tintForName(m.handle), fontSize: 11 }}
              >
                {animalForName(m.handle)}
              </span>
              <strong>{m.name || m.handle}</strong>
              <span className="slack-mention-presence" />
              <small>{m.handle}</small>
            </button>
          ))}
        </div>
      ) : null}

      {/* Pending-attachments strip — both upload chips + repo-file chips
       *  share this row so they read as one batch. */}
      {hasPending && (
        <div data-slot="composer-attachments" className="flex flex-wrap gap-1.5 mb-1.5">
          {repoFiles.map((f) => (
            <RepoFileChip
              key={`pending-rf:${f.path}:${f.lineStart ?? ""}`}
              repoRoot={repoRoot}
              path={f.path}
              lineStart={f.lineStart}
              lineEnd={f.lineEnd}
              onRemove={() =>
                setRepoFiles((xs) => xs.filter((x) => x.path !== f.path))
              }
            />
          ))}
          {attachments.map((a, i) => (
            <div
              key={`pending-at:${a.sha256 ?? a.url}:${i}`}
              className="h-7 px-2 rounded-md bg-bg-2 border border-line-soft text-text-2 text-[11.5px] flex items-center gap-1.5"
            >
              <span className="max-w-[140px] truncate" title={a.filename}>
                {a.filename}
              </span>
              <button
                type="button"
                onClick={() =>
                  setAttachments((xs) => xs.filter((_, j) => j !== i))
                }
                className="text-text-4 hover:text-text-1"
                title="Remove"
                aria-label={`Remove ${a.filename}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {sendError && (
        <div
          data-slot="composer-send-error"
          role="alert"
          className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-red"
        >
          <span aria-hidden>⚠</span>
          <span>{sendError}</span>
        </div>
      )}
      {uploadError && (
        <div data-slot="composer-upload-error" role="alert" className="mb-1.5 flex items-center justify-between gap-2 text-[11.5px] text-amber">
          <span>⚠ {uploadError}</span>
          <button type="button" onClick={() => setUploadError(null)} className="text-text-3 hover:text-text-1" aria-label="Dismiss upload error">×</button>
        </div>
      )}

      {/* Unified composer surface — one bordered box holds the textarea and a
          thin toolbar (attach left, send right), matching the app's other
          chat composers instead of three separate side-by-side controls. */}
      {recordingVoice ? (
        <VoiceNoteRecorder
          repoRoot={repoRoot}
          onCancel={() => setRecordingVoice(false)}
          onSend={async (attachment) => {
            await onSend("", [attachment], []);
            setRecordingVoice(false);
          }}
        />
      ) : (
      <div className="slack-composer-surface">
        <div className="slack-composer-formatbar" aria-label="Formatting tools">
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={formatSelection} title="Bold" aria-label="Bold"><Bold size={15} /></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapSelection("_")} title="Italic" aria-label="Italic"><Italic size={15} /></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapSelection("<u>", "</u>")} title="Underline" aria-label="Underline"><Underline size={15} /></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapSelection("~~")} title="Strikethrough" aria-label="Strikethrough"><Strikethrough size={15} /></button>
          <span />
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => wrapSelection("[", "](https://)")} title="Link" aria-label="Link"><Link size={15} /></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertText("1. ")} title="Numbered list" aria-label="Numbered list"><ListOrdered size={16} /></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertText("- ")} title="Bulleted list" aria-label="Bulleted list"><List size={16} /></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertText("> ")} title="Quote" aria-label="Quote"><Quote size={15} /></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={insertCodeBlock} title="Code block" aria-label="Code block"><Code2 size={16} /></button>
        </div>
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (sendError) setSendError(null);
            if (e.target.value.trim().length > 0) pulseTyping();
          }}
          onKeyDown={(e) => {
            if (e.metaKey && e.shiftKey && e.key === "Enter") {
              e.preventDefault();
              insertCodeBlock();
              return;
            }
            if (e.metaKey && e.key.toLowerCase() === "o") {
              e.preventDefault();
              setUploadOpenRequest((value) => value + 1);
              return;
            }
            if (e.key === "Escape") {
              setAddMenuOpen(false);
              setMentionPickerOpen(false);
              setEmojiPickerOpen(false);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !mentionState?.matches.length) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder ?? composerHint(conv)}
          rows={1}
          className="slack-composer-input w-full block resize-none bg-transparent outline-none whitespace-pre-wrap break-words"
          style={{
            lineHeight: "20px",
            maxHeight: 140,
            // overflowY is toggled imperatively in the grow effect so the
            // scrollbar only appears past the 140px cap.
            overflowY: "hidden",
            overflowX: "hidden",
          }}
        />
        <div className="slack-composer-toolbar">
          <button
            type="button"
            className={`slack-composer-add ${addMenuOpen ? "is-open" : ""}`}
            onClick={() => {
              setEmojiPickerOpen(false);
              setMentionPickerOpen(false);
              setAddMenuOpen((open) => !open);
            }}
            title="Add attachment or content"
            aria-label="Add attachment or content"
            aria-expanded={addMenuOpen}
          >
            <Plus size={18} />
          </button>
          <FileUploadButton
            repoRoot={repoRoot}
            dropZoneId={dropZoneId}
            dropTargetRef={composerRef}
            hideTrigger
            openRequest={uploadOpenRequest}
            onUploaded={(a) => {
              setUploadError(null);
              setAttachments((xs) => [...xs, a]);
            }}
            onError={(msg) => setUploadError(msg)}
          />
          <span className="slack-composer-divider" />
          <button
            ref={emojiButtonRef}
            type="button"
            className={`slack-composer-tool ${emojiPickerOpen ? "is-active" : ""}`}
            onClick={toggleEmojiPicker}
            title="Add emoji"
          >
            <Smile size={17} />
          </button>
          <button type="button" className="slack-composer-tool" onClick={openMentionPicker} title="Mention someone">
            <AtSign size={17} />
          </button>
          <button type="button" className="slack-composer-tool" onClick={formatSelection} title="Format message">
            <ALargeSmall size={18} />
          </button>
          <button
            type="button"
            className="slack-composer-tool"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:start-huddle", { detail: { repoRoot, channel: conv.channel ?? "general", channelName: conv.name } }))}
            title="Record a video clip"
          >
            <Video size={17} />
          </button>
          <button type="button" className="slack-composer-tool" onClick={() => setRecordingVoice(true)} title="Record audio clip">
            <Mic size={17} />
          </button>
          <button type="button" className="slack-composer-tool" onClick={() => taRef.current?.focus()} title="Open expanded composer">
            <SquarePen size={16} />
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={send}
            disabled={(!draft.trim() && !hasPending) || sending}
            className="slack-composer-send"
            title="Send (Enter)"
          >
            {sending ? "…" : <ArrowUpIcon />}
          </button>
        </div>
      </div>
      )}

      {addMenuOpen && (
        <div className="slack-composer-add-menu" role="menu" aria-label="Add to message">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("aura:team-select-tab", { detail: { conversationId: conv.id, tab: "canvas" } }));
              setAddMenuOpen(false);
            }}
          >
            <FileText size={16} /><span>Canvas</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { insertText("- [ ] "); setAddMenuOpen(false); }}>
            <ListChecks size={16} /><span>List</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setPickerOpen(true); setAddMenuOpen(false); }}>
            <Layers3 size={16} /><span>Recent file</span><ChevronRight size={14} className="slack-add-menu-end" />
          </button>
          <button type="button" role="menuitem" onClick={() => { insertCodeBlock(); setAddMenuOpen(false); }}>
            <Braces size={16} /><span>Text snippet</span><kbd>⌘⇧Enter</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => { insertText("/workflow "); setAddMenuOpen(false); }}>
            <Workflow size={16} /><span>Workflow</span>
          </button>
          <div className="slack-add-menu-separator" />
          <button type="button" role="menuitem" onClick={() => { setUploadOpenRequest((value) => value + 1); setAddMenuOpen(false); }}>
            <Laptop size={16} /><span>Upload from your computer</span><kbd>⌘O</kbd>
          </button>
        </div>
      )}

      {emojiPickerOpen && (
        <div
          className="slack-emoji-picker"
          role="dialog"
          aria-label="Emoji picker"
          style={{ left: emojiPickerPosition.left, bottom: emojiPickerPosition.bottom }}
        >
          <header><strong>Emoji</strong><button type="button" onClick={() => setEmojiPickerOpen(false)}>×</button></header>
          <div>
            {COMPOSER_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  insertText(`${emoji} `);
                  setEmojiPickerOpen(false);
                }}
                aria-label={`Insert ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      <RepoFilePicker
        open={pickerOpen}
        repoRoot={repoRoot}
        onClose={() => setPickerOpen(false)}
        onPick={(path) =>
          setRepoFiles((xs) =>
            xs.some((x) => x.path === path) ? xs : [...xs, { path }],
          )
        }
      />
    </div>
  );
}

const COMPOSER_EMOJIS = [
  "😀", "😃", "😄", "😁", "😂", "😊", "😍", "🥰",
  "😎", "🤔", "🫡", "😅", "😭", "😡", "🥳", "🤯",
  "👍", "👎", "👏", "🙌", "🙏", "🤝", "💪", "✌️",
  "❤️", "💙", "💚", "💛", "🔥", "✨", "🎉", "💯",
  "✅", "❌", "⚠️", "🚀", "👀", "💡", "🐛", "📌",
];

function VoiceNoteRecorder({
  repoRoot,
  onCancel,
  onSend,
}: {
  repoRoot: string;
  onCancel: () => void;
  onSend: (attachment: ChatAttachment) => Promise<void> | void;
}) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const finishRef = useRef(false);
  const pausedRef = useRef(false);
  const secondsRef = useRef(0);
  const [seconds, setSeconds] = useState(0);
  const [paused, setPaused] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | null = null;
    void navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        if (cancelledRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          if (!finishRef.current || cancelledRef.current) return;
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          void uploadVoiceNote(blob, secondsRef.current);
        };
        recorder.start(250);
        timer = window.setInterval(() => {
          if (!pausedRef.current) setSeconds((value) => {
            const next = value + 1;
            secondsRef.current = next;
            return next;
          });
        }, 1000);
      })
      .catch(() => setError("Microphone access is required to record a voice note."));

    return () => {
      if (timer !== null) window.clearInterval(timer);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  // The recorder owns one immutable recording session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadVoiceNote = async (blob: Blob, duration: number) => {
    setUploading(true);
    setError(null);
    try {
      const bytesBase64 = arrayBufferToBase64(await blob.arrayBuffer());
      const uploaded = await api.chatUploadVoiceNote(
        repoRoot,
        bytesBase64,
        `voice-note-${Date.now()}.webm`,
        blob.type || "audio/webm",
      );
      await onSend({
        url: uploaded.url,
        sha256: uploaded.sha256,
        size: uploaded.size,
        mime: uploaded.mime,
        filename: uploaded.filename || "voice-note.webm",
        kind: "voice-note",
        duration,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setUploading(false);
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    onCancel();
  };

  const finish = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    finishRef.current = true;
    setUploading(true);
    recorder.stop();
  };

  const togglePause = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (recorder.state === "paused") recorder.resume();
    else recorder.pause();
    const next = recorder.state !== "recording";
    pausedRef.current = next;
    setPaused(next);
  };

  return (
    <div className="slack-voice-recorder" role="group" aria-label="Voice note recorder">
      <button type="button" onClick={cancel} className="slack-recorder-cancel" aria-label="Discard voice note">
        <Trash2 size={17} />
      </button>
      <span className={`slack-recorder-dot ${paused ? "is-paused" : ""}`} />
      <span className="slack-recorder-time">{formatRecorderTime(seconds)}</span>
      <div className={`slack-recorder-wave ${paused ? "is-paused" : ""}`} aria-hidden>
        {Array.from({ length: 42 }, (_, index) => (
          <i key={index} style={{ animationDelay: `${-(index % 9) * 70}ms`, height: 8 + ((index * 13) % 20) }} />
        ))}
      </div>
      {error && <span className="slack-recorder-error" title={error}>{error}</span>}
      <button type="button" onClick={togglePause} disabled={uploading || !!error} className="slack-recorder-round" aria-label={paused ? "Resume recording" : "Pause recording"}>
        {paused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}
      </button>
      <button type="button" onClick={finish} disabled={uploading || !!error || seconds < 1} className="slack-recorder-send">
        {uploading ? "Uploading…" : "Send"}
      </button>
    </div>
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function formatRecorderTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useMentionState(
  draft: string,
  members: TeamMember[],
  taRef: React.RefObject<HTMLTextAreaElement | null>,
): { start: number; end: number; query: string; matches: TeamMember[] } | null {
  const ta = taRef.current;
  if (!ta) return null;
  const caret = ta.selectionStart ?? draft.length;
  // Walk back from caret to find a @token without whitespace.
  let i = caret - 1;
  while (i >= 0) {
    const c = draft[i];
    if (c === "@") {
      const query = draft.slice(i + 1, caret);
      if (/^[a-zA-Z0-9_.\-]*$/.test(query)) {
        const q = query.toLowerCase();
        const matches = members
          .filter((m) =>
            `${m.handle} ${m.name}`.toLowerCase().includes(q),
          )
          .slice(0, 8);
        return { start: i, end: caret, query: q, matches };
      }
      return null;
    }
    if (!/[a-zA-Z0-9_.\-]/.test(c)) return null;
    i--;
  }
  return null;
}

// Conversation labels / time formatting (composerHint, prettyName,
// railLabel, hhmm), DM + channel routing (dmChannel, dmOtherSide),
// the message-model converters, and unread/pinned localStorage adapters
// now live in `team/domain/` — imported at the top of this file.

// Avatar palette helpers (colorForName / animalForName / tintForName)
// moved to ../lib/identityColors so the sidebar's Team notification
// bubbles share the exact same person → colour + animal mapping.

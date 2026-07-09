/** Team (chat) presentation — the message composer + mention state + Aura slash handlers.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FileCode } from "lucide-react";
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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [repoFiles, setRepoFiles] = useState<RepoFileAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
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

  function accept(handle: string) {
    const { start, end } = mentionState!;
    const next = draft.slice(0, start) + `@${handle} ` + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        const pos = start + handle.length + 2;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  const hasPending = attachments.length > 0 || repoFiles.length > 0;

  return (
    <div
      ref={composerRef}
      className="flex-shrink-0 border-t border-line-soft p-2 relative bg-bg-content"
    >
      {mentionState && mentionState.matches.length > 0 ? (
        <div className="absolute bottom-full left-2 mb-1 bg-bg-1 border border-line-soft rounded-md shadow-lg overflow-hidden z-10 min-w-[180px]">
          {mentionState.matches.slice(0, 6).map((m) => (
            <button
              key={m.handle}
              type="button"
              onClick={() => accept(m.handle)}
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-bg-2 text-left"
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: tintForName(m.handle), fontSize: 11 }}
              >
                {animalForName(m.handle)}
              </span>
              <span className="text-text-1 text-[12px] flex-1 truncate">
                @{m.handle}
              </span>
              <span className="text-text-4 text-[10px] truncate">{m.name}</span>
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
          className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-rose-300"
        >
          <span aria-hidden>⚠</span>
          <span>{sendError}</span>
        </div>
      )}

      {/* Unified composer surface — one bordered box holds the textarea and a
          thin toolbar (attach left, send right), matching the app's other
          chat composers instead of three separate side-by-side controls. */}
      <div className="rounded-lg border border-line-soft bg-bg-1 focus-within:border-line transition-colors">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (sendError) setSendError(null);
            if (e.target.value.trim().length > 0) pulseTyping();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !mentionState?.matches.length) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder ?? composerHint(conv)}
          rows={1}
          className="w-full block resize-none bg-transparent text-text-1 text-[12.5px] px-3 pt-2 pb-1 outline-none whitespace-pre-wrap break-words"
          style={{
            lineHeight: "20px",
            maxHeight: 140,
            // overflowY is toggled imperatively in the grow effect so the
            // scrollbar only appears past the 140px cap.
            overflowY: "hidden",
            overflowX: "hidden",
          }}
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <FileUploadButton
            repoRoot={repoRoot}
            dropTargetRef={composerRef}
            onUploaded={(a) => setAttachments((xs) => [...xs, a])}
            onError={(msg) => console.warn("upload failed:", msg)}
          />
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="text-text-3 hover:text-text-1 p-1 rounded hover:bg-bg-2 transition-colors"
            title="Attach repo file"
            aria-label="Attach repo file"
          >
            <FileCode size={14} />
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={send}
            disabled={(!draft.trim() && !hasPending) || sending}
            className="w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-bg-deep)",
            }}
            title="Send (Enter)"
          >
            {sending ? "…" : <ArrowUpIcon />}
          </button>
        </div>
      </div>

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
          .filter((m) => m.handle.startsWith(q))
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

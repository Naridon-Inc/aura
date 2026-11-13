import { memo, useEffect, useRef, useState } from "react";
import {
  Check,
  GitBranch,
  Pencil,
  SquareArrowOutUpRight,
  Target,
  X,
} from "lucide-react";
import type { ChatTurn } from "../../../lib/api";
import {
  hasGoalDirective,
  stripSteeringDirective as stripModeDirective,
} from "../../../lib/steeringDirective";
import { useFlagPrefs } from "../../../lib/settingsStore";
import { AgentIcon } from "../../agent/AgentIcon";
import { billingForBrain, useChatSpend } from "./spend";
import { MarkdownBody } from "./Markdown";
import { TurnActivity } from "./TurnActivity";
import { TurnChanges } from "./TurnChanges";
import { extractTurnChanges } from "./turnChangeSummary";
import { InteractiveBlocks, partitionInteractive } from "./InteractiveBlocks";
// Reuse the Trace transcript's contextual-summary knowledge: the agent CLI's
// "This session is being continued…" compaction block (and `aura handover`
// payloads) are detected here so the chat renders them as a contextual card,
// never as a giant user bubble.
import { isHandoverSummary } from "../../workpanes/transcript/model";
import { CompactionSummary } from "../../ui/chat-recovery";
import { Message, MessageActions, MessageBody } from "../../ui/message";
import { Badge } from "../../ui/badge";
import { TurnFooter } from "../../ui/transcript-patterns";
import { turnUsage } from "./turnUsage";
import { formatCompletedAt } from "../../../lib/completedAt";
import { humanizeBrainId, brainAgentId } from "./StatusLine";
import { compactNumber } from "../../../lib/compactNumber";
import { formatDuration } from "../../../lib/duration";
import { buildTurnCost } from "../../../lib/turnCost";
import { useMinuteTick } from "../../../lib/useMinuteTick";
import { Button } from "../../ui/button";
import { persistedTurnBlocks } from "./persistedBlocks";
import { ChatAttachmentCards } from "./ChatAttachments";
import { AgentMessageBody } from "./AgentMessageBody";
import { FeedbackFrame, TurnMenu, useTurnComment } from "../../cloudplace/CloudTurnFeedback";

// Memoized: while a turn streams, ManagerChatView re-renders on every token
// (streamBlocks grows), which would otherwise re-render every settled bubble in
// the timeline. All of a settled bubble's props are stable across a stream tick
// — `turn` is a stable session.chat object, `busy` holds one value for the
// whole in-flight turn, and `onEditResend` / `onFork` are useCallback-stable —
// so shallow memo lets the finished transcript sit still while only the live
// StreamingBubble repaints.
export const ChatBubble = memo(function ChatBubble({
  turn,
  chatIndex,
  busy,
  durationSec = null,
  inGroup = false,
  showActions = true,
  onEditResend,
  onFork,
}: {
  turn: ChatTurn;
  chatIndex?: number | null;
  busy?: boolean;
  /** Seconds the brain took to produce this turn (gap to the prompt it
   *  answered), or null when it can't be derived. Drives the persistent
   *  per-message action row's time-taken stat. */
  durationSec?: number | null;
  /** This bubble is one segment of a cohesive AssistantTurnGroup (CLI-wrapper
   *  "one reply, N bubbles"). The group header already carries the brand, so
   *  drop the redundant per-message model chip from the action row. */
  inGroup?: boolean;
  /** Draw the action-row footer (copy / model / more). False for non-final
   *  segments of a group so the whole run reads as ONE message with one
   *  footer at the bottom, not N stamped bubbles. Defaults true (lone turns). */
  showActions?: boolean;
  onEditResend?: (
    chatIndex: number,
    newText: string,
    restoreCode: boolean,
  ) => Promise<void>;
  /** Branch the conversation from this turn — clone history up to here
   *  into a new session and open it as a tab or its own window. Wired to
   *  the "More" menu. Disabled when `chatIndex` is null (synthetic turns). */
  onFork?: (chatIndex: number, target: "tab" | "workspace") => void;
}) {
  const [editing, setEditing] = useState(false);
  const visibleText =
    turn.role === "user" ? stripModeDirective(turn.text) : turn.text;
  // The turn kept its raw `[GOAL …]` steering prefix (stripped from the visible
  // text above) — badge it so "send as goal" is legible after reload, from the
  // persisted turn alone.
  const sentAsGoal = turn.role === "user" && hasGoalDirective(turn.text);
  const [editText, setEditText] = useState(visibleText);
  const [restoreChoice, setRestoreChoice] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Experimental "Saved ~N tokens" chip — gated on the reactive settings flag.
  const {
    show_token_savings: showSavings,
    show_message_tokens: showMsgTokens,
  } = useFlagPrefs();
  // Read through context rather than a prop: these totals move once per turn,
  // and threading them down would defeat the memo that keeps the whole settled
  // transcript still while a reply streams.
  const chatSpend = useChatSpend();
  // Re-read each minute so a reply that finished "today" stops saying so
  // after midnight.
  // A finished turn re-reads the clock each minute, so a reply that finished
  // "today" doesn't keep saying so after midnight — on the app's one clock,
  // not a timer per bubble.
  const now = useMinuteTick();
  // In a machine chat shared through a workspace: "Comment" in this turn's
  // ⋯ menu, once the cloud has a copy of the turn. Null anywhere else.
  const comment = useTurnComment(turn);

  // Close the More menu on any outside click / Escape.
  // The seed-objective synthetic bubble has no chat[] entry — passing
  // chatIndex=null disables Edit. Q+A turns from the brain (answered_question)
  // are the resolution of a QuestionCard and should not be re-edited here
  // (re-asking would require resurrecting the card flow); they still get
  // a Copy hover affordance.
  const canEdit =
    turn.role === "user" &&
    chatIndex != null &&
    !turn.answered_question &&
    !busy &&
    !!onEditResend;

  // Fork is available on any turn that maps to a real chat[] entry (the
  // synthetic seed-objective bubble passes chatIndex=null) once a handler
  // is wired.
  const canFork = chatIndex != null && !!onFork;

  function fork(target: "tab" | "workspace") {
    if (chatIndex != null && onFork) onFork(chatIndex, target);
  }

  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      const len = taRef.current.value.length;
      taRef.current.setSelectionRange(len, len);
      // auto-grow
      taRef.current.style.height = "auto";
      taRef.current.style.height = `${taRef.current.scrollHeight}px`;
    }
  }, [editing]);

  function startEdit() {
    setEditText(visibleText);
    setEditing(true);
    setRestoreChoice(false);
  }

  function cancelEdit() {
    setEditing(false);
    setRestoreChoice(false);
  }

  async function commit(restoreCode: boolean) {
    if (chatIndex == null || !onEditResend) return;
    const next = editText.trim();
    if (!next) return;
    setEditing(false);
    setRestoreChoice(false);
    await onEditResend(chatIndex, next, restoreCode);
  }

  // Editing surface — replaces the bubble body with a textarea. Enter
  // (without shift) opens the Restore-code-or-message confirm row; the
  // user picks one and the backend truncates / optionally reverts files
  // before re-running the brain.
  if (editing) {
    return (
      <Message role="user">
        <div className="ui-chat-user-stack ui-chat-user-edit">
          <MessageBody tone="user">
            <textarea
              ref={taRef}
              value={editText}
              aria-label="Edit message"
              onChange={(e) => {
                setEditText(e.target.value);
                const ta = e.currentTarget;
                ta.style.height = "auto";
                ta.style.height = `${ta.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (editText.trim()) setRestoreChoice(true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              className="ui-chat-edit-input"
            />
          </MessageBody>
          {restoreChoice ? (
            <div className="ui-chat-edit-choice" role="group" aria-label="Resend from here">
              <p>
                Resend from this point. Also rewind the repository's files to where they
                were when you sent this?
              </p>
              <div className="ui-pattern-actions">
                <Button size="xs" variant="ghost" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void commit(false)}
                  title="Drop chat from this point and resend; leave files alone"
                >
                  Just message
                </Button>
                <Button
                  size="xs"
                  onClick={() => void commit(true)}
                  title="Drop chat AND revert files to their state at this turn"
                >
                  Restore code
                </Button>
              </div>
            </div>
          ) : (
            <div className="ui-chat-edit-hint">
              <span>Enter to resend · Esc to cancel</span>
              <Button size="iconXs" variant="ghost" aria-label="Cancel edit" onClick={cancelEdit}>
                <X />
              </Button>
              <Button
                size="iconXs"
                variant="ghost"
                aria-label="Resend"
                disabled={!editText.trim()}
                onClick={() => setRestoreChoice(true)}
              >
                <Check />
              </Button>
            </div>
          )}
        </div>
      </Message>
    );
  }

  if (turn.role === "user") {
    // A handover summary is carried-over context from an earlier session,
    // not something the user typed: it reads as the summary it is, folded.
    if (isHandoverSummary(turn.text)) {
      return <ChatHandoverCard text={turn.text} />;
    }
    if (turn.answered_question) {
      // The answer to a question the agent asked, with the question above it
      // in quieter ink so the reply still makes sense on reload.
      return (
        <FeedbackFrame turn={turn} role="user" menu={false}>
          <Message role="user">
            <div className="ui-chat-user-stack">
              <MessageBody tone="user">
                <p className="ui-chat-answered-question">{turn.answered_question}</p>
                {visibleText}
              </MessageBody>
              <MessageActions text={visibleText}>
                {comment && <TurnMenu actions={[comment]} size="icon-sm" />}
              </MessageActions>
            </div>
          </Message>
        </FeedbackFrame>
      );
    }
    return (
      <FeedbackFrame turn={turn} role="user" menu={false}>
        <Message role="user">
          <div className="ui-chat-user-stack">
            {(visibleText.trim() || sentAsGoal) && (
              <MessageBody tone="user">
                {sentAsGoal && (
                  <Badge
                    variant="outline"
                    className="ui-chat-goal-badge"
                    title="Sent as a goal. Aura is driving this through the crew work-loop and proving it"
                  >
                    <Target size={11} aria-hidden />
                    Sent as goal
                  </Badge>
                )}
                {visibleText}
              </MessageBody>
            )}
            <ChatAttachmentCards attachments={turn.attachments} />
            {(visibleText.trim() || comment) && (
              <MessageActions text={visibleText.trim() ? visibleText : undefined}>
                {canEdit && !!visibleText.trim() && (
                  <Button size="icon-sm" variant="ghost" aria-label="Edit and resend" onClick={startEdit}>
                    <Pencil />
                  </Button>
                )}
                {comment && <TurnMenu actions={[comment]} size="icon-sm" />}
              </MessageActions>
            )}
          </div>
        </Message>
      </FeedbackFrame>
    );
  }
  const blocks = persistedTurnBlocks(turn);
  const { interactive, rest } = partitionInteractive(blocks);
  const changes = extractTurnChanges(blocks);
  return (
    <FeedbackFrame turn={turn} role="assistant" menu={!showActions}>
      <Message role="assistant">
        <MessageBody className="ui-chat-answer">
          {/* The finished turn's steps fold into one group above the answer;
              the live turn streams its steps through StreamingBubble instead. */}
          {rest.length > 0 && <TurnActivity blocks={rest} />}
          {interactive.length > 0 && <InteractiveBlocks blocks={interactive} />}
          <AgentMessageBody source={turn.text} engine={turn.brain ? humanizeBrainId(turn.brain) : null} />
          {/* What this round wrote, with a Review that opens the diffs. Derived
              from the turn's own tool calls; absent when nothing changed. */}
          {changes && <TurnChanges summary={changes} />}
          {showActions && (
            <TurnFooter
              duration={durationSec != null ? formatDuration(durationSec) : null}
              timestamp={durationSec != null ? formatCompletedAt(turn.at, now).replace(/^finished /, "") : null}
              timestampTitle={new Date(turn.at * 1000).toLocaleString()}
              text={visibleText}
              {...turnUsage(
                buildTurnCost({
                  model: turn.model ?? null,
                  agent: turn.brain ? humanizeBrainId(turn.brain) : null,
                  startMs: durationSec != null ? (turn.at - durationSec) * 1000 : null,
                  endMs: turn.at * 1000,
                  inputTokens: turn.input_tokens,
                  outputTokens: turn.output_tokens,
                  costUsd: turn.cost_usd,
                  costEstimated: turn.cost_estimated,
                  sessionCostUsd: chatSpend.sessionUsd,
                  sessionEstimated: chatSpend.sessionEstimated,
                  sessionPartial: chatSpend.sessionPartial,
                  totalCostUsd: chatSpend.totalUsd,
                  totalEstimated: chatSpend.totalEstimated,
                  billing: billingForBrain(turn.brain),
                }),
              )}
              actions={[
                {
                  label: "Fork chat from here",
                  icon: <GitBranch />,
                  disabled: !canFork,
                  onSelect: () => fork("tab"),
                },
                {
                  label: "Fork chat into a new window",
                  icon: <SquareArrowOutUpRight />,
                  disabled: !canFork,
                  onSelect: () => fork("workspace"),
                },
                ...(comment ? [comment] : []),
              ]}
            >
              {showSavings &&
                typeof turn.saved_tokens === "number" &&
                turn.saved_tokens > 0 && (
                  <span
                    className="ui-turn-fact"
                    title="Estimated tokens saved by using Aura's code map and Q&A instead of reading whole files. An estimate, not an exact count."
                  >
                    Saved ~{compactNumber(turn.saved_tokens)} tokens
                  </span>
                )}
              {showMsgTokens &&
                (typeof turn.input_tokens === "number" ||
                  typeof turn.output_tokens === "number") && (
                  <span
                    className="ui-turn-fact"
                    title="Tokens this reply actually used, reported by the model. Input (context sent in) and output (text generated back)."
                  >
                    {[
                      typeof turn.input_tokens === "number" ? `${compactNumber(turn.input_tokens)} in` : null,
                      typeof turn.output_tokens === "number" ? `${compactNumber(turn.output_tokens)} out` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              {/* Which agent ran it. A group already names its agent once in
                  its header, so its segments leave this out. */}
              {turn.brain && !inGroup && (
                <span className="ui-turn-fact" title="Agent that ran this turn">
                  <AgentIcon agentId={brainAgentId(turn.brain)} size={11} />
                  {humanizeBrainId(turn.brain)}
                </span>
              )}
            </TurnFooter>
          )}
        </MessageBody>
      </Message>
    </FeedbackFrame>
  );
});

/** Context carried over from an earlier session: folded to one line like any
 *  compacted conversation, its summary a click away. */
function ChatHandoverCard({ text }: { text: string }) {
  return (
    <CompactionSummary>
      <MarkdownBody source={text} />
    </CompactionSummary>
  );
}

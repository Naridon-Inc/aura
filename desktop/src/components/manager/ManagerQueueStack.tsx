import { useState, type PointerEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  GripVertical,
  Pencil,
  X,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { usePointerDrag } from "../ui/use-pointer-drag";
import type { ComposerAttachment, ComposerMode } from "./ManagerComposer";
import type { ReasoningEffort, ApprovalPolicy } from "../../lib/api";
import "../ui/chat-surface.css";

/** A message parked while a turn is in flight (W2 — the
 *  type-ahead queue). Carries the full send payload so draining replays it
 *  identically — including the cross-agent Effort/Fast controls — through
 *  whichever brain or piped PTY runs the turn. `attachments` is in-memory
 *  only and is stripped before the queue is persisted (base64 blobs would
 *  blow the localStorage quota and don't survive a reload anyway). */
export type QueuedMessage = {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  mode: ComposerMode;
  pipeTargetSessionId: string | null;
  effort: ReasoningEffort | null;
  fast: boolean;
  approval: ApprovalPolicy | null;
  /** Armed the Goal toggle — this queued turn sends as a goal when it drains. */
  goal?: boolean;
};

type Props = {
  queue: QueuedMessage[];
  /** Whether a turn is currently in flight — drives the header copy. */
  busy: boolean;
  onRemove: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  /** Promote to the head so it drains next. */
  onPromote: (id: string) => void;
  onMove: (id: string, dir: "up" | "down") => void;
  onClear: () => void;
};

/** The grip is what a hand reaches for, but it is the row that moves: a press
 *  on the grip is passed on as a press on its row, so the row is what lifts
 *  and follows the pointer. */
function asRowPress(event: PointerEvent<HTMLElement>): PointerEvent<HTMLElement> | undefined {
  const row = event.currentTarget.closest<HTMLElement>(".ui-queue-row");
  return row ? { ...event, currentTarget: row, target: row } : undefined;
}

const MODE_LABEL: Record<ComposerMode, string> = {
  auto: "Autopilot",
  plan: "Plan",
  build: "Build",
  ask: "Ask",
};

export function ManagerQueueStack({
  queue,
  busy,
  onRemove,
  onEdit,
  onPromote,
  onMove,
  onClear,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Pointer-driven: the desktop app's web view never delivers an HTML5 drop.
  const drag = usePointerDrag<string>((id, row) => moveTo(id, Number(row)));

  if (queue.length === 0) return null;

  // Each step is a functional update upstream, so stepping is safe in a loop.
  function moveTo(id: string, target: number) {
    const from = queue.findIndex((m) => m.id === id);
    const to = Math.max(0, Math.min(queue.length - 1, target));
    if (from < 0 || from === to) return;
    const dir = to < from ? "up" : "down";
    for (let step = 0; step < Math.abs(to - from); step += 1) onMove(id, dir);
  }

  function save() {
    const next = draft.trim();
    if (!editingId || !next) return;
    onEdit(editingId, next);
    setEditingId(null);
    setDraft("");
  }
  function cancel() {
    setEditingId(null);
    setDraft("");
  }

  return (
    <div className="ui-message-queue ui-chat-queue" aria-label="Queued messages">
      <div className="ui-queue-caption">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {queue.length} queued {queue.length === 1 ? "message" : "messages"}
          <span className="ui-queue-hint">
            {busy ? "Sends as the agent finishes each turn" : "Sending now"}
          </span>
        </button>
        <Button size="xs" variant="ghost" onClick={onClear} title="Clear the queue">
          Clear
        </Button>
      </div>
      {expanded &&
        queue.map((m, i) => (
          <div
            className="ui-queue-row"
            key={m.id}
            {...drag.target(String(i))}
            {...(editingId !== m.id ? drag.source(m.id) : {})}
          >
            <button
              type="button"
              className="ui-queue-handle"
              aria-label={`Reorder queued message ${i + 1}`}
              title="Alt + arrow keys to reorder"
              onPointerDown={(event) => {
                const press = editingId !== m.id && asRowPress(event);
                if (press) drag.source(m.id).onPointerDown(press);
              }}
              onKeyDown={(event) => {
                if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  onMove(m.id, event.key === "ArrowUp" ? "up" : "down");
                }
              }}
            >
              <GripVertical size={14} />
            </button>
            {editingId === m.id ? (
              <div className="ui-queue-editor">
                <Textarea
                  aria-label="Edit queued message"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      cancel();
                    }
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      save();
                    }
                  }}
                />
                <div className="ui-pattern-actions">
                  <Button size="xs" variant="ghost" onClick={cancel}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={!draft.trim()} onClick={save}>
                    Save edit
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="ui-queue-text" title={m.text}>
                  {/* How the message will run, shown before it ever fires. */}
                  <span className="ui-queue-badges">
                    {m.mode !== "build" && <Badge variant="outline">{MODE_LABEL[m.mode]}</Badge>}
                    {m.effort && <Badge variant="outline">{m.effort}</Badge>}
                    {m.fast && <Badge variant="outline">Fast</Badge>}
                    {m.goal && <Badge variant="outline">Goal</Badge>}
                    {m.pipeTargetSessionId && <Badge variant="outline">To agent</Badge>}
                  </span>
                  <span className="ui-chat-queue-text">{m.text || "(empty)"}</span>
                </div>
                <div className="ui-queue-actions">
                  {i > 0 && (
                    <Button
                      variant="ghost"
                      size="iconXs"
                      aria-label={`Send queued message ${i + 1} next`}
                      title="Send next"
                      onClick={() => onPromote(m.id)}
                    >
                      <ChevronsUp />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Move message ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => onMove(m.id, "up")}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Move message ${i + 1} down`}
                    disabled={i === queue.length - 1}
                    onClick={() => onMove(m.id, "down")}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Edit queued message ${i + 1}`}
                    onClick={() => {
                      setEditingId(m.id);
                      setDraft(m.text);
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Remove queued message ${i + 1}`}
                    onClick={() => onRemove(m.id)}
                  >
                    <X />
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
    </div>
  );
}

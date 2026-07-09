import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronsUp, Pencil, X } from "lucide-react";
import type { ComposerAttachment, ComposerMode } from "./ManagerComposer";
import type { ReasoningEffort, ApprovalPolicy } from "../../lib/api";

/** A message parked while a turn is in flight (W2 — Conductor-style
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

const MODE_LABEL: Record<ComposerMode, string> = {
  auto: "Auto",
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // Focus the inline editor as soon as it mounts so editing is keyboard-first.
  useEffect(() => {
    if (editingId) editRef.current?.focus();
  }, [editingId]);

  if (queue.length === 0) return null;

  function startEdit(m: QueuedMessage) {
    setEditingId(m.id);
    setDraft(m.text);
  }
  function commitEdit() {
    if (editingId) {
      const next = draft.trim();
      if (next) onEdit(editingId, next);
    }
    setEditingId(null);
    setDraft("");
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft("");
  }

  return (
    <div
      className="mb-1.5 rounded-md overflow-hidden"
      style={{
        background: "var(--color-bg-2)",
        border: "1px solid var(--color-line-soft)",
      }}
    >
      <div className="flex items-center gap-2 px-2.5 py-1 text-[10.5px] text-text-3">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: "var(--color-accent)" }}
        />
        <span className="flex-1">
          {queue.length} queued ·{" "}
          {busy ? "sends as the agent finishes each turn" : "draining…"}
        </span>
        <button
          type="button"
          className="text-text-3 hover:text-text-1 transition-colors"
          onClick={onClear}
          title="Clear the queue"
        >
          Clear
        </button>
      </div>

      <ul className="flex flex-col">
        {queue.map((m, i) => {
          const editing = editingId === m.id;
          return (
            <li
              key={m.id}
              className="flex items-center gap-2 px-2.5 py-1.5 border-t text-[12px]"
              style={{ borderColor: "var(--color-line-soft)" }}
            >
              <span className="text-text-4 tabular-nums w-4 text-right">
                {i + 1}
              </span>

              {/* Per-turn run-option badges, so a queued message shows how it
                  will run before it ever fires. */}
              {m.mode !== "build" && (
                <span className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-bg-3 text-text-3 shrink-0">{MODE_LABEL[m.mode]}</span>
              )}
              {m.effort && (
                <span className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-bg-3 text-text-3 shrink-0" style={{ color: "var(--color-accent)" }}>
                  {m.effort}
                </span>
              )}
              {m.fast && (
                <span className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-bg-3 text-text-3 shrink-0" style={{ color: "var(--color-accent)" }}>
                  ⚡
                </span>
              )}
              {m.pipeTargetSessionId && <span className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-bg-3 text-text-3 shrink-0">↪</span>}

              {editing ? (
                <input
                  ref={editRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={commitEdit}
                  className="flex-1 min-w-0 bg-transparent outline-none text-text-1"
                />
              ) : (
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left truncate text-text-2 hover:text-text-1 transition-colors"
                  onDoubleClick={() => startEdit(m)}
                  title={m.text}
                >
                  {m.text || "(empty)"}
                </button>
              )}

              <div className="flex items-center gap-0.5 shrink-0 text-text-3">
                {editing ? (
                  <IconBtn label="Save" onClick={commitEdit}>
                    <Check size={13} />
                  </IconBtn>
                ) : (
                  <>
                    {i > 0 && (
                      <IconBtn label="Send next" onClick={() => onPromote(m.id)}>
                        <ChevronsUp size={13} />
                      </IconBtn>
                    )}
                    <IconBtn
                      label="Move up"
                      disabled={i === 0}
                      onClick={() => onMove(m.id, "up")}
                    >
                      <ArrowUp size={13} />
                    </IconBtn>
                    <IconBtn
                      label="Move down"
                      disabled={i === queue.length - 1}
                      onClick={() => onMove(m.id, "down")}
                    >
                      <ArrowDown size={13} />
                    </IconBtn>
                    <IconBtn label="Edit" onClick={() => startEdit(m)}>
                      <Pencil size={13} />
                    </IconBtn>
                    <IconBtn label="Remove" onClick={() => onRemove(m.id)}>
                      <X size={13} />
                    </IconBtn>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="p-1 rounded hover:bg-bg-3 hover:text-text-1 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

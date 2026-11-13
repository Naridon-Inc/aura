import { useState } from "react";
import {
  ArrowUp,
  ArrowDown,
  GripVertical,
  Pencil,
  X,
  CornerUpLeft,
  ChevronRight,
  ChevronDown,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "./button";
import { Textarea } from "./textarea";
export interface QueueEntry {
  id: string;
  text: string;
}
export function MessageQueue({
  items,
  onChange,
  onSteer,
  paused,
  onPausedChange,
}: {
  items: QueueEntry[];
  onChange: (items: QueueEntry[]) => void;
  onSteer?: (item: QueueEntry) => void;
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [dragged, setDragged] = useState<string>();
  const move = (id: string, target: number) => {
    const origin = items.findIndex((item) => item.id === id);
    if (origin < 0 || target < 0 || target >= items.length) return;
    const next = [...items];
    next.splice(target, 0, ...next.splice(origin, 1));
    onChange(next);
  };
  const save = () => {
    if (draft.trim()) {
      onChange(items.map((item) => (item.id === editing ? { ...item, text: draft } : item)));
      setEditing(undefined);
    }
  };
  if (!items.length) return null;
  return (
    <div className="ui-message-queue" aria-label="Queued messages">
      <div className="ui-queue-caption">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {items.length} queued {items.length === 1 ? "message" : "messages"}
        </button>
        {onPausedChange && (
          <Button size="xs" variant="ghost" onClick={() => onPausedChange(!paused)}>
            {paused ? <Play /> : <Pause />}
            {paused ? "Resume queue" : "Pause queue"}
          </Button>
        )}
      </div>
      {expanded &&
        items.map((item, index) => (
          <div
            className="ui-queue-row"
            key={item.id}
            draggable={editing !== item.id}
            onDragStart={() => setDragged(item.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragged) move(dragged, index);
              setDragged(undefined);
            }}
          >
            <button
              className="ui-queue-handle"
              aria-label={`Reorder queued message ${index + 1}`}
              title="Alt + arrow keys to reorder"
              onKeyDown={(event) => {
                if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                  event.preventDefault();
                  move(item.id, index + (event.key === "ArrowUp" ? -1 : 1));
                }
              }}
            >
              <GripVertical size={14} />
            </button>
            {editing === item.id ? (
              <div className="ui-queue-editor">
                <Textarea
                  aria-label="Edit queued message"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setEditing(undefined);
                    }
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      save();
                    }
                  }}
                />
                <div className="ui-pattern-actions">
                  <Button size="xs" variant="ghost" onClick={() => setEditing(undefined)}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={!draft.trim()} onClick={save}>
                    Save edit
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <span className="ui-queue-text">{item.text}</span>
                <div className="ui-queue-actions">
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Move message ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(item.id, index - 1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Move message ${index + 1} down`}
                    disabled={index === items.length - 1}
                    onClick={() => move(item.id, index + 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Edit queued message ${index + 1}`}
                    onClick={() => {
                      setEditing(item.id);
                      setDraft(item.text);
                    }}
                  >
                    <Pencil />
                  </Button>
                  {onSteer && (
                    <Button
                      variant="ghost"
                      size="iconXs"
                      aria-label={`Send queued message ${index + 1} now`}
                      onClick={() => onSteer(item)}
                    >
                      <CornerUpLeft />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="iconXs"
                    aria-label={`Remove queued message ${index + 1}`}
                    onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}
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

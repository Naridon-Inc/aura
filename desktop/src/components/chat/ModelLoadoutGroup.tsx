// The loadout, at the top of the model picker.
//
// The models somebody switches between are a handful; the catalog is every
// model every installed agent can run. Before this the two were one list and
// the shortlist existed only as a star glyph you could not reach from the
// keyboard. These rows are that shortlist, in the order the user put them,
// each of the first few with a chord.
//
// Reordering is a drag, as it is in the design this follows, and also ⌥↑/⌥↓ on
// the row — a list whose order is the whole point cannot be arrangeable only
// by mouse, because the thing the order buys you is keyboard access.

import { useState } from "react";
import { Check, GripVertical, X } from "lucide-react";
import { Kbd } from "../ui/kbd";
import { rowKey } from "../../lib/modelCatalog";
import { loadoutChordLabel, type LoadoutRow } from "../../lib/modelLoadout";

export function ModelLoadoutGroup({
  rows,
  selectedKey,
  onPick,
  onRemove,
  onReorder,
}: {
  /** Already resolved against the live catalog, in loadout order. */
  rows: LoadoutRow[];
  /** `rowKey` of the current selection, so one row can show a check. */
  selectedKey: string | null;
  onPick: (row: LoadoutRow) => void;
  onRemove: (row: LoadoutRow) => void;
  /** Move the row keyed `fromKey` to where `toKey` sits. Keys rather than
   *  positions: these rows are the stored order with the unavailable entries
   *  skipped, so a position here does not index the stored list. */
  onReorder: (fromKey: string, toKey: string) => void;
}) {
  // The row being dragged and the gap it is hovering over, so the list shows
  // where the drop will land instead of only reacting after it happens.
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  if (rows.length === 0) return null;

  function endDrag() {
    setDragFrom(null);
    setDragOver(null);
  }

  return (
    <div className="chat-loadout" role="group" aria-label="Your models">
      <div className="chat-catalog-group chat-loadout-head">Your models</div>
      {rows.map((row, i) => {
        const key = rowKey(row.brain.id, row.model);
        const chord = loadoutChordLabel(i);
        return (
          <div
            key={key}
            className="chat-catalog-row chat-loadout-row"
            draggable
            data-dragging={dragFrom === i}
            data-drop-target={dragOver === i && dragFrom !== i}
            onDragStart={(e) => {
              setDragFrom(i);
              // Some value has to be set or Safari/WebKit refuses the drag.
              e.dataTransfer.setData("text/plain", key);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (dragFrom == null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOver(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom != null && dragFrom !== i) {
                const from = rows[dragFrom];
                if (from) onReorder(rowKey(from.brain.id, from.model), key);
              }
              endDrag();
            }}
            onDragEnd={endDrag}
          >
            <span className="chat-loadout-handle" aria-hidden>
              <GripVertical size={13} />
            </span>
            <button
              type="button"
              // `aria-current`, not `aria-selected`: these are buttons in a
              // group, not options in the listbox below — the search field
              // drives that one, and claiming otherwise would put two
              // listboxes under one combobox.
              aria-current={key === selectedKey ? "true" : undefined}
              className="chat-loadout-pick"
              title={row.model.id ?? row.brain.label}
              onClick={() => onPick(row)}
              onKeyDown={(e) => {
                // ⌥↑ / ⌥↓ move the row. Plain arrows stay with the list's own
                // navigation, which the search field drives.
                if (!e.altKey) return;
                const swap = e.key === "ArrowUp" ? i - 1 : i + 1;
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                const other = rows[swap];
                if (!other) return;
                e.preventDefault();
                onReorder(key, rowKey(other.brain.id, other.model));
              }}
            >
              <span className="chat-loadout-name">{row.model.label}</span>
              <span className="chat-loadout-where">{row.brain.label}</span>
              {chord && <Kbd className="chat-loadout-chord">{chord}</Kbd>}
              {key === selectedKey && <Check size={14} />}
            </button>
            <button
              type="button"
              className="chat-loadout-drop"
              aria-label={`Remove ${row.model.label} from your models`}
              title="Remove from your models"
              onClick={() => onRemove(row)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

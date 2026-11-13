// Pick a task's labels from the ones the board already uses, or make a new
// one by typing it. Ticks are kept while the picker is open and saved once
// when it closes, so several changes are one write.

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { TaskPropertyEmpty, TaskPropertyTags } from "../ui/tasks-properties";

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function TaskLabelPicker({
  labels,
  known,
  onChange,
}: {
  labels: string[];
  /** Every label in use on the board, offered as ticks. */
  known: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(labels);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setPicked(labels);
  }, [labels, open]);

  const all = useMemo(
    () => [...new Set([...labels, ...known])].sort((a, b) => a.localeCompare(b)),
    [labels, known],
  );
  const q = query.trim();
  const lower = q.toLowerCase();
  const shown = q ? all.filter((l) => l.toLowerCase().includes(lower)) : all;
  const exact = all.find((l) => l.toLowerCase() === lower);

  const toggle = (label: string) =>
    setPicked((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));
  const create = () => {
    if (!q) return;
    if (exact) {
      if (!picked.includes(exact)) toggle(exact);
    } else {
      setPicked((cur) => [...cur, q]);
    }
    setQuery("");
  };
  const close = () => {
    setOpen(false);
    setQuery("");
    if (!sameSet(picked, labels)) onChange(picked);
  };

  const face = open ? picked : labels;
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ui-tasks-property-tags-trigger"
          aria-label={face.length ? `Labels: ${face.join(", ")}. Change them` : "Add labels"}
        >
          {face.length ? (
            <TaskPropertyTags tags={face} />
          ) : (
            <TaskPropertyEmpty>Add labels</TaskPropertyEmpty>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="ui-tasks-property-popover">
        <Input
          autoFocus
          value={query}
          placeholder="Find or create a label"
          aria-label="Find or create a label"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
        />
        {shown.length > 0 ? (
          <div className="ui-tasks-property-options" role="group" aria-label="Labels">
            {shown.map((l) => (
              <label key={l} className="ui-check-label">
                <Checkbox checked={picked.includes(l)} onCheckedChange={() => toggle(l)} />
                {l}
              </label>
            ))}
          </div>
        ) : (
          !q && <p>No labels on this board yet. Type one to make it.</p>
        )}
        {q && !exact && (
          <Button variant="ghost" size="xs" onClick={create}>
            <Plus aria-hidden />
            Create “{q}”
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

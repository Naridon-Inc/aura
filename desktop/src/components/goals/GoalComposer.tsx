// GoalComposer — the one-line "state a goal" affordance shared by the session
// and task goal cards. Collapsed it's a quiet "+ Set a goal…" button; expanded
// it's a single text field (optionally prefilled with the run's intent or the
// task's title) that hands the trimmed requirement back to its parent. The
// parent owns what association the new goal gets (proven against this run, or
// linked to this task) — the composer only captures the sentence.

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import "./goals.css";

export function GoalComposer({
  prefill,
  placeholder,
  cta,
  busy,
  onSubmit,
}: {
  /** Seed text when the field opens (intent headline / task title). */
  prefill?: string;
  placeholder: string;
  /** Collapsed-button label, e.g. "Set a goal for this run". */
  cta: string;
  busy?: boolean;
  onSubmit: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText(prefill ?? "");
      // focus + place caret at end on next frame
      const id = requestAnimationFrame(() => {
        const el = ref.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open, prefill]);

  function submit() {
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText("");
    setOpen(false);
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" className="ui-goal-add" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        {cta}
      </Button>
    );
  }

  return (
    <div className="ui-goal-composer">
      <Input
        ref={ref}
        size="small"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <Button type="button" variant="secondary" size="sm" onClick={submit} disabled={busy || !text.trim()}>
        {busy ? "Adding…" : "Add"}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

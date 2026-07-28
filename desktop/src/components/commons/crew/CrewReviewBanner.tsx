// Crew · Reality check — the calm guard that sits above the board before you
// Run. The planning stage shouldn't hand an agent work that's already finished,
// duplicated, or an empty stub, so the moment the queue loads we quietly ask
// the engine (`loop_review`) which tasks aren't worth dispatching as-is and, if
// any, surface them here in plain language. Honest signals only — a finished
// task shares the name, a recent commit delivered it, two pending tasks are the
// same work, or it's a placeholder with no body. We never claim the code is
// done; the human keeps or drops each, one tap.
//
// Collapsed to a single amber line by default (quiet by design — an empty
// check renders nothing at all). Expand to read each reason and act:
//   • already done / duplicate → Mark done (leaves the ready set; the twin or
//     the real finished work carries it).
//   • empty stub → Open to fill it in (or drop it from the board).

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Copy,
  PencilLine,
} from "lucide-react";

import type { LoopTaskFlag, LoopTaskFlagKind } from "../../../lib/api";
import { Button } from "../../ui/button";

const KIND_META: Record<
  LoopTaskFlagKind,
  { label: string; icon: typeof Check; tone: string }
> = {
  already_done: { label: "Already done", icon: Check, tone: "var(--color-accent-green)" },
  duplicate: { label: "Duplicate", icon: Copy, tone: "var(--color-amber)" },
  thin: { label: "Empty stub", icon: CircleSlash, tone: "var(--color-text-4)" },
};

export function CrewReviewBanner({
  flags,
  onMarkDone,
  onOpen,
  onDismiss,
}: {
  flags: LoopTaskFlag[];
  /** Resolve a flag by taking the task out of the ready set (status → done). */
  onMarkDone: (id: string) => void;
  /** Jump to a task's detail so an empty stub can be filled in. */
  onOpen: (id: string) => void;
  /** Keep everything — hide the banner for this session's queue. */
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (flags.length === 0) return null;

  const n = flags.length;

  return (
    <div className="shrink-0 border-b border-line-soft bg-amber/[0.07]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-6 py-2.5 text-left"
      >
        <AlertTriangle size={14} style={{ color: "var(--color-amber)" }} className="shrink-0" />
        <span className="text-[12px] font-medium text-text-2">
          {n} task{n === 1 ? "" : "s"} worth a second look before you run
        </span>
        <span className="text-[11.5px] text-text-4">
          — some look already done, duplicated, or empty.
        </span>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-text-4">
          {open ? "Hide" : "Review"}
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-1.5 px-6 pb-3">
          {flags.map((f) => {
            const meta = KIND_META[f.kind];
            const Icon = meta.icon;
            const editable = f.kind === "thin";
            return (
              <div
                key={f.id}
                className="flex items-start gap-3 rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] px-3 py-2"
              >
                <span
                  className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded"
                  style={{
                    background: `color-mix(in srgb, ${meta.tone} 16%, transparent)`,
                    color: meta.tone,
                  }}
                >
                  <Icon size={12} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[9.5px] font-semibold uppercase tracking-[0.07em]"
                      style={{ color: meta.tone }}
                    >
                      {meta.label}
                    </span>
                    <span className="truncate text-[12.5px] font-medium text-text-1" title={f.title}>
                      {f.title}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-4">{f.reason}</p>
                  {f.evidence ? (
                    <p className="mt-0.5 text-[11px] text-text-5">
                      <span className="opacity-70">↔ same as</span> {f.evidence}
                    </p>
                  ) : null}
                </div>
                <div className="shrink-0">
                  {editable ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => onOpen(f.id)}
                      className="gap-1"
                    >
                      <PencilLine size={12} />
                      Open
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => onMarkDone(f.id)}
                      className="gap-1"
                    >
                      <Check size={12} />
                      Mark done
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="mt-0.5 flex justify-end">
            <Button variant="ghost" size="xs" onClick={onDismiss} className="text-text-5">
              Keep all
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Feature Map — the step card.
//
// A house Popover anchored to the clicked step's rectangle on screen. It
// says what the step does (the sentence and the code's own comment),
// where it runs, what it also calls, who last changed the file and why,
// and the one line of evidence — file and line — that opens in the editor.
// No paragraph in here is generated: every string is a payload field or a
// fixed label.

import { useEffect } from "react";
import type { KgFlow, KgFlowStep } from "../../../lib/api";
import { Button } from "../../ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "../../ui/popover";
import { relativeTime, whereLabel } from "./model";

type Props = {
  flow: KgFlow;
  index: number;
  /** Anchor rectangle in host-pixel coordinates. */
  anchor: { left: number; top: number; width: number; height: number };
  now: number;
  repoRoot: string;
  areaOf: (featureId: string | null) => string;
  featureName: (featureId: string | null) => string | null;
  onClose: () => void;
  onStep: (index: number) => void;
};

export function openInEditor(repoRoot: string, file: string, line: number) {
  const path = file.startsWith("/") ? file : `${repoRoot.replace(/\/$/, "")}/${file}`;
  window.dispatchEvent(
    new CustomEvent("aura:open-file", { detail: { path, line: line || undefined } }),
  );
}

export function StepCard({
  flow,
  index,
  anchor,
  now,
  repoRoot,
  areaOf,
  featureName,
  onClose,
  onStep,
}: Props) {
  const step: KgFlowStep | undefined = flow.steps[index];
  const total = flow.steps.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && index < total - 1) onStep(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onStep(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, total, onStep]);

  if (!step) return null;
  const crosses = step.feature && step.feature !== flow.feature ? featureName(step.feature) : null;

  return (
    <Popover open onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <div
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            left: anchor.left,
            top: anchor.top,
            width: anchor.width,
            height: anchor.height,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        collisionPadding={12}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[288px] p-0 overflow-hidden text-xs"
      >
        <div className="px-3 pt-2.5 pb-2 border-b border-line-soft">
          <div className="text-text-4 text-2xs tabular-nums">
            Step {index + 1} of {total} · {whereLabel(step.where, areaOf(step.feature))}
          </div>
          <div className="text-text-1 text-sm font-medium leading-snug mt-0.5">
            {step.text}
          </div>
        </div>

        <div className="px-3 py-2 flex flex-col gap-2">
          {step.doc ? (
            <p className="text-text-2 leading-relaxed">{step.doc}</p>
          ) : (
            <p className="text-text-4 leading-relaxed">
              The code left no note above this step.
            </p>
          )}

          {step.also_calls.length > 0 && (
            <Row label="Also calls">
              <div className="flex flex-wrap gap-1">
                {step.also_calls.map((c) => (
                  <button
                    key={`${c.file}:${c.line}:${c.name}`}
                    type="button"
                    onClick={() => openInEditor(repoRoot, c.file, c.line)}
                    className="font-mono text-2xs px-1.5 py-0.5 rounded border border-line-soft bg-bg-1 text-text-2 hover:bg-state-hover hover:text-text-1"
                    title={`${c.file}:${c.line}`}
                  >
                    {c.name}
                  </button>
                ))}
                {step.also_calls_total > step.also_calls.length && (
                  <span className="text-text-4 self-center">
                    +{step.also_calls_total - step.also_calls.length} more
                  </span>
                )}
              </div>
            </Row>
          )}

          {step.changed && (
            <Row label="Changed">
              <div className="text-text-2">
                {relativeTime(step.changed.when, now)}
                {step.changed.who ? ` by ${step.changed.who}` : ""}
              </div>
              {step.changed.why && (
                <div className="text-text-3 leading-relaxed mt-0.5">{step.changed.why}</div>
              )}
            </Row>
          )}

          {crosses && (
            <Row label="Crosses into">
              <span className="text-text-2">{crosses}</span>
            </Row>
          )}

          <Row label="Evidence">
            <button
              type="button"
              onClick={() => openInEditor(repoRoot, step.file, step.line)}
              className="font-mono text-2xs text-accent hover:underline text-left break-all"
              title="Open in the editor"
            >
              {step.file}:{step.line}
            </button>
            <div className="text-text-5 text-2xs mt-0.5">
              {step.canonical
                ? "Recognised by the last checkpoint"
                : "Not in the last checkpoint yet"}
            </div>
          </Row>
        </div>

        <div className="px-2 py-1.5 border-t border-line-soft flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={index === 0}
            onClick={() => onStep(index - 1)}
          >
            ← Previous
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={index >= total - 1}
            onClick={() => onStep(index + 1)}
          >
            Next →
          </Button>
          <span className="ml-auto text-text-5 text-2xs">Esc closes</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-2 items-start">
      <div className="text-text-4 text-2xs uppercase tracking-wide pt-0.5">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// Effort and Fast, on the model surface.
//
// These two have always been per-turn knobs for whichever brain runs the next
// turn — the same scope as the model itself. `ManagerComposer` has carried a
// comment since #17 saying they "ride inside the BrainPicker modal instead of
// sitting as two extra chips on the composer bar", and `EFFORT_OPTIONS`'
// "Default" label is worded for a strip that "lives inside the model
// switcher". Neither was true: both rows sat in a separate sliders popover one
// chip over, so choosing a model and choosing how hard it thinks were two
// menus that never mentioned each other.
//
// So this is the fold the comments described. It renders inside the picker,
// below the model list and above the footer: you pick what runs the turn, then
// how hard it runs, in reading order, on one surface.
//
// Approvals deliberately did NOT come along. It is an autonomy policy, not a
// property of the model — it outlives the turn, and it is the one row in that
// group a bystander should not be able to change by reaching for the model
// chip. It stays in the options popover.

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Zap } from "lucide-react";
import { CheckMini } from "@medusajs/icons";

import type { ReasoningEffort } from "../../lib/api";
import { Kbd } from "../ui/kbd";

/** The Effort ladder, shared by the control below and by anything that needs
 *  to name a level. A cross-agent control: whichever brain runs the next turn,
 *  the backend translates the chosen level into that provider's real
 *  thinking/reasoning knob. `null` = leave the model at its own default. */
export const EFFORT_OPTIONS: {
  value: ReasoningEffort | null;
  label: string;
  hint: string;
  blurb: string;
}[] = [
  // "Default", not "Auto" — this strip lives inside the model switcher, where
  // the model row and the routing summary each had an "Auto" of their own.
  {
    value: null,
    label: "Default",
    hint: "Whatever depth the model reasons at on its own",
    blurb: "model decides",
  },
  {
    value: "low",
    label: "Low",
    hint: "Quick, shallow reasoning",
    blurb: "quick",
  },
  {
    value: "medium",
    label: "Medium",
    hint: "Balanced reasoning",
    blurb: "balanced",
  },
  {
    value: "high",
    label: "High",
    hint: "Deep, careful reasoning. Slower",
    blurb: "deep",
  },
  {
    value: "max",
    label: "Max",
    hint: "Maximum depth. Ultrathink, slowest",
    blurb: "ultrathink",
  },
];

/** Where a level sits on the gauge. One place, because the chip, the control
 *  and the menu all draw the same four bars and had each counted them out. */
export function effortLevel(effort: ReasoningEffort | null): 0 | 1 | 2 | 3 | 4 {
  switch (effort) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    case "max":
      return 4;
    default:
      return 0;
  }
}

/** Four ascending bars, filled to `level` — a signal-strength glyph for how
 *  hard the next turn thinks. Purely presentational; the cross-agent backend
 *  translates the level into each provider's own knob. `level` 0 = unset (all
 *  bars dim). `dim` mutes the whole gauge when Fast has overridden effort. */
export function EffortGauge({
  level,
  dim,
}: {
  level: 0 | 1 | 2 | 3 | 4;
  dim?: boolean;
}) {
  const bars = [
    { x: 0.5, y: 8, h: 3 },
    { x: 4, y: 5.5, h: 5.5 },
    { x: 7.5, y: 3, h: 8 },
    { x: 11, y: 0.5, h: 10.5 },
  ];
  return (
    <svg
      width="14"
      height="12"
      viewBox="0 0 14 12"
      fill="currentColor"
      aria-hidden
      style={dim ? { opacity: 0.45 } : undefined}
    >
      {bars.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={b.y}
          width="2.2"
          height={b.h}
          rx="0.8"
          style={{ opacity: !dim && i < level ? 1 : 0.28 }}
        />
      ))}
    </svg>
  );
}

/** What the model chip appends after the model name, so the strip reads
 *  "Sonnet 5.5 · deep" / "Sonnet 5.5 · Fast" rather than making you open the
 *  picker to find out how hard the next turn is going to think. Null when
 *  there is nothing to add — effort unset and Fast off is the plain case and
 *  should stay a plain label. */
export function turnModelDetail(
  effort: ReasoningEffort | null,
  fast: boolean,
): string | null {
  if (fast) return "Fast";
  if (effort == null) return null;
  return EFFORT_OPTIONS.find((o) => o.value === effort)?.blurb ?? null;
}

export function TurnModelControls({
  fast,
  effort,
  onFastChange,
  onEffortChange,
  onPickingChange,
}: {
  fast: boolean;
  effort: ReasoningEffort | null;
  onFastChange: (value: boolean) => void;
  onEffortChange: (value: ReasoningEffort | null) => void;
  /** Told when the Effort list opens over this row, so the picker around us
   *  can stand its model list down. Without it the five levels appeared as a
   *  sixth group grown onto the end of the catalog, below everything, which
   *  read as more models rather than as a choice about the one you picked.
   *  The state stays here and is only reported; closing the popover unmounts
   *  us, and the cleanup below puts the picker back. */
  onPickingChange?: (picking: boolean) => void;
}) {
  const [picking, setPicking] = useState(false);
  const wasPicking = useRef(picking);
  const panelRef = useRef<HTMLDivElement>(null);
  const report = useRef(onPickingChange);
  report.current = onPickingChange;
  useEffect(() => {
    report.current?.(picking);
  }, [picking]);
  useEffect(() => () => report.current?.(false), []);
  // Move the focus with the drilldown, both ways — the panel is inside a
  // popover, so a click that swaps the content out from under the focused
  // button would otherwise drop the focus onto the popover itself and strand
  // anyone driving this from the keyboard.
  useEffect(() => {
    if (wasPicking.current !== picking) {
      panelRef.current
        ?.querySelector<HTMLButtonElement>(
          picking ? ".chat-options-back" : '[data-setting="effort"]',
        )
        ?.focus();
    }
    wasPicking.current = picking;
  }, [picking]);

  const chosen =
    EFFORT_OPTIONS.find((option) => option.value === effort) ??
    EFFORT_OPTIONS[0]!;

  if (picking)
    return (
      <div className="chat-options-fields chat-turn-controls" ref={panelRef}>
        <button
          type="button"
          className="chat-options-back"
          onClick={() => setPicking(false)}
        >
          <ChevronLeft size={14} />
          <span>Reasoning effort</span>
        </button>
        <div className="chat-settings-list" role="group" aria-label="Reasoning effort">
          {EFFORT_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.label}
              className="chat-setting-choice"
              aria-pressed={effort === option.value}
              onClick={() => {
                onEffortChange(option.value);
                setPicking(false);
              }}
            >
              <span className="chat-menu-copy">
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
              {effort === option.value && <CheckMini width={14} height={14} />}
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div className="chat-options-fields chat-turn-controls" ref={panelRef}>
      <button
        type="button"
        className="chat-option-row"
        data-setting="effort"
        onClick={() => setPicking(true)}
      >
        <EffortGauge level={effortLevel(effort)} dim={fast} />
        <span className="chat-option-label">Effort</span>
        <span className="chat-option-value">
          {fast ? "Fast" : chosen.label}
        </span>
        <ChevronRight size={12} />
      </button>
      <button
        type="button"
        className="chat-option-row"
        aria-pressed={fast}
        title="Collapse reasoning to the provider minimum for the quickest reply"
        onClick={() => onFastChange(!fast)}
      >
        <Zap size={14} />
        <span className="chat-option-label">Fast</span>
        <Kbd className="chat-turn-chord">⌘⇧E</Kbd>
        <span className="chat-option-value">{fast ? "On" : "Off"}</span>
      </button>
      {/* The ladder has a key, and the only place it was written down was the
          ⌘/ sheet. Printed next to the row it walks, where someone changing
          effort by hand can see there is a faster way. */}
      <p className="chat-turn-hint">
        <Kbd>⌘⇧/</Kbd>
        <span>cycles effort without opening this</span>
      </p>
    </div>
  );
}

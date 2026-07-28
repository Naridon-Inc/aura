// ModelDefaultsPanel — "Default model + Auto-routing" config, extracted from the
// composer's old standalone DefaultModelPicker chip (#17). The composer used to
// carry TWO look-alike "Auto" chips: the per-turn BrainPicker and this. They read
// as duplicates, so this now lives *inside* the BrainPicker's model switcher (as
// its footer) instead of as a second chip. Per-turn choices sit on top; these
// global defaults collapse below.
//
// A settings-grade axis, distinct from the per-turn override beside it:
//   - Default model — what NEW agent sessions start on.
//   - Auto routing  — which concrete model "Auto" resolves to per task class
//     (simple edit / chat / plan).
// Reads/writes the same `useModelPrefs` store, so a change here is reflected
// instantly everywhere the pref is consumed.

import { useState } from "react";
import {
  MODEL_OPTIONS,
  TASK_CLASSES,
  setClassModel,
  setDefaultModel,
  useModelPrefs,
  type ModelId,
  type TaskClass,
} from "../../lib/modelStore";

/** Collapsible defaults/routing block. Collapsed by default so the model
 *  switcher stays a quick per-turn picker; one click reveals the global
 *  config. `defaultOpen` lets a caller pin it open. */
export function ModelDefaultsPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const prefs = useModelPrefs();
  const [open, setOpen] = useState(defaultOpen);

  const isAuto = prefs.default === "auto";
  const activeOpt = MODEL_OPTIONS.find((m) => m.id === prefs.default);
  // Trim the vendor prefix so the summary stays compact ("Opus 4.7", not the
  // full "Claude Opus 4.7").
  const defaultLabel = isAuto
    ? "Auto route"
    : (activeOpt?.label ?? "Auto route").replace(/^Claude\s+/, "");

  return (
    <div
      className="border-t border-line-soft"
      // Keep the switcher's palette nav (Arrow moves / Enter picks a model row)
      // from firing while the user operates these config controls — otherwise
      // Enter inside a routing <select> would pick the highlighted model row and
      // close the modal. Escape still bubbles so it closes the switcher.
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      {/* Disclosure header — a sliders glyph + summary of the current default,
          so the block reads as config (not a third model row) when collapsed. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11.5px] text-text-3 hover:bg-bg-2 transition-colors"
        aria-expanded={open}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
          <line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="10" cy="4" r="1.7" fill="var(--color-bg-3)" stroke="currentColor" strokeWidth="1.3" />
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="6" cy="8" r="1.7" fill="var(--color-bg-3)" stroke="currentColor" strokeWidth="1.3" />
          <line x1="3" y1="12" x2="13" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="11" cy="12" r="1.7" fill="var(--color-bg-3)" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span className="font-medium text-text-2">Defaults &amp; routing</span>
        <span className="ml-auto flex items-center gap-1.5 text-text-4">
          <span className="text-[11px]">{defaultLabel}</span>
          {/* Explicit size + viewBox, NOT the `.ico-12` class: that class is
              scoped `.aura-chat .ico-12`, and this panel renders inside the
              switcher's portal (outside `.aura-chat`), so the class never
              matches there — the SVG would fall back to the 300×150 default
              and blow up into a giant chevron over the rows. */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            className="shrink-0 transition-transform"
            style={{ transform: open ? "rotate(90deg)" : undefined }}
            aria-hidden
          >
            <use href="#i-chev-right" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="pb-1">
          <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-text-4">
            Default model
          </div>
          <div className="px-1">
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDefaultModel(opt.id)}
                className={`w-full flex items-start gap-2 px-2 py-1.5 rounded text-left text-[12px] hover:bg-bg-2 transition-colors ${
                  opt.id === prefs.default ? "text-text-1" : "text-text-2"
                }`}
              >
                <span className="flex flex-col">
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-[10.5px] text-text-4">{opt.hint}</span>
                </span>
                {opt.id === prefs.default && (
                  <span className="ml-auto text-[12px] text-accent">✓</span>
                )}
              </button>
            ))}
          </div>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-4">
            Auto routing
          </div>
          {TASK_CLASSES.map((cls) => (
            <ClassRow
              key={cls.id}
              cls={cls.id}
              label={cls.label}
              hint={cls.hint}
              current={prefs.byClass[cls.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One auto-routing row — a task class + a native <select> of concrete models
// (Auto excluded, since a class must resolve to a real model). A plain <select>
// on purpose: it's a leaf control, not part of the switcher's keyboard nav.
function ClassRow({
  cls,
  label,
  hint,
  current,
}: {
  cls: TaskClass;
  label: string;
  hint: string;
  current: ModelId;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]">
      <span className="flex flex-col flex-1 min-w-0">
        <span className="text-text-2 truncate">{label}</span>
        <span className="text-[10px] text-text-4 truncate">{hint}</span>
      </span>
      <select
        value={current}
        onChange={(e) => setClassModel(cls, e.target.value as ModelId)}
        className="text-[11px] bg-bg-2 text-text-2 border border-line-soft rounded h-6 px-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        {MODEL_OPTIONS.filter((m) => m.id !== "auto").map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

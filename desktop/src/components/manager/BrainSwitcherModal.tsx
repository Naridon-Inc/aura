// BrainSwitcherModal — a Cmd-K-style brain/model switcher, the same rich
// treatment the branch dropdown got (BranchSwitcherModal). Where the inline
// BrainPicker is a small anchored popover, this is a centred command palette:
// fuzzy-filter at the top, arrow keys to move, Enter to pick. Every row is a
// concrete (brain, model) pair — the family it routes through, its key status
// (amber when the API key is missing → the row can't run), a NEW pill, and a
// favourite star. An "Auto" row leads (follow the active brain on its default).
//
// It's presentation-only: BrainPicker owns the data load + the real `pick()`
// (managerSetBrainOverride + lift brain/model), and hands this modal prepared
// brains/catalog/favorites plus the callbacks. So the wording and behaviour can
// never drift between the inline popover and this surface.
//
// Renders through a portal at z-[60] (over the composer), Esc / backdrop
// mousedown closes. Arctic-blue marks the selected row; amber is reserved for
// the missing-key status only.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";

import type { BrainChoice, ModelCatalog } from "../../lib/api";
import {
  catalogFor,
  familyOf,
  modelBrandId,
  rowKey,
  type CatalogModel,
  type SelectedModel,
} from "../../lib/modelCatalog";
import { AgentIcon } from "../agent/AgentIcon";

type Props = {
  brains: BrainChoice[];
  liveCatalog: ModelCatalog | null;
  value: SelectedModel | null;
  favorites: string[];
  activeChoice: BrainChoice | null;
  loading: boolean;
  loadError: string | null;
  /** Pick a concrete (brain, model) row. */
  onPick: (brain: BrainChoice, model: CatalogModel) => void;
  /** Pick "Auto" — follow the active brain on its default model. */
  onPickAuto: () => void;
  /** Toggle a row's favourite star. */
  onToggleFav: (brainId: string, model: CatalogModel) => void;
  onClose: () => void;
  /** Optional config block pinned below the rows (e.g. defaults + auto-routing).
   *  Rendered outside the scrollable navigable list so its own controls
   *  (selects, disclosures) never collide with arrow-key row navigation. */
  footer?: React.ReactNode;
  /** Per-turn controls (Fast + Effort) pinned just below the filter, above the
   *  model list (#17). Rendered outside the navigable list so its buttons never
   *  collide with arrow-key row navigation. */
  turnControls?: React.ReactNode;
};

/** A brain whose required API key is absent can't run — its rows are shown but
 *  unselectable until the key is added. */
function isUnusable(brain: BrainChoice): boolean {
  return brain.requires_api_key && !brain.has_api_key;
}

/** Does the lifted selection point at this exact (brain, model) row? */
function isRowSelected(
  value: SelectedModel | null,
  brainId: string,
  model: CatalogModel,
): boolean {
  return (
    value != null &&
    value.brainId === brainId &&
    value.modelId === model.id &&
    value.longContext === !!model.longContext
  );
}

// One flattened, navigable entry — the Auto pseudo-row plus every (brain,
// model) pair, each tagged with the brain it sits under so the list can paint
// group headers as the brain changes.
type Entry =
  | { kind: "auto" }
  | { kind: "model"; brain: BrainChoice; model: CatalogModel; first: boolean };

export function BrainSwitcherModal({
  brains,
  liveCatalog,
  value,
  favorites,
  activeChoice,
  loading,
  loadError,
  onPick,
  onPickAuto,
  onToggleFav,
  onClose,
  footer,
  turnControls,
}: Props) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const q = query.trim().toLowerCase();

  // Build the flat, filtered entry list. A model row matches on its label, its
  // brain's label, or its family; the Auto row shows when the query is empty or
  // literally matches "auto".
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (!q || "auto".includes(q)) out.push({ kind: "auto" });
    for (const brain of brains) {
      const family = familyOf(brain);
      let first = true;
      for (const model of catalogFor(brain, liveCatalog)) {
        const hay = `${model.label} ${brain.label} ${family}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        out.push({ kind: "model", brain, model, first });
        first = false;
      }
    }
    return out;
  }, [brains, liveCatalog, q]);

  // Keep the highlight in range as the filter narrows, and scrolled into view.
  useEffect(() => {
    setIdx((i) => Math.min(Math.max(0, i), Math.max(0, entries.length - 1)));
  }, [entries.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${idx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  function pickEntry(e: Entry) {
    if (e.kind === "auto") {
      onPickAuto();
      return;
    }
    if (isUnusable(e.brain)) return; // disabled — needs an API key
    onPick(e.brain, e.model);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(entries.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[idx];
      if (entry) pickEntry(entry);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[14vh]"
      style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(3px)" }}
      onMouseDown={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="w-full max-w-[460px] overflow-hidden rounded-xl shadow-2xl"
        style={{ background: "var(--color-bg-1)", border: "1px solid var(--color-line)" }}
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        {/* Filter */}
        <div className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2">
          <Search size={14} className="shrink-0 text-text-4" />
          <input
            ref={inputRef}
            value={query}
            onChange={(ev) => {
              setQuery(ev.target.value);
              setIdx(0);
            }}
            placeholder="Switch model…"
            className="flex-1 bg-transparent text-[13px] text-text-1 placeholder:text-text-4 focus:outline-none"
          />
          <span className="text-[10px] tracking-wider text-text-5">esc</span>
        </div>

        {turnControls}

        {loadError && (
          <div
            className="border-b border-line-soft px-3.5 py-2 text-[11.5px]"
            style={{ color: "var(--color-red)", background: "color-mix(in srgb, var(--color-red) 10%, transparent)" }}
          >
            {loadError}
          </div>
        )}

        {/* Rows */}
        <div ref={listRef} className="max-h-[56vh] overflow-y-auto py-1">
          {loading && brains.length === 0 ? (
            <div className="flex items-center gap-1.5 px-3.5 py-3 text-[12px] text-text-4">
              <AsciiSpinner />
              Loading models…
            </div>
          ) : entries.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-text-4">No models match.</div>
          ) : (
            entries.map((entry, i) => {
              if (entry.kind === "auto") {
                return (
                  <AutoRow
                    key="auto"
                    index={i}
                    active={i === idx}
                    selected={value == null}
                    activeChoice={activeChoice}
                    onHover={() => setIdx(i)}
                    onPick={onPickAuto}
                  />
                );
              }
              return (
                <BrainModelRow
                  key={rowKey(entry.brain.id, entry.model)}
                  index={i}
                  brain={entry.brain}
                  model={entry.model}
                  showHeader={entry.first}
                  active={i === idx}
                  selected={isRowSelected(value, entry.brain.id, entry.model)}
                  favorited={favorites.includes(rowKey(entry.brain.id, entry.model))}
                  unusable={isUnusable(entry.brain)}
                  onHover={() => setIdx(i)}
                  onPick={() => pickEntry(entry)}
                  onToggleFav={() => onToggleFav(entry.brain.id, entry.model)}
                />
              );
            })
          )}
        </div>

        {/* Config footer — defaults + auto-routing, pinned below the navigable
            rows. Optional; collapsed by default so the modal stays a fast
            per-turn switcher. */}
        {footer}
      </div>
    </div>,
    document.body,
  );
}

function AutoRow({
  index,
  active,
  selected,
  activeChoice,
  onHover,
  onPick,
}: {
  index: number;
  active: boolean;
  selected: boolean;
  activeChoice: BrainChoice | null;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-row={index}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors " +
        (active ? "bg-bg-card" : "hover:bg-bg-2")
      }
    >
      <svg
        viewBox="0 0 24 24"
        width={12}
        height={12}
        className="shrink-0 text-text-4"
      >
        <use href="#i-sparkles" />
      </svg>
      <span className="flex-1 text-[12.5px] text-text-1">Auto</span>
      <span className="text-[10.5px] text-text-4">
        follow active brain{activeChoice ? ` · ${activeChoice.label}` : ""}
      </span>
      {selected && <span className="text-accent text-[12px]">✓</span>}
    </button>
  );
}

function BrainModelRow({
  index,
  brain,
  model,
  showHeader,
  active,
  selected,
  favorited,
  unusable,
  onHover,
  onPick,
  onToggleFav,
}: {
  index: number;
  brain: BrainChoice;
  model: CatalogModel;
  showHeader: boolean;
  active: boolean;
  selected: boolean;
  favorited: boolean;
  unusable: boolean;
  onHover: () => void;
  onPick: () => void;
  onToggleFav: () => void;
}) {
  const missingKey = brain.requires_api_key && !brain.has_api_key;
  // Brand each row by who actually MAKES the model (Claude / Gemini / GPT
  // mark), not the brain it routes through — the vendor logo the user asked
  // for. Mirrors the inline BrainPicker row so the two surfaces never drift.
  const family = familyOf(brain);
  const iconId = modelBrandId(family, brain.id, model);
  return (
    <>
      {showHeader && (
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5">
          <AgentIcon agentId={brain.id} size={13} />
          {brain.requires_api_key && (
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                brain.has_api_key ? "bg-accent-green" : "bg-text-5"
              }`}
              title={brain.has_api_key ? "API key connected" : "API key missing"}
              aria-hidden
            />
          )}
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-3">
            {brain.label}
          </span>
          {brain.active && (
            <span className="text-[9.5px] text-accent" title="The globally-active brain">
              active
            </span>
          )}
          {missingKey && <span className="ml-auto text-[9.5px] text-text-4">needs key</span>}
        </div>
      )}
      <div
        data-row={index}
        onMouseEnter={onHover}
        onMouseDown={(e) => {
          e.preventDefault();
          if (!unusable) onPick();
        }}
        title={unusable ? "Add this brain's API key in Settings → Brains to use it" : undefined}
        className={
          "group/row flex items-center gap-2 pl-8 pr-3 py-1 text-[12px] transition-colors " +
          (unusable
            ? "opacity-50 cursor-not-allowed"
            : active
              ? "bg-bg-card cursor-pointer"
              : "hover:bg-bg-2 cursor-pointer") +
          (selected ? " text-text-1" : " text-text-2")
        }
      >
        <AgentIcon agentId={iconId} size={14} />
        {/* One compact line: just the model label. The brand logo (left) and
            the group header (above) already name the vendor, so a separate
            "Claude" sub-line only made every row taller for no new info. */}
        <span className="min-w-0 truncate font-medium">{model.label}</span>
        {model.isNew && (
          <span
            className="text-[8.5px] font-semibold uppercase tracking-wide px-1 py-px rounded"
            style={{
              color: "var(--color-accent)",
              background: "color-mix(in srgb, var(--color-accent) 16%, transparent)",
            }}
          >
            New
          </span>
        )}
        <button
          type="button"
          className={`ml-auto transition-opacity ${
            favorited
              ? "opacity-100 text-accent"
              : "opacity-0 group-hover/row:opacity-60 focus-visible:opacity-100 text-text-3 hover:!opacity-100"
          }`}
          title={favorited ? "Unfavorite" : "Favorite"}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFav();
          }}
        >
          <svg viewBox="0 0 24 24" width={12} height={12} className="shrink-0">
            <use href={favorited ? "#i-star-fill" : "#i-star"} />
          </svg>
        </button>
        {selected && <span className="text-accent text-[12px] w-4 text-center">✓</span>}
      </div>
    </>
  );
}

// Composer model picker (#251) — Conductor-style. Groups by the brains the
// user actually has (`manager_list_brains`) and, under each, lists that
// family's EXACT models (Opus 4.8 1M, Sonnet 4.6, GPT-5.5 …) rather than a
// bare CLI/agent name. Picking a row is a REAL per-turn override:
//
//   1. `managerSetBrainOverride(sessionId, brainId)` — the durable record
//      so the swap survives reload and the legacy (CLI) path honors it.
//   2. `onBrainChange(brain)` — lifts the brain so the native send path
//      routes `brain_chat_turn` through it.
//   3. `onModelChange(model)` — lifts the concrete model so the same turn
//      carries `model` + `long_context` (the "1M" rows) into dispatch.
//
// Cross-agent by construction: the same row picks the brain AND the model,
// so it works for the native Aura brains and any CLI agent. Stars favorite
// a model (persisted); number keys 1-9 pick while the menu is open.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type BrainChoice, type ModelCatalog } from "../../lib/api";
import {
  catalogFor,
  familyOf,
  modelBrandId,
  modelBrandName,
  rowKey,
  toSelectedModel,
  type CatalogModel,
  type SelectedModel,
} from "../../lib/modelCatalog";
import { AgentIcon } from "../agent/AgentIcon";
import { BrainSwitcherModal } from "./BrainSwitcherModal";
import { ChipButton } from "../ui/chip";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { useDismiss } from "../../lib/useDismiss";
import { toast } from "../../lib/toast";

type Props = {
  /** Session whose next turn the chosen model runs through. */
  sessionId: string;
  /** Current per-turn model selection, or null when following the active
   *  brain on its default model. Drives the footer chip. */
  value: SelectedModel | null;
  /** Lifts the brain the model routes through (durable override). */
  onBrainChange: (choice: BrainChoice | null) => void;
  /** Lifts the per-turn model selection (or null for Auto). */
  onModelChange: (model: SelectedModel | null) => void;
  /** Disabled while a turn is in flight. */
  disabled?: boolean;
  /** Surface to open from the chip:
   *  - "inline" (default): the compact anchored dropdown (used in panels).
   *  - "modal": a Cmd-K-style centred switcher (BrainSwitcherModal) — the
   *    same rich treatment the branch dropdown got, used in the composer. */
  variant?: "inline" | "modal";
  /** Config block folded into the bottom of the modal switcher (defaults +
   *  auto-routing). Lets the composer carry a single model chip instead of a
   *  second look-alike "Auto" chip beside this one. Modal variant only. */
  modalFooter?: ReactNode;
  /** Per-turn controls (Fast + Effort) pinned above the model list in the
   *  modal switcher (#17). Folding them here keeps the composer bar to one
   *  model chip instead of three look-alike per-turn chips. Modal only. */
  turnControls?: ReactNode;
};

const FAVORITES_KEY = "aura.manager.modelFavorites";

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A brain can't run if it needs an API key the keychain doesn't hold —
 *  every model under it is unselectable until the key is added. */
function isUnusable(brain: BrainChoice): boolean {
  return brain.requires_api_key && !brain.has_api_key;
}

/** Does a lifted selection point at this exact (brain, model) row? */
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

export function BrainPicker({
  sessionId,
  value,
  onBrainChange,
  onModelChange,
  disabled,
  variant = "inline",
  modalFooter,
  turnControls,
}: Props) {
  const [open, setOpen] = useState(false);
  const [brains, setBrains] = useState<BrainChoice[]>([]);
  const [liveCatalog, setLiveCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const rootRef = useRef<HTMLDivElement>(null);

  // `/brain` slash command (handled client-side in the composer) opens this
  // picker so the user can swap the model for the next turn without reaching
  // for the chip. Purely a UI affordance — no backend round-trip.
  useEffect(() => {
    function onOpen() {
      setOpen(true);
      rootRef.current?.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("aura:composer:open-brain-picker", onOpen);
    return () =>
      window.removeEventListener("aura:composer:open-brain-picker", onOpen);
  }, []);

  // Load the catalog on mount and whenever the dropdown is opened — the
  // brain set can grow while the chat is open (the user may add an
  // openai_compat endpoint in Settings), so a fresh read on open keeps
  // the picker honest without polling.
  useEffect(() => {
    let cancelled = false;
    if (!open && brains.length > 0) return;
    setLoading(true);
    api
      .managerListBrains()
      .then((list) => {
        if (cancelled) return;
        setBrains(list);
        setLoadError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, brains.length]);

  // Pull the live model catalog (provider `/models`) once on mount — it's
  // disk-cached for 24h backend-side, so this is cheap and offline-safe.
  // Per-family resilient: families that fail to fetch simply fall back to
  // the curated static list inside `catalogFor`, so we never block the UI
  // on it and ignore the error here.
  useEffect(() => {
    let cancelled = false;
    api
      .agentModelsList()
      .then((cat) => {
        if (!cancelled) setLiveCatalog(cat);
      })
      .catch(() => {
        /* offline / no keys — static catalog covers it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeChoice = useMemo(() => brains.find((b) => b.active) ?? null, [brains]);

  // Flatten the per-brain groups in render order so number keys map to the
  // same rows the user sees, and the digit handler can resolve a hotkey to
  // its (brain, model). Only the first 9 rows get a hotkey.
  const flatRows = useMemo(() => {
    const rows: { brain: BrainChoice; model: CatalogModel; hotkey: number | null }[] = [];
    let n = 0;
    for (const brain of brains) {
      for (const model of catalogFor(brain, liveCatalog)) {
        n += 1;
        rows.push({ brain, model, hotkey: n <= 9 ? n : null });
      }
    }
    return rows;
  }, [brains, liveCatalog]);

  // Favorited rows that are still backed by an available brain — a stale
  // favorite (brain removed) is hidden but kept in storage.
  const favoriteRows = useMemo(() => {
    const out: { brain: BrainChoice; model: CatalogModel }[] = [];
    for (const fav of favorites) {
      const row = flatRows.find((r) => rowKey(r.brain.id, r.model) === fav);
      if (row) out.push({ brain: row.brain, model: row.model });
    }
    return out;
  }, [favorites, flatRows]);

  function persistFavorites(next: string[]) {
    setFavorites(next);
    try {
      if (next.length === 0) localStorage.removeItem(FAVORITES_KEY);
      else localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    } catch {
      /* storage full / disabled — favorites are a convenience, not critical */
    }
  }

  function toggleFavorite(brainId: string, model: CatalogModel) {
    const key = rowKey(brainId, model);
    persistFavorites(
      favorites.includes(key) ? favorites.filter((k) => k !== key) : [...favorites, key],
    );
  }

  async function pick(brain: BrainChoice | null, model: CatalogModel | null) {
    // Never lift a brain that can't run — its rows are disabled, but guard
    // the path (hotkeys, favorites) so a stray call can't steer into a 401.
    if (brain && isUnusable(brain)) return;
    setOpen(false);
    try {
      await api.managerSetBrainOverride(sessionId, brain?.id ?? null);
      onBrainChange(brain);
      onModelChange(brain && model ? toSelectedModel(brain, model) : null);
    } catch (e) {
      // Surface the failure but keep the prior selection — don't lift a
      // choice the backend rejected. Via a toast, not `loadError`: both of
      // that state's render sites are inside `{open && …}` and we closed the
      // picker on the line above, so writing it there showed the user
      // nothing at all — the picker just shut as if the switch had worked.
      const detail = e instanceof Error ? e.message : String(e);
      setLoadError(detail);
      toast.danger(
        `Couldn't switch to ${brain?.label ?? "that brain"}`,
        `${detail}. Still on the previous one.`,
      );
    }
  }

  // Inline dropdown only — the modal variant is portaled outside rootRef and
  // owns its own Esc + backdrop-close, so this would mis-fire on it.
  useDismiss(open && variant !== "modal", () => setOpen(false), rootRef);

  // Digit 1-9 picks the hotkeyed row. Inline dropdown only — the modal
  // variant owns its own keys.
  useEffect(() => {
    if (!open || variant === "modal") return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key < "1" || e.key > "9") return;
      const row = flatRows.find((r) => r.hotkey === Number(e.key));
      if (row) {
        e.preventDefault();
        void pick(row.brain, row.model);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // `pick` is stable enough for this menu's lifetime; flatRows covers the
    // data the handler reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, variant, flatRows]);

  // Nothing pinned? Say which brain the turn runs on, not "Auto" — the word
  // was doing four jobs on this one screen (mode chip, reasoning depth, this
  // chip, the routing default) and telling you nothing in any of them. The
  // brain's name is the answer to the question the chip is asked.
  const chipLabel = value ? value.label : (activeChoice?.label ?? "Default");

  return (
    <div className="relative" ref={rootRef} data-tour="brain">
      <ChipButton
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={
          value
            ? `Next turn: ${value.label}`
            : `Next turn runs on ${activeChoice ? activeChoice.label : "the active brain"} and its own model. You haven't pinned one`
        }
        // A picked model lights up with the app accent (chip-on), same as the
        // Effort / Approvals / Mode chips beside it — one selected-state
        // language across the whole composer bar. Auto (no override) stays a
        // quiet, unhighlighted chip.
        className={value ? "chip-on" : undefined}
      >
        {value ? (
          // Brand by the model's vendor, not the routing brain — an Opus
          // selection wears the Claude mark even under "Aura Pro", matching
          // the model ROWS (Conductor brands by who makes the model).
          <AgentIcon agentId={modelBrandId(value.family, value.brainId)} size={14} />
        ) : activeChoice ? (
          <AgentIcon agentId={activeChoice.id} size={14} />
        ) : (
          <svg className="ico-12"><use href="#i-sparkles" /></svg>
        )}
        <span>{chipLabel}</span>
      </ChipButton>
      {open && variant === "modal" && (
        <BrainSwitcherModal
          brains={brains}
          liveCatalog={liveCatalog}
          value={value}
          favorites={favorites}
          activeChoice={activeChoice}
          loading={loading}
          loadError={loadError}
          onPick={(brain, model) => void pick(brain, model)}
          onPickAuto={() => void pick(null, null)}
          onToggleFav={toggleFavorite}
          onClose={() => setOpen(false)}
          footer={modalFooter}
          turnControls={turnControls}
        />
      )}
      {open && variant === "inline" && (
        <div
          className="absolute left-0 bottom-7 z-30 min-w-[268px] max-h-[400px] overflow-y-auto no-scrollbar rounded-md py-1 shadow-lg"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          {/* Follow the active brain on its default model — the row the chip
              falls back to when nothing is pinned. */}
          <button
            type="button"
            onClick={() => void pick(null, null)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-state-hover transition-colors ${
              value == null ? "text-text-1" : "text-text-2"
            }`}
          >
            <svg className="ico-12 text-text-4"><use href="#i-sparkles" /></svg>
            <span className="font-medium">Follow the active brain</span>
            <span className="text-xs text-text-4">
              {activeChoice ? activeChoice.label : "whichever brain is active"}
            </span>
            {value == null && <span className="ml-auto text-accent text-sm">✓</span>}
          </button>

          {loading && brains.length === 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-text-4">
              <AsciiSpinner />
              Loading models…
            </div>
          )}
          {loadError && (
            <div className="px-2.5 py-1.5 text-xs text-red">{loadError}</div>
          )}

          {/* Favorites — pinned across agents. Stars persist; a row whose
              brain was removed is hidden until it returns. */}
          {favoriteRows.length > 0 && (
            <>
              <GroupHeader label="Favorites" />
              {favoriteRows.map(({ brain, model }) => (
                <ModelRow
                  key={`fav-${rowKey(brain.id, model)}`}
                  brain={brain}
                  model={model}
                  hotkey={null}
                  selected={isRowSelected(value, brain.id, model)}
                  favorited
                  unusable={isUnusable(brain)}
                  onPick={() => void pick(brain, model)}
                  onToggleFav={() => toggleFavorite(brain.id, model)}
                />
              ))}
            </>
          )}

          {/* One group per available brain → that family's exact models.
              Each group after the first carries a hairline rule so the
              providers read as cleanly-separated sections (Conductor-style),
              not one undifferentiated stack. */}
          {brains.map((brain, idx) => (
            <div
              key={brain.id}
              style={
                idx > 0 || favoriteRows.length > 0
                  ? {
                      marginTop: 3,
                      paddingTop: 1,
                      borderTop: "1px solid var(--color-line-soft)",
                    }
                  : undefined
              }
            >
              <GroupHeader
                label={brain.label}
                brainId={brain.id}
                active={brain.active}
                family={familyOf(brain)}
                requiresKey={brain.requires_api_key}
                hasKey={brain.has_api_key}
              />
              {catalogFor(brain, liveCatalog).map((model) => {
                const fk = rowKey(brain.id, model);
                const hk = flatRows.find((r) => r.brain.id === brain.id && r.model.key === model.key)?.hotkey ?? null;
                return (
                  <ModelRow
                    key={fk}
                    brain={brain}
                    model={model}
                    hotkey={hk}
                    selected={isRowSelected(value, brain.id, model)}
                    favorited={favorites.includes(fk)}
                    unusable={isUnusable(brain)}
                    onPick={() => void pick(brain, model)}
                    onToggleFav={() => toggleFavorite(brain.id, model)}
                  />
                );
              })}
            </div>
          ))}

          {/* Modes (#113) — un-bury the marketplace/skill-pack catalog by
              giving the agent picker its own entry, not just the Settings
              sidebar. Opens Settings → Modes, which links onward to the
              marketplace browser + publish flow. */}
          <div
            className="mt-1 pt-1"
            style={{ borderTop: "1px solid var(--color-line-soft)" }}
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(
                  new CustomEvent("aura:open-settings", { detail: { pane: "modes" } }),
                );
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-2 hover:bg-state-hover transition-colors"
            >
              <svg className="ico-12 text-text-4"><use href="#i-stack" /></svg>
              <span className="font-medium">Browse Modes…</span>
              <span className="text-xs text-text-4">install skill packs</span>
              <svg className="ico-12 ml-auto text-text-4"><use href="#i-up-right" /></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Section header — a family/agent label with its brand glyph and an
 *  inline help affordance, or a plain caption ("Favorites"). */
function GroupHeader({
  label,
  brainId,
  active,
  family,
  requiresKey,
  hasKey,
}: {
  label: string;
  brainId?: string;
  active?: boolean;
  family?: string;
  /** Hosted brain that needs an API key — drives the status dot. */
  requiresKey?: boolean;
  /** Whether the keychain currently holds that key. */
  hasKey?: boolean;
}) {
  const missingKey = !!requiresKey && !hasKey;
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
      {brainId && <AgentIcon agentId={brainId} size={13} />}
      {/* Key-status dot — only for brains that need a key. Emerald = the
          keychain holds it; amber = missing (rows below are disabled). */}
      {requiresKey && (
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            hasKey ? "bg-accent-green" : "bg-text-5"
          }`}
          title={hasKey ? "API key connected" : "API key missing"}
          aria-hidden
        />
      )}
      <span className="text-xs font-medium text-text-3">{label}</span>
      {active && (
        <span className="text-2xs text-accent" title="The globally-active brain">
          active
        </span>
      )}
      {missingKey ? (
        <button
          type="button"
          className="ml-auto text-2xs font-medium text-accent transition-opacity hover:opacity-80"
          title={`${label} needs an API key to run. Add one in Settings → Brains`}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(
              new CustomEvent("aura:open-settings", { detail: { pane: "brain" } }),
            );
          }}
        >
          Add key
        </button>
      ) : (
        family && (
          <button
            type="button"
            className="ml-auto text-text-4 hover:text-text-2 transition-colors"
            title={`Models available through ${label}`}
            onClick={(e) => e.stopPropagation()}
          >
            <svg className="ico-12"><use href="#i-help" /></svg>
          </button>
        )
      )}
    </div>
  );
}

/** One selectable model row — the model's own vendor mark + label + NEW pill,
 *  a hover/persisted star, and a number hotkey on the right. The mark sits in
 *  the same left column as the section header's glyph (Conductor-style), so a
 *  Claude model reads as Claude even when it runs through Aura Pro. */
function ModelRow({
  brain,
  model,
  hotkey,
  selected,
  favorited,
  unusable,
  onPick,
  onToggleFav,
}: {
  brain: BrainChoice;
  model: CatalogModel;
  hotkey: number | null;
  selected: boolean;
  favorited: boolean;
  /** Brain needs an API key it doesn't have — the row can't run. */
  unusable?: boolean;
  onPick: () => void;
  onToggleFav: () => void;
}) {
  const family = familyOf(brain);
  // Prefer the brand the Aura catalog stamped on the model; fall back to the
  // family mark so an offline/static row still shows the right vendor.
  const iconId = model.brand ?? modelBrandId(family, brain.id);
  const brandName = modelBrandName(family, model);
  return (
    <div
      className={`group/row w-full flex items-center gap-2 px-2.5 py-1.5 text-sm transition-colors ${
        unusable
          ? "opacity-50 cursor-not-allowed"
          : "cursor-pointer hover:bg-state-hover"
      } ${selected ? "text-text-1" : "text-text-2"}`}
      title={unusable ? "Add this brain's API key in Settings → Brains to use it" : undefined}
      onClick={unusable ? undefined : onPick}
    >
      <AgentIcon agentId={iconId} size={14} />
      {/* Small muted brand name above the bold model label ("Claude" /
          "Opus 4.8") — names who makes the model without a bulky row. */}
      <span className="min-w-0 flex flex-col leading-tight">
        {brandName && (
          <span className="text-2xs text-text-4 truncate">{brandName}</span>
        )}
        <span className="font-medium truncate">{model.label}</span>
      </span>
      {model.isNew && (
        <span
          className="text-2xs font-medium px-1 py-px rounded"
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
          favorited ? "opacity-100 text-accent" : "opacity-0 group-hover/row:opacity-60 focus-visible:opacity-100 text-text-3 hover:!opacity-100"
        }`}
        title={favorited ? "Unfavorite" : "Favorite"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav();
        }}
      >
        <svg className="ico-12"><use href={favorited ? "#i-star-fill" : "#i-star"} /></svg>
      </button>
      {selected ? (
        <span className="text-accent text-sm w-4 text-center">✓</span>
      ) : (
        <span className="text-2xs text-text-4 w-4 text-center tabular-nums">
          {hotkey ?? ""}
        </span>
      )}
    </div>
  );
}

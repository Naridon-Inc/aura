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
import { loadoutSlotKey } from "../../lib/modelLoadout";
import {
  PICK_MODEL_SLOT_EVENT,
  type PickModelSlotDetail,
} from "../../lib/composerChords";
import { toast } from "../../lib/toast";
import { AgentIcon } from "../agent/AgentIcon";
import { BrainSwitcherModal } from "./BrainSwitcherModal";
import { ChevronDown } from "lucide-react";
import { ModelCatalogPopover, useModelFavorites } from "../chat/ModelCatalogPopover";

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
  variant?: "inline" | "modal" | "popover";
  /** Config block folded into the bottom of the modal switcher (defaults +
   *  auto-routing). Lets the composer carry a single model chip instead of a
   *  second look-alike "Auto" chip beside this one. Modal variant only. */
  modalFooter?: ReactNode;
  /** The per-turn knobs (Effort, Fast), rendered inside the picker under the
   *  model list — they share the model's scope, so they share its surface. */
  turnControls?: ReactNode;
  /** True while those controls have a list open over themselves — the models
   *  stand down for it. Passed straight through to the panel. */
  turnControlsExpanded?: boolean;
  /** What `turnControls` currently reads, printed on the chip so the state of
   *  a control that now lives behind a click is still visible without one. */
  chipDetail?: string | null;
};

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
  turnControlsExpanded,
  chipDetail,
}: Props) {
  const [open, setOpen] = useState(false);
  const [brains, setBrains] = useState<BrainChoice[]>([]);
  const [liveCatalog, setLiveCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { favorites, toggleFavorite, reorderFavorites } = useModelFavorites();
  const pickLock = useRef(false);
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

  const activeChoice = useMemo(
    () => brains.find((b) => b.active) ?? null,
    [brains],
  );

  // Flatten the per-brain groups in render order so number keys map to the
  // same rows the user sees, and the digit handler can resolve a hotkey to
  // its (brain, model). Only the first 9 rows get a hotkey.
  const flatRows = useMemo(() => {
    const rows: {
      brain: BrainChoice;
      model: CatalogModel;
      hotkey: number | null;
    }[] = [];
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

  async function pick(brain: BrainChoice | null, model: CatalogModel | null) {
    // Never lift a brain that can't run — its rows are disabled, but guard
    // the path (hotkeys, favorites) so a stray call can't steer into a 401.
    if (pickLock.current || (brain && isUnusable(brain))) return;
    pickLock.current = true;
    setLoadError(null);
    try {
      await api.managerSetBrainOverride(sessionId, brain?.id ?? null);
      onBrainChange(brain);
      onModelChange(brain && model ? toSelectedModel(brain, model) : null);
      setOpen(false);
    } catch (e) {
      // Surface the failure but keep the prior selection — don't lift a
      // choice the backend rejected.
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      pickLock.current = false;
    }
  }

  // Click-outside / Esc closes; digit 1-9 picks the hotkeyed row. Only for the
  // inline dropdown — the modal variant is portaled outside rootRef and owns
  // its own Esc + backdrop-close, so this would mis-fire on it.
  useEffect(() => {
    if (!open || variant !== "inline") return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (rootRef.current && t && !rootRef.current.contains(t)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key);
        const row = flatRows.find((r) => r.hotkey === n);
        if (row) {
          e.preventDefault();
          void pick(row.brain, row.model);
        }
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
    // `pick` is stable enough for this menu's lifetime; flatRows covers the
    // data the handler reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flatRows, variant]);

  // ⌘1…⌘5 pick that slot of the loadout without opening anything. The chord
  // is dispatched app-wide, but only the picker whose composer holds the focus
  // acts: this changes the model for ONE session's next turn, and several
  // chats can be mounted at once, so a broadcast would retarget a conversation
  // the user is not looking at. The composer frame is the scope because that
  // is where the caret is while someone is writing the prompt they are about
  // to send — which is exactly when this key is for.
  const slotRef = useRef<{ favorites: string[]; rows: typeof flatRows }>({
    favorites,
    rows: flatRows,
  });
  slotRef.current = { favorites, rows: flatRows };
  useEffect(() => {
    const onSlot = (e: Event) => {
      const slot = (e as CustomEvent<PickModelSlotDetail>).detail?.slot;
      if (!slot || disabled) return;
      const frame = rootRef.current?.closest(".unified-composer");
      if (!frame || !frame.contains(document.activeElement)) return;
      const key = loadoutSlotKey(slotRef.current.favorites, slot);
      if (!key) return;
      const row = slotRef.current.rows.find(
        (r) => rowKey(r.brain.id, r.model) === key,
      );
      if (!row || isUnusable(row.brain)) return;
      void pick(row.brain, row.model);
      toast.info(`Model: ${row.model.label}`, undefined, { durationMs: 1500 });
    };
    window.addEventListener(PICK_MODEL_SLOT_EVENT, onSlot);
    return () => window.removeEventListener(PICK_MODEL_SLOT_EVENT, onSlot);
    // `pick` closes over props that are stable for this picker's lifetime; the
    // data the handler reads comes through slotRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const chipLabel = value ? value.label : "Auto";

  if (variant === "popover")
    return (
      <div className="relative" ref={rootRef} data-tour="brain">
        <ModelCatalogPopover
          label={chipLabel}
          detail={chipDetail}
          open={open}
          onOpenChange={setOpen}
          disabled={disabled}
        >
          <BrainSwitcherModal
            embedded
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
            onReorderFav={reorderFavorites}
            onClose={() => setOpen(false)}
            footer={modalFooter}
            turnControls={turnControls}
            turnControlsExpanded={turnControlsExpanded}
          />
        </ModelCatalogPopover>
      </div>
    );

  return (
    <div className="relative" ref={rootRef} data-tour="brain">
      <button
        type="button"
        className="composer-selector composer-model-selector"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Model: ${chipLabel}`}
        aria-expanded={open}
        title={
          value
            ? `Next turn: ${value.label}`
            : `Use the active agent's default model`
        }
      >
        <span>{chipLabel}</span>
        <ChevronDown size={12} />
      </button>
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
          onReorderFav={reorderFavorites}
          onClose={() => setOpen(false)}
          footer={modalFooter}
          turnControls={turnControls}
          turnControlsExpanded={turnControlsExpanded}
        />
      )}
      {open && variant === "inline" && (
        <div
          className="absolute left-0 bottom-7 z-30 min-w-[268px] max-h-[min(400px,calc(100dvh-80px))] overflow-y-auto no-scrollbar rounded-md py-1 shadow-lg"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          {/* Auto — follow the active brain on its default model. */}
          <button
            type="button"
            onClick={() => void pick(null, null)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-bg-2 transition-colors ${
              value == null ? "text-text-1" : "text-text-2"
            }`}
          >
            <svg className="ico-12 text-text-4">
              <use href="#i-sparkles" />
            </svg>
            <span className="font-medium">Auto</span>
            <span className="text-[10.5px] text-text-4">
              follow active brain
              {activeChoice ? ` · ${activeChoice.label}` : ""}
            </span>
            {value == null && (
              <span className="ml-auto text-accent text-[12px]">✓</span>
            )}
          </button>

          {loading && brains.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11px] text-text-4">
              Loading models…
            </div>
          )}
          {loadError && (
            <div className="px-2.5 py-1.5 text-[11px] text-rose-400">
              {loadError}
            </div>
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
                const hk =
                  flatRows.find(
                    (r) => r.brain.id === brain.id && r.model.key === model.key,
                  )?.hotkey ?? null;
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
                  new CustomEvent("aura:open-settings", {
                    detail: { pane: "modes" },
                  }),
                );
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-text-2 hover:bg-bg-2 transition-colors"
            >
              <svg className="ico-12 text-text-4">
                <use href="#i-stack" />
              </svg>
              <span className="font-medium">Browse Modes…</span>
              <span className="text-[10.5px] text-text-4">
                install skill packs
              </span>
              <svg className="ico-12 ml-auto text-text-4">
                <use href="#i-up-right" />
              </svg>
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
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-3">
        {label}
      </span>
      {active && (
        <span
          className="text-[9.5px] text-accent"
          title="The globally-active brain"
        >
          active
        </span>
      )}
      {missingKey ? (
        <button
          type="button"
          className="ml-auto text-[9.5px] font-medium text-amber-400 hover:text-amber-300 transition-colors"
          title={`${label} needs an API key to run — add one in Settings → Brains`}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(
              new CustomEvent("aura:open-settings", {
                detail: { pane: "brain" },
              }),
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
            <svg className="ico-12">
              <use href="#i-help" />
            </svg>
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
      className={`group/row w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] transition-colors ${
        unusable
          ? "opacity-50 cursor-not-allowed"
          : "cursor-pointer hover:bg-bg-2"
      } ${selected ? "text-text-1" : "text-text-2"}`}
      title={
        unusable
          ? "Add this brain's API key in Settings → Brains to use it"
          : undefined
      }
      onClick={unusable ? undefined : onPick}
    >
      <AgentIcon agentId={iconId} size={14} />
      {/* Small muted brand name above the bold model label ("Claude" /
          "Opus 4.8") — names who makes the model without a bulky row. */}
      <span className="min-w-0 flex flex-col leading-tight">
        {brandName && (
          <span className="text-[9.5px] text-text-4 truncate">{brandName}</span>
        )}
        <span className="font-medium truncate">{model.label}</span>
      </span>
      {model.isNew && (
        <span
          className="text-[8.5px] font-semibold uppercase tracking-wide px-1 py-px rounded"
          style={{
            color: "var(--color-accent)",
            background:
              "color-mix(in srgb, var(--color-accent) 16%, transparent)",
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
            : "opacity-0 group-hover/row:opacity-60 text-text-3 hover:!opacity-100"
        }`}
        title={favorited ? "Unfavorite" : "Favorite"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav();
        }}
      >
        <svg className="ico-12">
          <use href={favorited ? "#i-star-fill" : "#i-star"} />
        </svg>
      </button>
      {selected ? (
        <span className="text-accent text-[12px] w-4 text-center">✓</span>
      ) : (
        <span className="text-[10px] text-text-4 w-4 text-center tabular-nums">
          {hotkey ?? ""}
        </span>
      )}
    </div>
  );
}

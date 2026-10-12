// The model chip and the popup it opens, shared by every chat composer.
//
// The Aura chat, the terminal-agent chat and the structured-agent chat each
// drew their own: same catalog inside (or none — a free-text box), different
// shell around it — different width, padding, portal and layering — so the
// agent chats' pickers looked like a different app's. All three now mount this
// shell and the same `BrainSwitcherModal` catalog; only what a pick DOES
// differs (the Aura chat routes it through a brain, the terminal agent types
// the CLI's `/model` line, the structured agent sends it with the next turn).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { api, type BrainChoice, type ModelCatalog } from "../../lib/api";
import { agentName } from "../../lib/agentNames";
import {
  catalogFor,
  familyOf,
  rowKey,
  type CatalogModel,
  type SelectedModel,
} from "../../lib/modelCatalog";
import {
  loadModelLoadout,
  moveLoadoutKey,
  saveModelLoadout,
  toggleLoadoutEntry,
} from "../../lib/modelLoadout";
import { BrainSwitcherModal } from "../manager/BrainSwitcherModal";

export function ModelCatalogPopover({
  label,
  detail,
  open,
  onOpenChange,
  disabled,
  children,
}: {
  /** What the chip says: the chosen model, or the default it falls back to. */
  label: string;
  /** A second, quieter word after the model name — how hard the next turn is
   *  set to think. The knob moved inside this popover, so without it the chip
   *  would be the one control that hides its own state: you would have to open
   *  the picker to find out whether Fast was on. Omitted when there is nothing
   *  to say, so the plain case stays a plain label. */
  detail?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** The catalog panel (an embedded `BrainSwitcherModal`). */
  children: ReactNode;
}) {
  const spoken = detail ? `Model: ${label}, ${detail}` : `Model: ${label}`;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="composer-selector composer-model-selector"
          disabled={disabled}
          aria-label={spoken}
          title={spoken}
        >
          <span>{label}</span>
          {detail && <span className="composer-model-detail">{detail}</span>}
          <ChevronDown size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="chat-menu-surface chat-catalog-popover"
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        // Above the pane chrome an agent tab sits under (popouts, the dock).
        style={{ zIndex: 60 }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** The loadout — the models this user switches between, in their order,
 *  persisted and shared across every picker (see `modelLoadout`). The list is
 *  the same one the stars always wrote, read as an ordered shortlist. */
export function useModelFavorites(): {
  favorites: string[];
  toggleFavorite: (brainId: string, model: CatalogModel) => void;
  reorderFavorites: (fromKey: string, toKey: string) => void;
} {
  const [favorites, setFavorites] = useState<string[]>(() => loadModelLoadout());
  const toggleFavorite = useCallback((brainId: string, model: CatalogModel) => {
    setFavorites((current) => {
      const next = toggleLoadoutEntry(current, rowKey(brainId, model));
      saveModelLoadout(next);
      return next;
    });
  }, []);
  const reorderFavorites = useCallback((fromKey: string, toKey: string) => {
    setFavorites((current) => {
      const next = moveLoadoutKey(current, fromKey, toKey);
      if (next === current) return current;
      saveModelLoadout(next);
      return next;
    });
  }, []);
  return { favorites, toggleFavorite, reorderFavorites };
}

/** An agent tab, as the one "brain" its own catalog lists under. The label is
 *  the name a person recognises ("Claude"), never the raw id ("claude"). */
export function agentCatalogBrain(agentId: string): BrainChoice {
  return {
    id: `cli_wrapper:${agentId}`,
    label: agentName(agentId) || agentId,
    kind: "cli_wrapper",
    active: true,
    requires_api_key: false,
    has_api_key: true,
  };
}

/** The live provider catalog, fetched once `enabled` first turns true. Null
 *  until it lands or when offline — `catalogFor` then uses the curated rows. */
export function useLiveModelCatalog(enabled: boolean): ModelCatalog | null {
  const [live, setLive] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    if (!enabled || live) return;
    let cancelled = false;
    api
      .agentModelsList()
      .then((cat) => {
        if (!cancelled) setLive(cat);
      })
      .catch(() => {
        // Offline or the provider is down — the static rows still render.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, live]);
  return live;
}

/** The chip for an agent that takes its model with each turn.
 *
 *  `value` is the model id the next turn carries; "" means the agent's own
 *  configured model. The catalog covers the models Aura knows for this agent's
 *  provider, and the footer still takes any id by hand — an agent can run
 *  models no catalog lists, and losing that would be a regression. */
export function AgentTurnModelPicker({
  agentId,
  value,
  onChange,
  disabled,
  label = "Agent default",
}: {
  agentId: string;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const live = useLiveModelCatalog(open);
  const { favorites, toggleFavorite, reorderFavorites } = useModelFavorites();
  const brain = useMemo(() => agentCatalogBrain(agentId), [agentId]);
  const selected = useMemo<SelectedModel | null>(() => {
    if (!value) return null;
    // Prefer the standard-context row when an id has both; the turn carries
    // only the id.
    const rows = catalogFor(brain, live).filter((m) => m.id === value);
    const row = rows.find((m) => !m.longContext) ?? rows[0];
    return {
      brainId: brain.id,
      family: familyOf(brain),
      modelId: value,
      label: row?.label ?? value,
      longContext: !!row?.longContext,
    };
  }, [brain, live, value]);

  function choose(model: string) {
    onChange(model);
    setOpen(false);
  }

  return (
    <ModelCatalogPopover
      label={selected?.label ?? label}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <BrainSwitcherModal
        embedded
        brains={[brain]}
        liveCatalog={live}
        value={selected}
        favorites={favorites}
        activeChoice={brain}
        loading={false}
        loadError={null}
        onPick={(_brain, row) => choose(row.id ?? "")}
        onPickAuto={() => choose("")}
        onToggleFav={toggleFavorite}
        onReorderFav={reorderFavorites}
        onClose={() => setOpen(false)}
        footer={<CustomModelField value={value} onApply={choose} />}
      />
    </ModelCatalogPopover>
  );
}

/** Any model id, typed by hand, for models the catalog doesn't list. */
function CustomModelField({
  value,
  onApply,
}: {
  value: string;
  onApply: (model: string) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(value);
  return (
    <form
      className="chat-catalog-custom"
      onSubmit={(e) => {
        e.preventDefault();
        const next = draft.trim();
        if (next) onApply(next);
      }}
    >
      <label htmlFor={inputId}>
        <Cpu size={13} aria-hidden />
        <span className="sr-only">Custom model</span>
      </label>
      <input
        id={inputId}
        aria-label="Custom model id"
        placeholder="Other model id"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" disabled={!draft.trim()}>
        Use
      </button>
    </form>
  );
}

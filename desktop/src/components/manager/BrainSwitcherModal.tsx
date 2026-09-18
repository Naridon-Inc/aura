// Searchable model catalog shared by the anchored chat picker and the larger
// switcher. BrainPicker owns routing and persistence; this component only
// presents available choices and returns the exact selected pair.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Search, Star, RotateCcw, X } from "lucide-react";
import type { BrainChoice, ModelCatalog } from "../../lib/api";
import {
  catalogFor,
  familyOf,
  rowKey,
  type CatalogModel,
  type SelectedModel,
} from "../../lib/modelCatalog";
import "../chat/ChatComposer.css";

type Props = {
  brains: BrainChoice[];
  liveCatalog: ModelCatalog | null;
  value: SelectedModel | null;
  favorites: string[];
  activeChoice: BrainChoice | null;
  loading: boolean;
  loadError: string | null;
  onPick: (brain: BrainChoice, model: CatalogModel) => void;
  onPickAuto: () => void;
  onToggleFav: (brainId: string, model: CatalogModel) => void;
  onClose: () => void;
  footer?: ReactNode;
  turnControls?: ReactNode;
  embedded?: boolean;
  allowDefault?: boolean;
};
function isUnusable(brain: BrainChoice): boolean {
  return brain.requires_api_key && !brain.has_api_key;
}
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
  embedded = false,
  allowDefault = true,
}: Props) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const q = query.trim().toLowerCase();
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (allowDefault && (!q || "auto default".includes(q))) out.push({ kind: "auto" });
    for (const brain of brains) {
      let first = true;
      for (const model of catalogFor(brain, liveCatalog)) {
        if (!allowDefault && !model.id) continue;
        if (
          q &&
          !`${model.label} ${model.id} ${brain.label} ${familyOf(brain)}`
            .toLowerCase()
            .includes(q)
        )
          continue;
        out.push({ kind: "model", brain, model, first });
        first = false;
      }
    }
    return out;
  }, [brains, liveCatalog, q, allowDefault]);
  useEffect(
    () =>
      setIdx((i) => Math.min(Math.max(0, i), Math.max(0, entries.length - 1))),
    [entries.length],
  );
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [idx]);
  function pickEntry(entry: Entry) {
    if (entry.kind === "auto") onPickAuto();
    else if (!isUnusable(entry.brain)) onPick(entry.brain, entry.model);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      let next = idx + direction;
      while (next >= 0 && next < entries.length) {
        const entry = entries[next];
        if (entry.kind === "auto" || !isUnusable(entry.brain)) {
          setIdx(next);
          break;
        }
        next += direction;
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (entries[idx]) pickEntry(entries[idx]);
    }
  }
  const panel = (
    <div
      className={`chat-model-catalog ${embedded ? "" : "chat-menu-surface"}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="chat-catalog-top">
        <strong>Choose model</strong>
        <button
          type="button"
          className="composer-control-icon"
          aria-label="Close model picker"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="chat-catalog-search">
        <Search size={15} aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search models"
          aria-expanded
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={entries[idx] ? `${listId}-${idx}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIdx(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search models or providers…"
        />
      </div>
      {turnControls}
        {loadError && (
        <p role="alert" className="chat-catalog-error">
          {loadError}
        </p>
      )}
      <div
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label="Available models"
        className="chat-catalog-list"
      >
        {loading && brains.length === 0 ? (
          <p className="chat-menu-empty">Loading models…</p>
        ) : !entries.length ? (
          <p className="chat-menu-empty">No models match “{query}”.</p>
        ) : (
          entries.map((entry, i) =>
            entry.kind === "auto" ? (
              <AutoRow
                key="auto"
                id={`${listId}-${i}`}
                index={i}
                active={i === idx}
                selected={value == null}
                activeChoice={activeChoice}
                onHover={() => setIdx(i)}
                onPick={onPickAuto}
              />
            ) : (
              <BrainModelRow
                key={rowKey(entry.brain.id, entry.model)}
                id={`${listId}-${i}`}
                index={i}
                brain={entry.brain}
                model={entry.model}
                showHeader={entry.first}
                active={i === idx}
                selected={isRowSelected(value, entry.brain.id, entry.model)}
                favorited={favorites.includes(
                  rowKey(entry.brain.id, entry.model),
                )}
                unusable={isUnusable(entry.brain)}
                onHover={() => setIdx(i)}
                onPick={() => pickEntry(entry)}
                onToggleFav={() => onToggleFav(entry.brain.id, entry.model)}
              />
            ),
          )
        )}
      </div>
      {footer && <div className="chat-catalog-footer">{footer}</div>}
    </div>
  );
  if (embedded) return panel;
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="chat-catalog-backdrop" />
    <Dialog.Content aria-describedby={undefined} style={{position:"fixed", left:"50%", top:"50%", transform:"translate(-50%, -50%)", zIndex:80, maxWidth:"calc(100vw - 24px)"}}>
      <Dialog.Title className="sr-only">Choose model</Dialog.Title>
      {panel}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;

}

function AutoRow({
  id,
  index,
  active,
  selected,
  activeChoice,
  onHover,
  onPick,
}: {
  id: string;
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
      role="option"
      id={id}
      aria-selected={selected}
      data-row={index}
      data-active={active}
      className="chat-catalog-auto"
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <RotateCcw size={15} />
      <span>
        Auto
        <small>
          {activeChoice
            ? `Default for ${activeChoice.label}`
            : "Use the active agent’s default"}
        </small>
      </span>
      {selected && <Check size={14} />}
    </button>
  );
}
function BrainModelRow({
  id,
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
  id: string;
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
  return (
    <>
      {showHeader && (
        <div className="chat-catalog-group">
          {brain.label}
          {isUnusable(brain) && <span>API key needed</span>}
        </div>
      )}
      <div
        className="chat-catalog-row"
        data-active={active}
        onMouseEnter={onHover}
      >
        <button
          type="button"
          role="option"
          id={id}
          data-row={index}
          aria-selected={selected}
          disabled={unusable}
          onClick={onPick}
          title={
            unusable
              ? "Add an API key in Settings to use this model"
              : (model.id ?? undefined)
          }
        >
          <span>{model.label}</span>
          {selected && <Check size={14} />}
        </button>
        <button
          type="button"
          className="chat-catalog-favorite"
          data-favorite={favorited}
          aria-label={`${favorited ? "Unfavorite" : "Favorite"} ${model.label}`}
          aria-pressed={favorited}
          onClick={onToggleFav}
        >
          <Star size={13} fill={favorited ? "currentColor" : "none"} />
        </button>
      </div>
    </>
  );
}

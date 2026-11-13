import { useEffect, useRef, useState } from "react";
import { Check, GripVertical, X } from "lucide-react";
import { AgentIcon } from "./agent-icon";
import { ModelPicker, type ModelOption } from "./model-picker";
import { Button } from "./button";
import { usePointerDrag } from "./use-pointer-drag";

/** How many models the loadout holds. */
export const LOADOUT_SLOTS = 5;

/** `favorites` with `id` put in slot `position`: taken out of wherever it
 *  was and put back there, the list kept to the slots there are. A slot past
 *  the last filled one takes the first free slot instead. */
export function placeInLoadout(favorites: string[], id: string, position: number): string[] {
  const next = favorites.filter((item) => item !== id);
  next.splice(Math.max(0, Math.min(position, next.length)), 0, id);
  return next.slice(0, LOADOUT_SLOTS);
}

/** Where an arrow key moves a model in the loadout, one slot at a time. */
const STEPS: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

// Models are dragged with pointer events (see `use-pointer-drag`): the
// desktop app's web view never delivers an HTML5 drop. A filled slot's
// emblem also takes the arrow keys, so a model moves without a pointer.
export function ModelLoadout({
  models,
  favorites,
  onChange,
  onConfigure,
  efforts: savedEfforts,
  onEffortChange,
}: {
  models: ModelOption[];
  favorites: string[];
  onChange: (ids: string[]) => void;
  onConfigure?: (provider: string) => void;
  /** Each slot's effort by model id, when the host keeps them. Without it the
   *  efforts last as long as the loadout is on screen. */
  efforts?: Record<string, string>;
  /** A slot's effort was changed; `effort` is the model's own level name. */
  onEffortChange?: (id: string, effort: string | undefined) => void;
}) {
  const [localEfforts, setLocalEfforts] = useState<Record<string, string>>({});
  const efforts = savedEfforts ?? localEfforts;
  // A host that keeps the efforts has said what an unset one is: the first
  // rung of the model's own ladder. Without one the slot reads as High.
  const effortOf = (model: ModelOption) =>
    efforts[model.id] ??
    model.preferredEffort ??
    (savedEfforts ? model.efforts?.[0] : undefined) ??
    "High";
  const [announcement, setAnnouncement] = useState("");
  const slots = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState<number>();
  const put = (id: string, position: number) => {
    const next = placeInLoadout(favorites, id, position);
    onChange(next);
    setAnnouncement(
      `${models.find((model) => model.id === id)?.name} added to position ${next.indexOf(id) + 1}`,
    );
    return next.indexOf(id);
  };
  const drag = usePointerDrag<string>((id, slot) => put(id, Number(slot)));
  // A model moved from the keyboard keeps the focus as it changes slot.
  useEffect(() => {
    if (follow === undefined) return;
    slots.current
      ?.querySelectorAll<HTMLElement>(".ui-loadout-slot")
      [follow]?.querySelector<HTMLElement>(".ui-loadout-emblem")
      ?.focus();
    setFollow(undefined);
  }, [follow, favorites]);
  return (
    <section className="ui-loadout" aria-label="Model loadout">
      <header>
        <div>
          <h2>Loadout</h2>
          <p>Choose which models you want to use</p>
        </div>
      </header>
      <div className="ui-loadout-slots" ref={slots}>
        {Array.from({ length: LOADOUT_SLOTS }, (_, index) => {
          const model = models.find((item) => item.id === favorites[index]);
          return (
            <div
              className="ui-loadout-slot"
              key={index}
              data-empty={!model}
              {...drag.target(String(index))}
            >
              {model ? (
                <>
                  <div
                    className="ui-loadout-emblem"
                    tabIndex={0}
                    aria-label={`${model.name}, slot ${index + 1}. Arrow keys move it`}
                    aria-keyshortcuts="ArrowLeft ArrowRight"
                    {...drag.source(model.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      const step = STEPS[event.key];
                      if (!step) return;
                      event.preventDefault();
                      const to = index + step;
                      if (to < 0 || to >= favorites.length) return;
                      setFollow(put(model.id, to));
                    }}
                  >
                    <AgentIcon provider={model.provider} size={32} />
                    {index === 0 ? (
                      <small>Default</small>
                    ) : (
                      <Button
                        variant="ghost"
                        size="iconXs"
                        aria-label={`Remove ${model.name} from loadout`}
                        onClick={() => onChange(favorites.filter((id) => id !== model.id))}
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                  <ModelPicker
                    models={models}
                    value={{
                      model: model.id,
                      effort: effortOf(model),
                    }}
                    onChange={(selection) => {
                      if (onEffortChange) onEffortChange(selection.model, selection.effort);
                      else
                        setLocalEfforts({
                          ...localEfforts,
                          [selection.model]: selection.effort ?? "High",
                        });
                      const next = favorites.filter(
                        (id, i) => i !== index && id !== selection.model,
                      );
                      next.splice(Math.min(index, next.length), 0, selection.model);
                      onChange(next);
                    }}
                  />
                </>
              ) : (
                <div className="ui-loadout-empty">
                  <span>{drag.dragged ? "Drop model here" : "Empty"}</span>
                  <small>{index + 1}</small>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="ui-loadout-catalog">
        {[
          ...new Set(["Claude Code", "Codex", "Cursor", ...models.map((model) => model.provider)]),
        ].map((provider) => (
          <section key={provider}>
            <header>
              <AgentIcon provider={provider} />
              {provider}
            </header>
            {!models.some((model) => model.provider === provider) && (
              <button disabled={!onConfigure} onClick={() => onConfigure?.(provider)}>
                Configure {provider}
              </button>
            )}
            {models
              .filter((model) => model.provider === provider)
              .map((model) => (
                <button
                  type="button"
                  key={model.id}
                  {...drag.source(model.id)}
                  onClick={() => {
                    if (!favorites.includes(model.id))
                      put(model.id, Math.min(favorites.length, LOADOUT_SLOTS - 1));
                  }}
                  aria-label={`Add ${model.name} to loadout`}
                  title={model.name}
                >
                  <span>{model.name}</span>
                  {favorites.includes(model.id) && <Check size={14} />}
                  <GripVertical size={12} />
                </button>
              ))}
          </section>
        ))}
      </div>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </section>
  );
}

// The model picker for an agent tab: the shared picker, listing the models
// this agent's own provider runs. Only what a pick DOES differs between the
// two kinds of tab — a structured agent sends the id with its next turn, a
// terminal agent has the CLI's own `/model` line typed for it.

import { useMemo, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { catalogFor, rowKey } from "../../../lib/modelCatalog";
import { toast } from "../../../lib/toast";
import { Button } from "../../ui/button";
import { ModelPicker, type ModelOption } from "../../ui/model-picker";
import "../../ui/model-menu.css";
import type { AgentCliCommands } from "../../agent/chat/agentCliCommands";
import { agentCatalogBrain, useLiveModelCatalog, useModelFavorites } from "./catalogHooks";
import { AUTO_MODEL_ID, catalogOptions, reorderedLoadout, shownLoadout } from "./catalogOptions";

/** The rows one agent's picker lists, with the loadout leading. */
function useAgentOptions(agentId: string, enabled: boolean, auto: { name: string; disabled?: boolean }) {
  const live = useLiveModelCatalog(enabled);
  const { favorites, setFavorites } = useModelFavorites();
  const brain = useMemo(() => agentCatalogBrain(agentId), [agentId]);
  const built = useMemo(
    () =>
      catalogOptions({
        brains: [brain],
        live,
        favorites,
        auto: { ...auto, provider: brain.label },
      }),
    // `auto` is a literal per call site; its fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brain, live, favorites, auto.name, auto.disabled],
  );
  return {
    brain,
    live,
    ...built,
    visibleIds: built.loadout.length ? [AUTO_MODEL_ID, ...built.loadout] : undefined,
    reorder: (ids: string[]) => setFavorites(reorderedLoadout(favorites, ids)),
    show: (ids: string[]) => setFavorites(shownLoadout(favorites, ids, built.rows)),
  };
}

/** The picker for an agent that takes its model with each turn.
 *
 *  `value` is the model id the next turn carries; "" means the agent's own
 *  configured model. The search also takes any id by hand — an agent can run
 *  models no catalog lists. */
export function AgentTurnModelPicker({
  agentId,
  value,
  onChange,
  disabled,
  label = "Agent default",
  offered,
}: {
  agentId: string;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  label?: string;
  /** The models the agent's own session offers (ACP). When present they are
   *  the whole list: a catalog row the agent cannot run would be a lie. */
  offered?: { value: string; name: string; description?: string }[];
}) {
  const { brain, live, options, rows, visibleIds, reorder, show } = useAgentOptions(agentId, true, {
    name: label,
  });
  // Prefer the standard-context row when an id has both; the turn carries
  // only the id.
  const selectedId = useMemo(() => {
    if (!value) return AUTO_MODEL_ID;
    const matches = catalogFor(brain, live)
      .filter((m) => m.id === value)
      .sort((a, b) => Number(!!a.longContext) - Number(!!b.longContext));
    return matches[0] ? rowKey(brain.id, matches[0]) : `custom:${value}`;
  }, [brain, live, value]);
  const models = useMemo<ModelOption[]>(
    () =>
      rows.has(selectedId) || selectedId === AUTO_MODEL_ID
        ? options
        : [...options, { id: selectedId, name: value, provider: brain.label }],
    [options, rows, selectedId, value, brain.label],
  );
  if (offered?.length) {
    const auto = options.find((o) => o.id === AUTO_MODEL_ID);
    return (
      <ModelPicker
        models={[
          ...(auto ? [auto] : []),
          ...offered.map((m) => ({ id: `acp:${m.value}`, name: m.name, description: m.description, provider: brain.label })),
        ]}
        value={{ model: value ? `acp:${value}` : AUTO_MODEL_ID }}
        onChange={(next) => onChange(next.model === AUTO_MODEL_ID ? "" : next.model.replace(/^acp:/, ""))}
        disabled={disabled}
      />
    );
  }
  return (
    <ModelPicker
      models={models}
      value={{ model: selectedId }}
      onChange={(next) => {
        if (next.model === selectedId) return;
        if (next.model === AUTO_MODEL_ID) onChange("");
        else onChange(rows.get(next.model)?.model.id ?? value);
      }}
      visibleIds={visibleIds}
      onReorder={reorder}
      onVisibleChange={show}
      onCustomModel={onChange}
      disabled={disabled}
    />
  );
}

/** The picker for a terminal agent.
 *
 *  Two shapes, because the CLIs genuinely differ (see `agentCliCommands`). When
 *  the CLI takes an id inline, the picker lists its provider's real models and
 *  a pick types the switch. When the CLI only opens its own chooser, one
 *  button types `/model` and moves to the terminal where that chooser is drawn
 *  — listing models we couldn't actually select would be a menu that lies. */
export function AgentCliModelPicker({
  agentId,
  commands,
  onSend,
  onSwitchToTerminal,
}: {
  agentId: string;
  commands: AgentCliCommands;
  onSend: (line: string) => Promise<boolean>;
  onSwitchToTerminal?: () => void;
}) {
  const model = commands.model;
  // The last row picked here — a record of what we sent, not a claim about
  // what the agent runs: the terminal can change it without this pane knowing.
  const [sent, setSent] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  // "Agent default" is where the CLI starts, and nothing here can put it back.
  const { brain, options, rows, visibleIds, reorder, show } = useAgentOptions(
    agentId,
    model?.kind === "inline",
    { name: "Agent default", disabled: true },
  );
  if (!model) return null;
  if (model.kind === "picker")
    return (
      <Button
        variant="ghost"
        size="sm"
        className="ui-model-trigger"
        onClick={() => {
          void onSend(model.line).then((ok) => {
            if (ok) onSwitchToTerminal?.();
          });
        }}
        title={`${brain.label} draws its own model chooser — this types ${model.line} and takes you to the terminal to use it`}
      >
        <SquareTerminal />
        <span>{model.label}</span>
      </Button>
    );
  return (
    <ModelPicker
      models={options}
      value={{ model: sent ?? AUTO_MODEL_ID }}
      onChange={async (next) => {
        const row = rows.get(next.model);
        if (!row?.model.id || switching || next.model === sent) return;
        setSwitching(true);
        try {
          if (await onSend(model.line(row.model.id))) setSent(next.model);
          else toast.warning("The model did not change", "Try again.");
        } finally {
          setSwitching(false);
        }
      }}
      visibleIds={visibleIds}
      onReorder={reorder}
      onVisibleChange={show}
      disabled={switching}
    />
  );
}

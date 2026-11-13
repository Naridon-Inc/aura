import { useMemo } from "react";

import { ModelLoadout } from "../../ui/model-loadout";
import { type ModelOption } from "../../ui/model-picker";
import { Select } from "../../ui/select";
import { SettingsRow } from "../../ui/settings-row";
import { agentCatalogBrain, useLiveModelCatalog } from "../../chat/model/catalogHooks";
import { EFFORT_LEVELS, effortLabel, effortValue } from "../../chat/model/catalogOptions";
import { catalogFor, rowKey } from "../../../lib/modelCatalog";
import {
  LOADOUT_CHORD_SLOTS,
  saveLoadoutEffort,
  saveModelLoadout,
  useLoadoutEfforts,
  useModelLoadout,
} from "../../../lib/modelLoadout";
import { useOutputStyle, writeOutputStyle } from "../../../lib/outputStyle";
import { useAgentsList } from "../../../lib/agentsListCache";

// Default models: the loadout every model picker leads with, and the answer
// style new Claude Code turns ask for.
//
// The loadout is the same ordered list the pickers' stars write. Its first
// five entries are the ones with a keyboard chord, so those are the slots
// shown here; anything past them, and any entry whose agent isn't
// installed right now, is kept in the stored list untouched — uninstalling
// an agent must not quietly cost you its place in your loadout.
//
// Each slot also keeps an effort, on the chat's own ladder. It is saved with
// the loadout, and picking that slot's model in a chat sets the chat's effort
// to it.

/** The chat's effort ladder, by name, as each slot offers it. */
const LADDER = EFFORT_LEVELS.map((level) => level.label);

export function ModelsPage({ onConfigureAgent }: { onConfigureAgent: () => void }) {
  const agentsList = useAgentsList();
  const agents = useMemo(() => agentsList.data ?? [], [agentsList.data]);
  const order = useModelLoadout();
  const saved = useLoadoutEfforts();
  const style = useOutputStyle();
  const live = useLiveModelCatalog(true);

  const models = useMemo<ModelOption[]>(() => {
    const seen = new Set<string>();
    const out: ModelOption[] = [];
    for (const agent of agents) {
      if (!agent.available) continue;
      const brain = agentCatalogBrain(agent.id);
      for (const model of catalogFor(brain, live)) {
        const id = rowKey(brain.id, model);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: model.label, provider: agent.label, efforts: LADDER });
      }
    }
    return out;
  }, [agents, live]);

  const known = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const visible = order.filter((key) => known.has(key)).slice(0, LOADOUT_CHORD_SLOTS);

  // The saved levels as the slots name them. A slot saved as the model's own
  // depth reads "Default", which is also what an unset slot reads as.
  const efforts = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, effort] of Object.entries(saved)) out[key] = effortLabel(effort) ?? LADDER[0];
    return out;
  }, [saved]);

  const change = (next: string[]) => {
    const kept = order.filter((key) => !visible.includes(key) && !next.includes(key));
    const stored = [...next, ...kept];
    saveModelLoadout(stored);
  };

  return (
    <>
      <ModelLoadout
        models={models}
        favorites={visible}
        onChange={change}
        onConfigure={onConfigureAgent}
        efforts={efforts}
        onEffortChange={(key, effort) => saveLoadoutEffort(key, effortValue(effort))}
      />
      <SettingsRow
        title="Claude output style"
        description="Choose which output style to apply to new chats. Existing chats do not change."
        htmlFor="setting-output-style"
        control={
          <Select
            id="setting-output-style"
            aria-label="Claude output style"
            value={style}
            onChange={(next) => writeOutputStyle(next === "concise" ? "concise" : "default")}
            options={[
              { value: "default", label: "Default" },
              { value: "concise", label: "Concise" },
            ]}
          />
        }
      />
    </>
  );
}

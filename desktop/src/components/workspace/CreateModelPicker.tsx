// The model + effort control on the new-workspace dialog.
//
// No chat exists yet, so there is no session to persist an override against
// the way the chat composer does. This reads the user's real brains and each
// family's exact models, holds the pick, and the dialog hands it to the chat
// the moment that chat exists. Every row is a real catalog row.

import { useEffect, useMemo, useRef, useState } from "react";

import { ModelPicker, type ModelOption, type ModelSelection } from "../ui/model-picker";
import { AgentIcon } from "../agent/AgentIcon";
import { useLiveModelCatalog } from "../chat/model/catalogHooks";
import { api, type BrainChoice, type ReasoningEffort } from "../../lib/api";
import {
  catalogFor,
  familyOf,
  rowKey,
  toSelectedModel,
  type CatalogModel,
  type SelectedModel,
} from "../../lib/modelCatalog";
import { getModelPrefs } from "../../lib/modelStore";
import { DEFAULT_AGENT_ID } from "./launchNewWork";

/** Nothing pinned: the turn runs on whichever brain is active. */
const FOLLOW = "follow";

/** Named exactly as the chat composer names them. `null` leaves the model at
 *  its own depth. */
const EFFORTS: { value: ReasoningEffort | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];
const EFFORT_LABELS = EFFORTS.map((e) => e.label);

type Row = { brain: BrainChoice; model: CatalogModel };

export function CreateModelPicker({
  model,
  effort,
  onModelChange,
  onEffortChange,
}: {
  model: SelectedModel | null;
  effort: ReasoningEffort | null;
  onModelChange: (next: SelectedModel | null) => void;
  onEffortChange: (next: ReasoningEffort | null) => void;
}) {
  const [brains, setBrains] = useState<BrainChoice[]>([]);
  const live = useLiveModelCatalog(true);
  useEffect(() => {
    let cancelled = false;
    api
      .managerListBrains()
      .then((list) => !cancelled && setBrains(list))
      .catch(() => {
        /* no brains configured — the active brain is the only row */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeBrain = useMemo(() => brains.find((b) => b.active) ?? null, [brains]);
  const rows = useMemo(() => {
    const out = new Map<string, Row>();
    for (const brain of brains) {
      for (const row of catalogFor(brain, live)) out.set(rowKey(brain.id, row), { brain, model: row });
    }
    return out;
  }, [brains, live]);

  // Open on the user's saved default model rather than always on the active
  // brain: once, after the brains resolve, and never over a pick.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    if (model != null) {
      seeded.current = true;
      return;
    }
    if (brains.length === 0) return;
    seeded.current = true;
    const wanted = getModelPrefs().default;
    if (wanted === "auto") return;
    const brain =
      brains.find((b) => b.id === DEFAULT_AGENT_ID) ??
      brains.find((b) => familyOf(b) === "anthropic") ??
      brains[0];
    if (!brain) return;
    const list = catalogFor(brain, live);
    const row = list.find((m) => m.id === wanted && !m.longContext) ?? list.find((m) => m.id === wanted);
    if (row) onModelChange(toSelectedModel(brain, row));
  }, [brains, live, model, onModelChange]);

  const options = useMemo<ModelOption[]>(() => {
    const follow: ModelOption = {
      id: FOLLOW,
      name: activeBrain?.label ?? "Active brain",
      provider: activeBrain?.label ?? "",
      icon: activeBrain ? <AgentIcon agentId={activeBrain.id} label={activeBrain.label} size={14} /> : undefined,
      efforts: EFFORT_LABELS,
    };
    const out = [follow];
    for (const [id, { brain, model: row }] of rows) {
      out.push({
        id,
        name: row.label,
        provider: brain.label,
        icon: <AgentIcon agentId={brain.id} label={brain.label} size={14} />,
        // A hosted brain with no key can't run; the row says so by being off.
        disabled: brain.requires_api_key && !brain.has_api_key,
        efforts: EFFORT_LABELS,
      });
    }
    return out;
  }, [rows, activeBrain]);

  const selectedId = useMemo(() => {
    if (!model) return FOLLOW;
    for (const [id, { brain, model: row }] of rows) {
      if (
        brain.id === model.brainId &&
        row.id === model.modelId &&
        !!row.longContext === model.longContext
      ) {
        return id;
      }
    }
    return FOLLOW;
  }, [model, rows]);

  const value: ModelSelection = {
    model: selectedId,
    effort: EFFORTS.find((e) => e.value === effort)?.label ?? "Default",
  };

  const change = (next: ModelSelection) => {
    if (next.model !== selectedId) {
      const row = rows.get(next.model);
      onModelChange(row ? toSelectedModel(row.brain, row.model) : null);
    }
    const picked = EFFORTS.find((e) => e.label === next.effort);
    if (picked && picked.value !== effort) onEffortChange(picked.value);
  };

  return <ModelPicker models={options} value={value} onChange={change} />;
}

// The model catalog as the pickers read it: the live provider list, the one
// "brain" an agent tab lists its models under, and the loadout — the ordered
// shortlist every picker leads with.

import { useEffect, useState } from "react";
import { api, type BrainChoice, type ModelCatalog } from "../../../lib/api";
import { agentName } from "../../../lib/agentNames";
import { saveModelLoadout, useModelLoadout } from "../../../lib/modelLoadout";

/** The loadout, persisted and shared across every picker (see `modelLoadout`).
 *  Live: a change made anywhere else — Settings, another chat — shows here. */
export function useModelFavorites(): {
  favorites: string[];
  setFavorites: (next: string[]) => void;
} {
  return { favorites: useModelLoadout(), setFavorites: saveModelLoadout };
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

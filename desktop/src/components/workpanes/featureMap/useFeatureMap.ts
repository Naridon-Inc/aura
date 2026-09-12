// Feature Map — data.
//
// Loads the two payloads behind the map. Both come from the same knowledge
// graph, so the ensure-then-retry dance runs once: if features come back
// null there is no graph yet, so build it and ask again. Flows are asked
// for after features; a null there is treated as "no flows", never as an
// error, so an older graph still draws its features.
//
// `requestSeq` guards against a slow first build landing after the user
// switched projects — only the newest request may set state.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type KgFeatureMap, type KgFlowMap } from "../../../lib/api";

export type FeatureMapData = {
  features: KgFeatureMap | null;
  flows: KgFlowMap | null;
  loading: boolean;
  /** True while the first-ever build runs — it can take a minute. */
  building: boolean;
  error: string | null;
  reload: () => void;
};

export const EMPTY_AFTER_BUILD =
  "The map came back empty even after a build — try Rebuild, or check that this folder is a project.";

export function useFeatureMap(
  repoRoot: string,
  rebuildSignal: number,
): FeatureMapData {
  const [features, setFeatures] = useState<KgFeatureMap | null>(null);
  const [flows, setFlows] = useState<KgFlowMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const lastSignal = useRef(rebuildSignal);

  const load = useCallback(
    async (force: boolean) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        let f = force ? null : await api.auraKgFeatures(repoRoot);
        if (!f) {
          if (seq !== requestSeq.current) return;
          setBuilding(true);
          await api.auraKgBuild(repoRoot, force);
          f = await api.auraKgFeatures(repoRoot);
        }
        if (seq !== requestSeq.current) return;
        if (!f) {
          setError(EMPTY_AFTER_BUILD);
          setFeatures(null);
          setFlows(null);
          return;
        }
        const fl = await api.auraKgFlows(repoRoot);
        if (seq !== requestSeq.current) return;
        setFeatures(f);
        setFlows(fl);
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setBuilding(false);
        }
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    const force = rebuildSignal !== lastSignal.current;
    lastSignal.current = rebuildSignal;
    void load(force);
  }, [load, rebuildSignal]);

  const reload = useCallback(() => void load(false), [load]);

  return { features, flows, loading, building, error, reload };
}

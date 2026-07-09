// The HUD composer's toolbar state + option tables — full parity with
// `ManagerComposer`'s chips (mode / effort / fast / approvals / brain·model),
// living in the HUD's own JS heap. Each chip value is held here, persisted to
// localStorage (mirroring the in-app composer's keys so the two stay in lockstep
// where it makes sense), and folded into the `HudComposerConfig` a HUD send
// carries. The brain/model catalog is loaded through global `api.*` invokes (the
// HUD can't read the main window's React stores) and assembled with the SAME
// pure helpers the in-app picker uses (`catalogFor`/`toSelectedModel`).

import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  type ApprovalPolicy,
  type BrainChoice,
  type ModelCatalog,
  type ReasoningEffort,
} from "./api";
import type { HudComposerConfig, HudComposerMode, HudMenuKind, HudMenuRow } from "./hud";
import { catalogFor, type SelectedModel, toSelectedModel } from "./modelCatalog";

export type HudComposerState = {
  mode: HudComposerMode;
  effort: ReasoningEffort | null;
  fast: boolean;
  approval: ApprovalPolicy | null;
  /** The concrete model (carries its brain) — null = Auto / active brain. */
  model: SelectedModel | null;
};

// Option tables — ported verbatim from ManagerComposer so the HUD offers the
// exact same choices. `null` is the "Auto"/"Default" sentinel.
export const MODE_OPTIONS: { value: HudComposerMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "plan", label: "Plan" },
  { value: "build", label: "Build" },
  { value: "ask", label: "Ask" },
];

export const EFFORT_OPTIONS: { value: ReasoningEffort | null; label: string }[] = [
  { value: null, label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export const APPROVAL_OPTIONS: { value: ApprovalPolicy | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "accept_edits", label: "Accept Edits" },
  { value: "plan", label: "Plan" },
  { value: "bypass", label: "Bypass" },
];

// Mirror ManagerComposer's keys for the engine-agnostic chips so flipping one in
// the in-app composer reflects in the HUD on next mount (and vice versa). The
// model pick is HUD-local — the in-app picker persists it per-session via a
// backend override the HUD doesn't own.
const K_MODE = "aura.manager.mode";
const K_EFFORT = "aura.manager.effort";
const K_FAST = "aura.manager.fast";
const K_APPROVAL = "aura.manager.approval";
const K_MODEL = "aura.hud.model";

function ls(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / disabled storage — chips just don't persist */
  }
}

function loadState(): HudComposerState {
  let model: SelectedModel | null = null;
  const raw = ls(K_MODEL);
  if (raw) {
    try {
      model = JSON.parse(raw) as SelectedModel;
    } catch {
      model = null;
    }
  }
  return {
    mode: (ls(K_MODE) as HudComposerMode) || "build",
    effort: (ls(K_EFFORT) as ReasoningEffort | null) ?? null,
    fast: ls(K_FAST) === "1",
    approval: (ls(K_APPROVAL) as ApprovalPolicy | null) ?? null,
    model,
  };
}

/** A model row is "selected" when its brain + wire id + 1M flag all match (the
 *  1M and non-1M rows share a wire id, so longContext disambiguates). */
function isModelSelected(
  sel: SelectedModel | null,
  brainId: string,
  modelId: string | null,
  longContext: boolean,
): boolean {
  return (
    !!sel &&
    sel.brainId === brainId &&
    sel.modelId === modelId &&
    sel.longContext === longContext
  );
}

export type HudComposer = {
  state: HudComposerState;
  setMode: (m: HudComposerMode) => void;
  setEffort: (e: ReasoningEffort | null) => void;
  setApproval: (a: ApprovalPolicy | null) => void;
  setModel: (m: SelectedModel | null) => void;
  toggleFast: () => void;
  /** Native-menu rows for one chip. */
  menuItems: (kind: HudMenuKind) => HudMenuRow[];
  /** Apply a native-menu pick to the matching chip. */
  applyPick: (kind: HudMenuKind, id: string) => void;
  /** The per-turn config a HUD send carries. */
  toConfig: () => HudComposerConfig;
  /** Chip labels for the toolbar. */
  labels: { mode: string; effort: string; approval: string; model: string };
};

/** Toolbar state for the HUD composer. Loads the brain/model catalog once on
 *  mount; everything else is local + persisted. */
export function useHudComposer(): HudComposer {
  const [state, setState] = useState<HudComposerState>(loadState);
  const [brains, setBrains] = useState<BrainChoice[]>([]);
  const catalogRef = useRef<ModelCatalog | null>(null);
  const brainsRef = useRef<BrainChoice[]>([]);
  brainsRef.current = brains;

  useEffect(() => {
    let live = true;
    void api
      .managerListBrains()
      .then((b) => {
        if (live) setBrains(b);
      })
      .catch(() => undefined);
    void api
      .agentModelsList(false)
      .then((c) => {
        catalogRef.current = c;
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const setMode = useCallback((mode: HudComposerMode) => {
    lsSet(K_MODE, mode);
    setState((s) => ({ ...s, mode }));
  }, []);
  const setEffort = useCallback((effort: ReasoningEffort | null) => {
    lsSet(K_EFFORT, effort);
    setState((s) => ({ ...s, effort }));
  }, []);
  const setApproval = useCallback((approval: ApprovalPolicy | null) => {
    lsSet(K_APPROVAL, approval);
    setState((s) => ({ ...s, approval }));
  }, []);
  const setModel = useCallback((model: SelectedModel | null) => {
    lsSet(K_MODEL, model ? JSON.stringify(model) : null);
    setState((s) => ({ ...s, model }));
  }, []);
  const toggleFast = useCallback(() => {
    setState((s) => {
      const fast = !s.fast;
      lsSet(K_FAST, fast ? "1" : null);
      return { ...s, fast };
    });
  }, []);

  const menuItems = useCallback(
    (kind: HudMenuKind): HudMenuRow[] => {
      if (kind === "mode")
        return MODE_OPTIONS.map((o) => ({
          id: o.value,
          label: o.label,
          checked: state.mode === o.value,
        }));
      if (kind === "effort")
        return EFFORT_OPTIONS.map((o) => ({
          id: o.value ?? "auto",
          label: o.label,
          checked: (state.effort ?? null) === o.value,
        }));
      if (kind === "approval")
        return APPROVAL_OPTIONS.map((o) => ({
          id: o.value ?? "default",
          label: o.label,
          checked: (state.approval ?? null) === o.value,
        }));
      // brain·model — Auto first, then one submenu per engine with its models.
      const rows: HudMenuRow[] = [
        { id: "auto", label: "Auto", checked: !state.model },
      ];
      for (const b of brains) {
        const models = catalogFor(b, catalogRef.current).map((m) => ({
          id: `m:${b.id}::${m.key}`,
          label: m.label,
          checked: isModelSelected(state.model, b.id, m.id, m.longContext ?? false),
        }));
        rows.push({ id: "", label: b.label, children: models });
      }
      return rows;
    },
    [state.mode, state.effort, state.approval, state.model, brains],
  );

  const applyPick = useCallback(
    (kind: HudMenuKind, id: string) => {
      if (kind === "mode") {
        setMode(id as HudComposerMode);
        return;
      }
      if (kind === "effort") {
        setEffort(id === "auto" ? null : (id as ReasoningEffort));
        return;
      }
      if (kind === "approval") {
        setApproval(id === "default" ? null : (id as ApprovalPolicy));
        return;
      }
      // brain
      if (id === "auto") {
        setModel(null);
        return;
      }
      if (id.startsWith("m:")) {
        const [brainId, key] = id.slice(2).split("::");
        const brain = brainsRef.current.find((b) => b.id === brainId);
        if (!brain) return;
        const model = catalogFor(brain, catalogRef.current).find((m) => m.key === key);
        if (!model) return;
        setModel(toSelectedModel(brain, model));
      }
    },
    [setMode, setEffort, setApproval, setModel],
  );

  const toConfig = useCallback(
    (): HudComposerConfig => ({
      mode: state.mode,
      effort: state.effort,
      fast: state.fast,
      approval: state.approval,
      model: state.model?.modelId ?? null,
      longContext: state.model?.longContext ?? false,
      brainId: state.model?.brainId ?? null,
    }),
    [state],
  );

  const labels = {
    mode: MODE_OPTIONS.find((o) => o.value === state.mode)?.label ?? "Build",
    effort: EFFORT_OPTIONS.find((o) => o.value === (state.effort ?? null))?.label ?? "Auto",
    approval:
      APPROVAL_OPTIONS.find((o) => o.value === (state.approval ?? null))?.label ?? "Default",
    model: state.model?.label ?? "Auto",
  };

  return {
    state,
    setMode,
    setEffort,
    setApproval,
    setModel,
    toggleFast,
    menuItems,
    applyPick,
    toConfig,
    labels,
  };
}

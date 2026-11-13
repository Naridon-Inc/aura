// The Aura chat's model picker: the shared picker, fed from every brain the
// chat can route a turn through.
//
// A pick sets the brain override for this session (so the choice persists
// with it) and lifts the model the next turn carries. Effort and Fast are the
// picker's own rows, because they share the model's scope: whichever model
// runs the next turn, that is how hard it runs. Picking a loadout slot's
// model (from the list or by its chord) also takes the effort that slot was
// given in Settings > Models, when it was given one.
//
// The rows are the models of the agents and keys this machine has set up —
// a brain that still wants a key is not offered. With none set up there is
// nothing to pick, and the picker becomes the way to set one up.
//
// A chat on one of the org's machines is the exception: it stays on that
// machine, so its rows are the models the agent there reported, and a pick
// changes the model, never the brain. Until that agent reports, a Claude
// machine lists the Claude Code models, so the picker isn't a bare "Default"
// while the agent starts (see `machineCatalog`).

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BrainChoice, type ReasoningEffort } from "../../../lib/api";
import { rowKey, toSelectedModel, type SelectedModel } from "../../../lib/modelCatalog";
import { loadoutEffortFor, loadoutSlotKey } from "../../../lib/modelLoadout";
import { PICK_MODEL_SLOT_EVENT, type PickModelSlotDetail } from "../../../lib/composerChords";
import {
  machineCatalog,
  machineEngine,
  machineModels,
  turnModel,
  type MachineModel,
} from "../../../lib/machineBrain";
import { toast } from "../../../lib/toast";
import { ModelPicker, type ModelOption, type ModelSelection } from "../../ui/model-picker";
import "../../ui/model-menu.css";
import { useLiveModelCatalog, useModelFavorites } from "./catalogHooks";
import { SetUpAgentButton } from "./SetUpAgentButton";
import {
  AUTO_MODEL_ID,
  catalogOptions,
  effortLabel,
  effortValue,
  isUnusable,
  reorderedLoadout,
  shownLoadout,
  type CatalogRow,
} from "./catalogOptions";

const NO_FAVORITES: string[] = [];

/** `/brain` in the composer opens this picker. */
export const OPEN_BRAIN_PICKER_EVENT = "aura:composer:open-brain-picker";

export function ManagerModelPicker({
  sessionId,
  value,
  onBrainChange,
  onModelChange,
  effort,
  fast,
  onEffortChange,
  onFastChange,
  disabled,
  machine = null,
}: {
  sessionId: string;
  /** The per-turn model, or null when following the active brain. */
  value: SelectedModel | null;
  onBrainChange: (choice: BrainChoice | null) => void;
  onModelChange: (model: SelectedModel | null) => void;
  effort: ReasoningEffort | null;
  fast: boolean;
  onEffortChange: (value: ReasoningEffort | null) => void;
  onFastChange: (value: boolean) => void;
  disabled?: boolean;
  /** The machine's agent, when this chat runs on one of the org's machines. */
  machine?: BrainChoice | null;
}) {
  const [open, setOpen] = useState(false);
  const [brains, setBrains] = useState<BrainChoice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [offered, setOffered] = useState<MachineModel[]>([]);
  // A Claude machine names its models from this laptop's catalog until its
  // agent reports; a Codex machine never reads it.
  const catalog = useLiveModelCatalog(!machine || machineEngine(machine) === "claude");
  const live = useMemo(
    () => (machine ? machineCatalog(machine, offered, catalog) : catalog),
    [machine, offered, catalog],
  );
  const loved = useModelFavorites();
  // A machine's rows are its own; the laptop's loadout neither shows nor
  // changes for them.
  const favorites = machine ? NO_FAVORITES : loved.favorites;
  const setFavorites = loved.setFavorites;
  const pickLock = useRef(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_BRAIN_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_BRAIN_PICKER_EVENT, onOpen);
  }, []);

  // Read on mount and on every open: the brain set can grow while the chat is
  // open (an endpoint added in Settings), and a read on open keeps the list
  // honest without polling.
  useEffect(() => {
    if (machine || (!open && brains.length > 0)) return;
    let cancelled = false;
    api
      .managerListBrains()
      .then((list) => {
        if (cancelled) return;
        setBrains(list);
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled && open)
          toast.danger("Could not load models", e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, brains.length, machine]);

  // The machine's models, read on mount and on every open: the agent reports
  // them once its conversation opens, which is usually after the first turn.
  const machineId = machine?.id ?? null;
  useEffect(() => {
    if (!machineId) return;
    let cancelled = false;
    machineModels(machineId)
      .then((list) => !cancelled && setOffered(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [machineId, open]);

  const usable = useMemo(
    () => (machine ? [machine] : brains.filter((b) => !isUnusable(b))),
    [brains, machine],
  );
  const empty = !machine && loaded && usable.length === 0;

  // While there is nothing to pick, look again whenever the window or the
  // composer takes focus — coming back from Settings or from a sign-in in the
  // browser — so the picker appears once an agent is set up.
  useEffect(() => {
    if (!empty || machine) return;
    let last = 0;
    let cancelled = false;
    const look = () => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      api
        .managerListBrains()
        .then((list) => !cancelled && setBrains(list))
        .catch(() => {});
    };
    window.addEventListener("focus", look);
    document.addEventListener("focusin", look);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", look);
      document.removeEventListener("focusin", look);
    };
  }, [empty, machine]);

  // Auto runs on the brain the app picks: the saved one, else the first agent
  // or key set up. Named after that brain, never after a brain that can't run.
  const active = brains.find((b) => b.active) ?? null;
  const autoBrain = machine ?? (active && !isUnusable(active) ? active : (usable[0] ?? null));
  const { options, rows, loadout } = useMemo(
    () =>
      catalogOptions({
        brains: usable,
        live,
        favorites,
        auto: { name: "Auto", provider: autoBrain?.label ?? "" },
        efforts: true,
        fast: true,
      }),
    [usable, live, favorites, autoBrain?.label],
  );
  // A model picked before this chat was on its machine isn't one of its own.
  const shown = turnModel(machine, value);

  // The selection's row. Until the brains have loaded it may have none, and
  // the trigger still names what the next turn runs.
  const selectedId = useMemo(() => {
    if (!shown) return AUTO_MODEL_ID;
    for (const [id, row] of rows)
      if (
        row.brain.id === shown.brainId &&
        row.model.id === shown.modelId &&
        !!row.model.longContext === shown.longContext
      )
        return id;
    return `selected:${shown.brainId}:${shown.modelId ?? ""}`;
  }, [rows, shown]);
  const models = useMemo<ModelOption[]>(
    () =>
      shown && !rows.has(selectedId)
        ? [...options, { id: selectedId, name: shown.label, provider: shown.family, efforts: options[0]?.efforts, fast: true }]
        : options,
    [options, rows, selectedId, shown],
  );

  async function pick(row: CatalogRow | null) {
    if (pickLock.current || (row && isUnusable(row.brain))) return;
    pickLock.current = true;
    try {
      // On a machine the brain stays the machine's agent, Auto included.
      const brain = machine ?? row?.brain ?? null;
      await api.managerSetBrainOverride(sessionId, brain?.id ?? null);
      onBrainChange(brain);
      onModelChange(row ? toSelectedModel(row.brain, row.model) : null);
      // A slot of the loadout brings the effort it was given in Settings.
      const key = row ? rowKey(row.brain.id, row.model) : null;
      if (key && latest.current.favorites.includes(key)) {
        const saved = loadoutEffortFor(key);
        if (saved !== undefined) onEffortChange(saved);
      }
    } catch (e) {
      // Keep the prior selection — the backend rejected this one.
      toast.danger("Could not switch model", e instanceof Error ? e.message : String(e));
    } finally {
      pickLock.current = false;
    }
  }

  // ⌘1…⌘5 pick that slot of the loadout without opening anything — but only
  // in the composer that holds the focus, since several chats can be mounted
  // and the chord changes one session's next turn.
  const latest = useRef({ favorites, rows, disabled });
  latest.current = { favorites, rows, disabled };
  useEffect(() => {
    const onSlot = (e: Event) => {
      const slot = (e as CustomEvent<PickModelSlotDetail>).detail?.slot;
      if (!slot || latest.current.disabled) return;
      const box = rootRef.current?.closest(".ui-composer-wrap");
      if (!box || !box.contains(document.activeElement)) return;
      const key = loadoutSlotKey(latest.current.favorites, slot);
      const row = key ? latest.current.rows.get(key) : undefined;
      if (!row || isUnusable(row.brain)) return;
      void pick(row);
      toast.info(`Model: ${row.model.label}`, undefined, { durationMs: 1500 });
    };
    window.addEventListener(PICK_MODEL_SLOT_EVENT, onSlot);
    return () => window.removeEventListener(PICK_MODEL_SLOT_EVENT, onSlot);
    // `pick` closes over props that are stable for this picker's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selection: ModelSelection = { model: selectedId, effort: effortLabel(effort), fast };
  const change = (next: ModelSelection) => {
    if (next.model !== selectedId) {
      if (next.model === AUTO_MODEL_ID) void pick(null);
      else {
        const row = rows.get(next.model);
        if (row) void pick(row);
      }
      return;
    }
    if (effortValue(next.effort) !== effort) onEffortChange(effortValue(next.effort));
    if (!!next.fast !== fast) onFastChange(!!next.fast);
  };

  if (empty)
    return (
      <span ref={rootRef} data-tour="brain" className="contents">
        <SetUpAgentButton disabled={disabled} />
      </span>
    );

  return (
    <span ref={rootRef} data-tour="brain" className="contents">
      <ModelPicker
        models={models}
        value={selection}
        onChange={change}
        visibleIds={loadout.length ? [AUTO_MODEL_ID, ...loadout] : undefined}
        onReorder={machine ? undefined : (ids) => setFavorites(reorderedLoadout(favorites, ids))}
        onVisibleChange={
          machine ? undefined : (ids) => setFavorites(shownLoadout(favorites, ids, rows))
        }
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
      />
    </span>
  );
}

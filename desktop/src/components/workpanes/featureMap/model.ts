// Feature Map — the words layer.
//
// Pure functions that turn the two payloads (features, flows) into what a
// person sees: areas holding features holding flows, a status per flow that
// is derived only from what the graph and the goals ledger actually said,
// and the copy for time, place and status. No React, no DOM, so every rule
// here is unit-testable and the view stays a thin renderer.
//
// Audience: non-engineers. Nothing below says "node", "edge", "symbol" or
// "canonical" to the reader — those words stay in the type names.

import type {
  KgFeature,
  KgFeatureMap,
  KgFlow,
  KgFlowMap,
  KgFlowWhere,
} from "../../../lib/api";

/** How a flow is doing, in the order the map ranks them. `proved` and
 *  `gap` come from a real prover run recorded in the goals ledger;
 *  `traced` and `seen` come from how the path was found. */
export type FlowStatus = "proved" | "gap" | "traced" | "seen";

export function flowStatus(f: KgFlow): FlowStatus {
  const v = f.goal?.verdict;
  if (v === "partial" || v === "not_wired") return "gap";
  if (v === "verified") return "proved";
  return f.verdict === "traced" ? "traced" : "seen";
}

export type FeatureNode = {
  id: string;
  name: string;
  area: string;
  /** Raw directory fragment the pieces view can search. */
  path: string;
  symbols: number;
  files: number;
  blurb: string | null;
  /** Entry points found vs. shown — "3 of 9 flows" on the block. */
  entries: number;
  flows: KgFlow[];
};

export type AreaNode = {
  id: string;
  name: string;
  symbols: number;
  features: FeatureNode[];
};

export type MapModel = {
  areas: AreaNode[];
  featureById: Map<string, FeatureNode>;
  flowById: Map<string, KgFlow>;
  /** Feature id → area name, for "crosses into …" copy. */
  areaOf: Map<string, string>;
};

/** Group features by area (largest first) and hang each feature's flows
 *  under it. Flows keep the backend's order — it already ranked entries. */
export function buildModel(
  features: KgFeatureMap,
  flows: KgFlowMap | null,
): MapModel {
  const flowsByFeature = new Map<string, KgFlow[]>();
  const flowById = new Map<string, KgFlow>();
  for (const f of flows?.flows ?? []) {
    const list = flowsByFeature.get(f.feature) ?? [];
    list.push(f);
    flowsByFeature.set(f.feature, list);
    flowById.set(f.id, f);
  }
  const summary = new Map(
    (flows?.features ?? []).map((s) => [s.feature, s] as const),
  );

  const areas = new Map<string, AreaNode>();
  const featureById = new Map<string, FeatureNode>();
  const areaOf = new Map<string, string>();
  for (const feat of features.features) {
    const node = toFeatureNode(feat, flowsByFeature, summary);
    featureById.set(node.id, node);
    areaOf.set(node.id, node.area);
    const area = areas.get(feat.area) ?? {
      id: feat.area,
      name: feat.area,
      symbols: 0,
      features: [],
    };
    area.symbols += feat.symbols;
    area.features.push(node);
    areas.set(feat.area, area);
  }
  const ordered = [...areas.values()].sort((a, b) => b.symbols - a.symbols);
  for (const a of ordered) a.features.sort((x, y) => y.symbols - x.symbols);
  return { areas: ordered, featureById, flowById, areaOf };
}

function toFeatureNode(
  feat: KgFeature,
  flowsByFeature: Map<string, KgFlow[]>,
  summary: Map<string, { entries: number; blurb: string | null }>,
): FeatureNode {
  const s = summary.get(feat.id);
  return {
    id: feat.id,
    name: feat.name,
    area: feat.area,
    path: feat.path,
    symbols: feat.symbols,
    files: feat.files,
    blurb: s?.blurb ?? null,
    entries: s?.entries ?? 0,
    flows: flowsByFeature.get(feat.id) ?? [],
  };
}

/** Where a step runs, said the way a person would. `other` falls back to
 *  the area the code lives in, so the reader is never told "other". */
export function whereLabel(where: KgFlowWhere, area: string): string {
  switch (where) {
    case "engine":
      return "in the app's engine";
    case "app":
      return "in the app window";
    case "server":
      return "on the server";
    case "browser":
      return "in the browser";
    case "cli":
      return "in the terminal";
    case "mobile":
      return "on the phone";
    case "shared":
      return "in shared code";
    default:
      return area ? `in ${area}` : "in the code";
  }
}

/** Short badge for the trigger box — what set the flow off. */
export function triggerBadge(kind: KgFlow["trigger"]["kind"]): string {
  switch (kind) {
    case "you":
      return "You";
    case "agent":
      return "Agent";
    case "app":
      return "App";
    case "cli":
      return "Terminal";
    case "server":
      return "Server";
    case "start":
      return "Startup";
    default:
      return "Code";
  }
}

export function outcomeLabel(kind: KgFlow["outcome"]["kind"]): string {
  switch (kind) {
    case "save":
      return "Saved";
    case "see":
      return "Shown to you";
    default:
      return "Ends here";
  }
}

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "12 min ago", "3 h ago", "yesterday", "6 days ago", or
 *  the date once it is older than the change window makes interesting. */
export function relativeTime(secs: number, now: number): string {
  if (!secs) return "at an unknown time";
  const d = Math.max(0, now - secs);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const date = new Date(secs * 1000);
  return `on ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** The one line under a flow's name that says how much to trust it. Every
 *  claim traces to a field: proved/gap to a prover run, traced to the
 *  resolved call edges, seen to the missing checkpoint identity. */
export function statusCopy(f: KgFlow, builtAt: number, now: number): string {
  const s = flowStatus(f);
  const g = f.goal;
  if (s === "proved" && g) {
    return `proved end to end · ${g.ok} of ${g.total} checks · ${relativeTime(g.at, now)}`;
  }
  if (s === "gap" && g) {
    return `stops short · ${g.ok} of ${g.total} checks passed · ${relativeTime(g.at, now)}`;
  }
  if (s === "seen") {
    return "partly guessed · some steps are not in the last checkpoint";
  }
  return `traced from the code · read ${relativeTime(builtAt, now)}`;
}

export type NeedsALook = {
  gaps: KgFlow[];
  /** Newest change first. */
  changed: KgFlow[];
};

/** What the "Needs a look" menu lists: flows a prover run said stop
 *  short, and flows whose files were touched inside the change window. */
export function needsALook(
  flows: KgFlow[],
  now: number,
  windowDays: number,
): NeedsALook {
  const cutoff = now - windowDays * DAY;
  const gaps = flows.filter((f) => flowStatus(f) === "gap");
  const changed = flows
    .filter((f) => f.changed && f.changed.when >= cutoff)
    .sort((a, b) => (b.changed?.when ?? 0) - (a.changed?.when ?? 0));
  return { gaps, changed };
}

/** Header tally, spelled out. Only non-zero facts get a chip so the bar
 *  does not fill with "0 proved" on a project that never ran the prover. */
export type TallyChip = {
  key: "flows" | "gaps" | "proved" | "changed";
  label: string;
  tone: "neutral" | "red" | "green" | "amber";
};

export function tallyChips(
  flows: KgFlowMap | null,
): TallyChip[] {
  if (!flows) return [];
  const t = flows.tally;
  const n = flows.flows.length;
  const out: TallyChip[] = [
    { key: "flows", label: `${n} ${n === 1 ? "flow" : "flows"}`, tone: "neutral" },
  ];
  if (t.gaps > 0) {
    out.push({ key: "gaps", label: `${t.gaps} stop short`, tone: "red" });
  }
  if (t.proved > 0) {
    out.push({ key: "proved", label: `${t.proved} proved`, tone: "green" });
  }
  if (t.changed > 0) {
    out.push({
      key: "changed",
      label: `${t.changed} changed in ${flows.change_window_days} days`,
      tone: "amber",
    });
  }
  return out;
}

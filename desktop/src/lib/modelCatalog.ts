// Exact-model catalog for the composer model picker (#251). The picker
// groups by the brains the user actually has (`manager_list_brains`) and,
// under each, lists that family's concrete models — Opus 4.8, Sonnet 4.6,
// GPT-5.5 — instead of a bare CLI/agent name. Selecting a row is a REAL
// per-turn dispatch override (threaded through `brain_chat_turn`'s
// `model` + `long_context`, and the CLI `--model` flag), not cosmetic.
//
// Cross-agent by construction: the same row picks both the brain it routes
// through AND the model that brain runs, so it works for the native Aura
// brains and any CLI agent (Claude Code, Codex, Gemini CLI, Kimi, …).

import type { BrainChoice, ModelCatalog, ModelInfo } from "./api";

/** Vendor family a brain belongs to — drives which model list it shows. */
export type ModelFamily =
  | "anthropic"
  | "openai"
  | "gemini"
  | "xai"
  | "kimi"
  | "antigravity"
  | "generic"
  | "custom";

/** One concrete model row in the picker. */
export type CatalogModel = {
  /** Stable per-row key, unique within a family — favorites, hotkeys and
   *  selected-state compare on this (a wire id alone isn't unique because
   *  the 1M and non-1M rows share the same `id`). */
  key: string;
  /** Wire model id passed as `ChatRequest.model` / CLI `--model`. `null`
   *  → leave the brain on its own configured default (used for families
   *  whose exact model ids we don't enumerate, e.g. a custom endpoint). */
  id: string | null;
  /** Human label shown in the row and the footer chip. */
  label: string;
  /** Anthropic 1M-context variant → `ChatRequest.long_context`. */
  longContext?: boolean;
  /** Recently-shipped → NEW pill. */
  isNew?: boolean;
  /** Vendor display name from the Aura catalog ("Anthropic" / "Google"). */
  vendor?: string;
  /** Icon slug for `AgentIcon` from the Aura catalog ("claude" / "gemini"
   *  / "codex"). The row prefers this over re-deriving from the brain. */
  brand?: string;
  /** Brand name shown next to the model label ("Claude" / "Gemini" / "GPT"). */
  brandName?: string;
};

/** The model the user picked, lifted to the composer/send path. Carries
 *  the brain it dispatches through (also the footer-chip glyph) plus the
 *  wire fields the backend needs. */
export type SelectedModel = {
  /** Brain (override) id this model routes through. */
  brainId: string;
  /** `ChatRequest.model` — `null` keeps the brain's default. */
  modelId: string | null;
  /** `ChatRequest.long_context` — the picker's "1M" rows. */
  longContext: boolean;
  /** Footer-chip label, e.g. "Opus 4.8". */
  label: string;
  /** Family, for the chip glyph + grouping. */
  family: ModelFamily;
};

const ANTHROPIC: CatalogModel[] = [
  { key: "fable-5", id: "claude-fable-5", label: "Fable 5", isNew: true },
  { key: "sonnet-5", id: "claude-sonnet-5", label: "Sonnet 5", isNew: true },
  { key: "opus-4-8-1m", id: "claude-opus-4-8", label: "Opus 4.8 1M", longContext: true, isNew: true },
  { key: "opus-4-8", id: "claude-opus-4-8", label: "Opus 4.8", isNew: true },
  { key: "opus-4-7-1m", id: "claude-opus-4-7", label: "Opus 4.7 1M", longContext: true },
  { key: "opus-4-7", id: "claude-opus-4-7", label: "Opus 4.7" },
  { key: "opus-4-6-1m", id: "claude-opus-4-6", label: "Opus 4.6 1M", longContext: true },
  { key: "sonnet-4-6-1m", id: "claude-sonnet-4-6", label: "Sonnet 4.6 1M", longContext: true },
  { key: "sonnet-4-6", id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { key: "haiku-4-5", id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

// GPT-5.6 ships as three named tiers (verified against codex's
// models_cache.json): Sol = frontier, Terra = balanced, Luna = fast/cheap.
// codex forwards each via `-c model=<id>`; there is no bare `gpt-5.6`.
const OPENAI: CatalogModel[] = [
  { key: "gpt-5-6-sol", id: "gpt-5.6-sol", label: "GPT-5.6 Sol", isNew: true },
  { key: "gpt-5-6-terra", id: "gpt-5.6-terra", label: "GPT-5.6 Terra", isNew: true },
  { key: "gpt-5-6-luna", id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isNew: true },
  { key: "gpt-5-5", id: "gpt-5.5", label: "GPT-5.5" },
  { key: "gpt-5-4", id: "gpt-5.4", label: "GPT-5.4" },
];

// Ids verified against the installed `gemini` CLI (0.45.0 bundles the
// gemini-3 line). Newest first; `-preview` is the CLI's own id for the
// gemini-3 models, accepted by `gemini -m`.
const GEMINI: CatalogModel[] = [
  { key: "gemini-3-pro", id: "gemini-3-pro-preview", label: "Gemini 3 Pro", isNew: true },
  { key: "gemini-3-flash", id: "gemini-3-flash-preview", label: "Gemini 3 Flash", isNew: true },
  { key: "gemini-2-5-pro", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { key: "gemini-2-5-flash", id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

const XAI: CatalogModel[] = [
  { key: "grok-4-5", id: "grok-4.5", label: "Grok 4.5", isNew: true },
];

// The installed `kimi` CLI is the coding product (scope `kimi-code`); its
// config exposes exactly one selectable model alias, `kimi-code/kimi-for-coding`
// (display "Kimi-k2.6"), which the managed endpoint routes to the current
// coding model. No separate `kimi-3`/`k3` id is accepted by this CLI, so we
// list the one real id rather than invent a menu.
// Kimi (Moonshot) coding CLI. ids are the model-table keys from the CLI's own
// `~/.kimi-code/config.toml` and are forwarded verbatim as `kimi -m <id>`.
// K3 is the current default; the K2.7 pair are the prior line. Newest first.
const KIMI: CatalogModel[] = [
  { key: "kimi-k3", id: "kimi-code/k3", label: "K3", isNew: true },
  { key: "kimi-k2-7-coding", id: "kimi-code/kimi-for-coding", label: "K2.7 Coding" },
  { key: "kimi-k2-7-coding-highspeed", id: "kimi-code/kimi-for-coding-highspeed", label: "K2.7 Coding Highspeed" },
];

// Antigravity (`agy`) multiplexes several backends behind one agent. `agy
// models` bakes the reasoning tier into each id (…-high/-medium/-low), but we
// show ONE row per base model and let the shared Level chip pick the tier —
// the backend (`aura-agents/antigravity.rs`) re-attaches it as `<base>-<tier>`,
// clamped to the tiers that base offers. So ids here are the tier-less bases
// (`gemini-3.6-flash`); ids with no reasoning tier (`claude-sonnet-4-6`,
// `claude-opus-4-6-thinking`) stand alone. Newest line (3.6 Flash) first.
const ANTIGRAVITY: CatalogModel[] = [
  { key: "agy-gemini-3-6-flash", id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", isNew: true },
  { key: "agy-gemini-3-5-flash", id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { key: "agy-gemini-3-1-pro", id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { key: "agy-claude-sonnet-4-6", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { key: "agy-claude-opus-4-6-thinking", id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 · Thinking" },
  { key: "agy-gpt-oss-120b", id: "gpt-oss-120b", label: "GPT-OSS 120B" },
];

// Families whose exact model ids we don't enumerate get a single "Default"
// row (`id: null`) — honest: it routes through the brain on whatever model
// that agent's CLI/endpoint is configured to use. No invented model ids.
const DEFAULT_ONLY: CatalogModel[] = [
  { key: "default", id: null, label: "Default" },
];

/** Map a brain to its vendor family. Native brains carry the family in
 *  their `kind`; CLI wrappers carry it in the `provider_id` suffix
 *  (`cli_wrapper:claude` → anthropic); `openai_compat:*` → custom. */
export function familyOf(brain: BrainChoice): ModelFamily {
  switch (brain.kind) {
    case "anthropic_native":
    case "aura_pro":
      return "anthropic";
    case "openai_native":
      return "openai";
    case "gemini_native":
      return "gemini";
    case "openai_compat":
      if (/\b(?:xai|grok)\b/i.test(`${brain.id} ${brain.label}`)) return "xai";
      return "custom";
    case "cli_wrapper": {
      // The Claude Code CLI carries the suffix `claude_code` (its aura-agents
      // registry id is just `claude`), so match both — otherwise it falls to
      // generic and shows only "Default" instead of the real Claude models.
      const suffix = brain.id.split(":")[1] ?? "";
      if (suffix === "claude" || suffix === "claude_code") return "anthropic";
      if (suffix === "codex") return "openai";
      if (suffix === "gemini") return "gemini";
      if (suffix === "kimi") return "kimi";
      // Antigravity's registry id is `antigravity`; `agy` is the bin alias —
      // match both so its 11-model list shows instead of a bare "Default".
      if (suffix === "antigravity" || suffix === "agy") return "antigravity";
      return "generic";
    }
    default:
      return "generic";
  }
}

/** The curated static fallback rows for a family — the absolute-last
 *  offline default, only hit when the backend (remote + embedded Aura
 *  catalog) returned nothing for this family. The family brand (icon slug +
 *  name) is stamped on so even this path shows the right mark and label. */
function staticCatalog(family: ModelFamily): CatalogModel[] {
  const fb = familyBrand(family);
  const rows = (() => {
    switch (family) {
      case "anthropic":
        return ANTHROPIC;
      case "openai":
        return OPENAI;
      case "gemini":
        return GEMINI;
      case "xai":
        return XAI;
      case "kimi":
        return KIMI;
      case "antigravity":
        return ANTIGRAVITY;
      default:
        return DEFAULT_ONLY;
    }
  })();
  return rows.map((m) => ({ ...m, ...fb }));
}

/** Only the Anthropic Claude-4+ opus/sonnet lines serve a 1M-context beta —
 *  the picker offers a separate "… 1M" row for those (→ `long_context`).
 *  Claude-3.x (e.g. `claude-3-5-sonnet`) does NOT, so the major must be ≥4. */
function isLongContextCapable(family: ModelFamily, id: string): boolean {
  if (family !== "anthropic") return false;
  const m = id.match(/(?:opus|sonnet)-(\d+)/);
  // Generation-5 models have a 1M window by default rather than a separate
  // beta variant, so they should appear once in the picker.
  return !!m && Number(m[1]) >= 4 && Number(m[1]) < 5;
}

/** Tidy a provider display name for the compact row/chip ("Claude Opus 4.8"
 *  → "Opus 4.8"); leave non-Anthropic labels as the provider gives them. */
function tidyLabel(family: ModelFamily, label: string): string {
  if (family === "anthropic") return label.replace(/^Claude\s+/i, "");
  return label;
}

/** Map the backend ModelCatalog's rows for a family into picker rows.
 *
 *  Rows sourced from the Aura catalog arrive fully shaped — they already
 *  carry their stable `key`, the `longContext`/`isNew` flags, and the brand
 *  metadata (vendor/brand/brandName) — so we pass those straight through. A
 *  BYOK-appended row (one the provider account has but the curated catalog
 *  doesn't) lacks that metadata, so it's expanded the legacy way: tidy the
 *  label, split Anthropic opus/sonnet into a 1M + base row, and stamp the
 *  family's brand so it still shows the right mark and name. */
function mapLiveModels(
  family: ModelFamily,
  models: ModelInfo[],
): CatalogModel[] {
  const out: CatalogModel[] = [];
  models.forEach((m, i) => {
    // Curated Aura-catalog row — already shaped, keep it verbatim.
    if (m.key) {
      out.push({
        key: m.key,
        id: m.id || null,
        label: m.label,
        longContext: m.longContext ?? undefined,
        isNew: m.isNew ?? undefined,
        vendor: m.vendor ?? undefined,
        brand: m.brand ?? undefined,
        brandName: m.brandName ?? undefined,
      });
      return;
    }
    // Bare BYOK-appended row — derive its shape and stamp the family brand.
    const isNew = i === 0;
    const label = tidyLabel(family, m.label);
    const fb = familyBrand(family);
    if (isLongContextCapable(family, m.id)) {
      out.push({ key: `${m.id}-1m`, id: m.id, label: `${label} 1M`, longContext: true, isNew, ...fb });
      out.push({ key: m.id, id: m.id, label, isNew, ...fb });
    } else {
      out.push({ key: m.id, id: m.id, label, isNew, ...fb });
    }
  });
  return out;
}

/** Brand metadata for a family — the icon slug + brand name a row wears when
 *  the catalog didn't carry its own (BYOK extras, or the static fallback). */
function familyBrand(
  family: ModelFamily,
): { brand?: string; brandName?: string } {
  switch (family) {
    case "anthropic":
      return { brand: "claude", brandName: "Claude" };
    case "openai":
      return { brand: "codex", brandName: "GPT" };
    case "gemini":
      return { brand: "gemini", brandName: "Gemini" };
    case "xai":
      return { brand: "xai", brandName: "Grok" };
    case "kimi":
      return { brand: "kimi", brandName: "Kimi" };
    case "antigravity":
      return { brand: "antigravity", brandName: "Antigravity" };
    default:
      return {};
  }
}

/** The brand mark a model ROW should wear — keyed off the model's vendor
 *  family, NOT the brain it routes through. So an Opus row shows the Claude
 *  mark even under "Aura Pro", a GPT row shows the OpenAI mark, etc. — the
 *  way Conductor brands each row by who actually makes the model. Generic /
 *  custom families fall back to the brain's own mark. `AgentIcon` resolves
 *  these ids to the official vendor SVGs. Prefer the brand the Aura catalog
 *  stamped on the model; fall back to the family mark so an offline/static
 *  row still shows the right vendor. */
export function modelBrandId(
  family: ModelFamily,
  brainId: string,
  model?: CatalogModel,
): string {
  if (model?.brand) return model.brand;
  switch (family) {
    case "anthropic":
      return "claude";
    case "openai":
      return "codex";
    case "gemini":
      return "gemini";
    case "xai":
      return "xai";
    case "kimi":
      return "kimi";
    case "antigravity":
      return "antigravity";
    default:
      return brainId;
  }
}

/** The plain-language brand name shown next to a model label ("Claude",
 *  "Gemini", "GPT"). Prefers the metadata the Aura catalog put on the model;
 *  falls back to a family→name map when a row carries none (offline static /
 *  generic). Returns "" for families we don't brand (custom endpoints). */
export function modelBrandName(family: ModelFamily, model: CatalogModel): string {
  if (model.brandName) return model.brandName;
  switch (family) {
    case "anthropic":
      return "Claude";
    case "openai":
      return "GPT";
    case "gemini":
      return "Gemini";
    case "xai":
      return "Grok";
    case "kimi":
      return "Kimi";
    case "antigravity":
      return "Antigravity";
    default:
      return "";
  }
}

/** The concrete model rows to show under a given brain. When a live catalog
 *  (from {@link api.agentModelsList}) carries this brain's family, those
 *  provider-sourced rows win; otherwise the curated static list is used so
 *  the picker still works offline / before the fetch resolves. */
export function catalogFor(brain: BrainChoice, live?: ModelCatalog | null): CatalogModel[] {
  const family = familyOf(brain);
  const liveModels = live?.families?.[family];
  if (liveModels && liveModels.length > 0) {
    return mapLiveModels(family, liveModels);
  }
  return staticCatalog(family);
}

/** Compose the per-(brain,model) favorite/selection key. Independent of
 *  display order so it survives catalog edits. */
export function rowKey(brainId: string, model: CatalogModel): string {
  return `${brainId}::${model.key}`;
}

/** Build the lifted {@link SelectedModel} for a chosen row. */
export function toSelectedModel(brain: BrainChoice, model: CatalogModel): SelectedModel {
  return {
    brainId: brain.id,
    modelId: model.id,
    longContext: !!model.longContext,
    label: model.label,
    family: familyOf(brain),
  };
}

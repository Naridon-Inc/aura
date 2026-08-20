// Settings → Brain pane, and the two provider forms behind it.
//
// The Brain picker — replaces the old "set ANTHROPIC_API_KEY in env"
// flow. Each Brain impl compiled into the build appears here with a
// radio selector + an API-key field (when required). Keys land in the
// OS keychain via `brain_keychain_set` — they never round-trip to the
// frontend after the first save.
//
// Also here: the custom `openai_compat:<slug>` provider form, the
// cloud-singleton form (Bedrock / Vertex), and the Aura Pro row —
// every route by which a question reaches a model, in one file.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  api,
  isAuraProQuotaError,
  type AuraProQuota,
  type AuraProSignInState,
  type BrainDescriptor,
} from "../../lib/api";
import { AgentIcon } from "../agent/AgentIcon";
import { PaneIntro, Section } from "../settings/kit";
import { compactNumber } from "../../lib/compactNumber";
import { askConfirm } from "../ui/ask";

function brainBrandSlug(providerId: string): string {
  const id = providerId.toLowerCase();
  // `bedrock` and `vertex` are Claude and Gemini behind someone else's
  // billing, and they matched no branch here — so the slug fell through to
  // the raw provider id, AgentIcon had no art under that name, and the row
  // drew its own label as three lines of wrapped text where the glyph goes.
  if (id.includes("bedrock") || id.includes("vertex")) return "claude";
  if (id.includes("anthropic") || id.includes("claude")) return "claude";
  if (id.includes("gemini") || id.includes("google")) return "gemini";
  if (id.includes("openai_compat") || id.includes("openai-compat")) return "openai-compat";
  if (id.includes("openai") || id.includes("codex")) return "codex";
  if (id.includes("cursor")) return "cursor";
  if (id.includes("kimi") || id.includes("moonshot")) return "kimi";
  if (id.includes("aura")) return "aura-manager";
  return providerId;
}

/** Catalog family whose live model list this key unlocks, or `null` when
 *  the provider has no `/models` endpoint behind `agent_models_list`
 *  (CLI wrappers, custom endpoints, the cloud singletons) — those we save
 *  without claiming to have verified. */
function keyFamily(providerId: string): string | null {
  if (providerId === "gemini_native") return "gemini";
  if (providerId === "anthropic_native") return "anthropic";
  if (providerId === "openai_native") return "openai";
  // OpenRouter is a real catalog family now (agent_models_list fetches its
  // whole model list + pricing), so saving its key can report the count and
  // populate the picker like a first-party provider — not the one hardcoded
  // default the openai_compat preset used to carry.
  if (providerId === "openai_compat:openrouter") return "openrouter";
  return null;
}

export function BrainTab() {
  const [descriptors, setDescriptors] = useState<BrainDescriptor[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The rows stopped printing `cli_wrapper:claude_code` beside "Claude Code
  // (CLI)"; the messages and confirms below used to say it too.
  const brainName = useCallback(
    (providerId: string) =>
      descriptors.find((d) => d.provider_id === providerId)?.display_name ??
      providerId,
    [descriptors],
  );

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [ds, settings] = await Promise.all([
        api.brainListDescriptors(),
        api.brainGetSettings(),
      ]);
      setDescriptors(ds);
      setActive(settings.active_provider_id ?? null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pick(providerId: string) {
    setBusy(providerId);
    setMsg(null);
    setErr(null);
    try {
      await api.brainSetActive(providerId);
      setActive(providerId);
      setMsg(`Aura now thinks with ${brainName(providerId)}.`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveKey(providerId: string) {
    const draft = keyDrafts[providerId];
    if (!draft.trim()) return;
    setBusy(providerId);
    setMsg(null);
    setErr(null);
    try {
      await api.brainKeychainSet(providerId, draft);
      setKeyDrafts((d) => ({ ...d, [providerId]: "" }));
      await load();
      // The key decides which models this brain can serve, so ask the
      // provider now instead of letting the picker keep yesterday's answer.
      // Saving drops the 24h catalog cache backend-side; this forced fetch
      // refills it, and turns a rejected key into a sentence here rather
      // than a model list that quietly stays short.
      const family = keyFamily(providerId);
      if (!family) {
        setMsg(`Saved the API key for ${brainName(providerId)}.`);
        return;
      }
      try {
        const cat = await api.agentModelsList(true);
        const rejected = cat.errors?.[family];
        const count = cat.families?.[family]?.length ?? 0;
        if (rejected) {
          setErr(
            `Saved the key, but ${brainName(providerId)} wouldn't accept it: ${rejected}`,
          );
        } else {
          setMsg(
            `Saved the API key for ${brainName(providerId)} · ${count} model${
              count === 1 ? "" : "s"
            } available in the picker.`,
          );
        }
      } catch {
        // Offline: the key is stored, we just can't confirm it right now.
        setMsg(`Saved the API key for ${brainName(providerId)}.`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function forgetKey(providerId: string) {
    if (
      !(await askConfirm({
        title: `Forget the stored API key for ${brainName(providerId)}?`,
        body: "Aura stops using it and removes it from this machine's keychain.",
        confirmLabel: "Forget key",
        tone: "danger",
      }))
    )
      return;
    setBusy(providerId);
    setMsg(null);
    setErr(null);
    try {
      await api.brainKeychainDelete(providerId);
      setMsg(`Forgot the API key for ${brainName(providerId)}.`);
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Custom `openai_compat:<slug>` endpoints (Azure, OpenRouter, a local
  // vLLM, …) are the only removable brains — the compiled-in ones stay.
  async function removeProvider(providerId: string) {
    if (
      !(await askConfirm({
        title: `Remove ${brainName(providerId)}?`,
        body: "Its endpoint and its key are both forgotten.",
        confirmLabel: "Remove",
        tone: "danger",
      }))
    )
      return;
    setBusy(providerId);
    setMsg(null);
    setErr(null);
    try {
      await api.brainRemoveProvider(providerId);
      setMsg(`Removed ${brainName(providerId)}.`);
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PaneIntro text="Which model Aura thinks with. Aura Pro needs nothing set up; the rest take an API key, and the ones marked (CLI) reuse the login you already have on this machine." />
      <Section title="Available brains">
        {err && (
          <div className="text-sm text-red mb-2" role="alert">
            {err}
          </div>
        )}
        {msg && (
          <div className="text-sm text-text-3 mb-2">{msg}</div>
        )}
        {descriptors.length === 0 ? (
          <div className="text-sm text-text-4 italic">
            No brains compiled into this build. Rebuild with at least one
            of: <code>brain_anthropic_native</code>,{" "}
            <code>brain_cli_wrapper</code>, <code>brain_openai_native</code>,
            {" "}<code>brain_gemini_native</code>,{" "}
            <code>brain_openai_compat</code>.
          </div>
        ) : (
          /* Ten bordered, rounded cards stacked down the pane, each one a box
             around a single line of text — a wall, to pick one thing from.
             The app draws a list of things you choose between as hairline-
             divided rows, so this does too. And the selection was marked
             three times over: a native radio (the one unstyled form control
             left in the product, so it came up in the OS's blue while the
             card it sat in was tinted our green), an accent border, and a
             fill. The mark is the one the rail, the Pages tree and the
             conversation tabs use — the accent tint, on the row. */
          <div
            className="divide-y divide-line-soft"
            role="radiogroup"
            aria-label="Available brains"
          >
            {descriptors.map((d) => {
              const isActive = active === d.provider_id;
              const draft = keyDrafts[d.provider_id] ?? "";
              const isAuraPro = d.provider_id === "aura_pro";
              const removable = d.provider_id.startsWith("openai_compat:");
              // Whether a key is stored is a fact about the row; the field
              // for typing one belongs to the brain you have chosen. Two
              // rows used to hold an open, empty password box and a dead
              // Save button while you were reading past them.
              const keyNote = !d.requires_api_key
                ? null
                : d.has_api_key
                  ? "Key saved"
                  : "Needs an API key";
              return (
                <div
                  key={d.provider_id}
                  className={isActive ? "row-selected" : undefined}
                >
                  <div className="flex items-start">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      onClick={() => void pick(d.provider_id)}
                      disabled={busy === d.provider_id}
                      title={d.provider_id}
                      className="flex min-w-0 flex-1 items-start gap-2.5 px-2 py-2 text-left transition-colors hover:bg-state-hover disabled:opacity-50"
                    >
                      <span className="mt-px shrink-0">
                        <AgentIcon
                          agentId={brainBrandSlug(d.provider_id)}
                          label={d.display_name}
                          size={16}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span
                            className={`text-base font-medium ${
                              isActive ? "text-accent" : "text-text-1"
                            }`}
                          >
                            {d.display_name}
                          </span>
                          {keyNote && (
                            <span className="text-xs text-text-4">{keyNote}</span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-3">
                          {d.blurb}
                        </span>
                      </span>
                    </button>
                    {removable && (
                      <button
                        type="button"
                        onClick={() => void removeProvider(d.provider_id)}
                        disabled={busy === d.provider_id}
                        className="mr-1 mt-2 shrink-0 rounded p-1 text-text-4 transition-colors hover:bg-state-hover hover:text-red disabled:opacity-40"
                        title={`Remove ${d.display_name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  {isActive && (isAuraPro || d.requires_api_key) && (
                    <div className="pb-2.5 pl-[34px] pr-2 text-text-2">
                      {isAuraPro && <AuraProRow />}
                      {d.requires_api_key && (
                        <div className="mt-1 flex items-center gap-2">
                          <Input
                            type="password"
                            placeholder={
                              d.has_api_key
                                ? "Replace stored API key…"
                                : "API key"
                            }
                            value={draft}
                            onChange={(e) =>
                              setKeyDrafts((s) => ({
                                ...s,
                                [d.provider_id]: e.target.value,
                              }))
                            }
                            className="h-7 text-xs flex-1"
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!draft || busy === d.provider_id}
                            onClick={() => void saveKey(d.provider_id)}
                          >
                            Save
                          </Button>
                          {d.has_api_key && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy === d.provider_id}
                              onClick={() => void forgetKey(d.provider_id)}
                              title="Remove from OS keychain"
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <CloudBrainForm descriptors={descriptors} onSaved={() => void load()} />
      <CustomProviderForm onAdded={() => void load()} />
    </>
  );
}

// ── Cloud & custom providers (openai_compat:<slug>) ───────────────────
//
// Adds any OpenAI-compatible endpoint as a first-class brain via
// `brain_upsert_provider`. Presets cover the common hosted routers plus
// Azure OpenAI, which needs the `api-key:` header + an `api-version`
// query param — both carried by the openai_compat AuthStyle/query plumbing
// so the form just flips two knobs. New providers land in the "Available
// brains" list above (radio-select + key field), and carry a Remove
// affordance since — unlike the compiled-in brains — they're user state.

const AZURE_API_VERSION_DEFAULT = "2024-08-01-preview";

type CustomProviderPreset = {
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  needs_key: boolean;
  /** Azure authenticates with `api-key:` rather than Bearer. */
  auth_style?: "api_key";
  /** Azure requires an `api-version` query param on every request. */
  needs_api_version?: boolean;
  hint: string;
};

const CUSTOM_PROVIDER_PRESETS: CustomProviderPreset[] = [
  {
    id: "azure",
    label: "Azure OpenAI",
    base_url:
      "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
    default_model: "gpt-4o",
    needs_key: true,
    auth_style: "api_key",
    needs_api_version: true,
    hint: "Swap YOUR-RESOURCE and YOUR-DEPLOYMENT into the URL. Uses the api-key header + api-version query. No /chat/completions on the end.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "anthropic/claude-3.5-sonnet",
    needs_key: true,
    hint: "Multi-vendor router. Paste your OpenRouter key.",
  },
  {
    id: "xai",
    label: "xAI",
    base_url: "https://api.x.ai/v1",
    default_model: "grok-4.5",
    needs_key: true,
    hint: "Grok models through xAI's OpenAI-compatible API.",
  },
  {
    id: "groq",
    label: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    default_model: "llama-3.3-70b-versatile",
    needs_key: true,
    hint: "Fastest token throughput. Paste your Groq key.",
  },
  {
    id: "together",
    label: "Together.ai",
    base_url: "https://api.together.xyz/v1",
    default_model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    needs_key: true,
    hint: "Hosted open models. Paste your Together key.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    base_url: "http://localhost:11434/v1",
    default_model: "llama3.2",
    needs_key: false,
    hint: "Runs on your machine. No API key.",
  },
  {
    id: "custom",
    label: "Custom endpoint",
    base_url: "",
    default_model: "",
    needs_key: true,
    hint: "Any server that speaks /v1/chat/completions.",
  },
];

function slugifyProvider(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function CustomProviderForm({ onAdded }: { onAdded: () => void }) {
  const [presetId, setPresetId] = useState<string>(
    CUSTOM_PROVIDER_PRESETS[0]!.id,
  );
  const preset =
    CUSTOM_PROVIDER_PRESETS.find((p) => p.id === presetId) ??
    CUSTOM_PROVIDER_PRESETS[0]!;
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(preset.base_url);
  const [model, setModel] = useState(preset.default_model);
  const [apiKey, setApiKey] = useState("");
  const [apiVersion, setApiVersion] = useState(AZURE_API_VERSION_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function choosePreset(id: string) {
    const p = CUSTOM_PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setBaseUrl(p.base_url);
    setModel(p.default_model);
    setErr(null);
    setOk(null);
    // Prefill the name with the preset label unless the user already
    // typed one, so the slug is never empty for the common case.
    if (!name.trim() && p.id !== "custom") setName(p.label);
  }

  const slug = slugifyProvider(name.trim() || preset.id);
  const disabled =
    busy ||
    !name.trim() ||
    !baseUrl.trim() ||
    !model.trim() ||
    (preset.needs_key && !apiKey.trim());

  async function submit() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = await api.brainUpsertProvider({
        slug,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        authStyle: preset.auth_style,
        apiVersion: preset.needs_api_version
          ? apiVersion.trim() || AZURE_API_VERSION_DEFAULT
          : undefined,
        setActive: false,
      });
      setOk(`Added ${res.provider_id}. Select it above to make it active.`);
      setName("");
      setApiKey("");
      onAdded();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Cloud & custom providers">
      <div className="py-1">
        <div className="text-xs text-text-3 mb-3">
          Add any OpenAI-compatible endpoint (Azure OpenAI, OpenRouter,
          Groq, a local vLLM) as a selectable brain above.
        </div>
        {err && (
          <div className="text-sm text-red mb-2" role="alert">
            {err}
          </div>
        )}
        {ok && <div className="text-sm text-green mb-2">{ok}</div>}
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">Provider</span>
            <Select
              value={presetId}
              onChange={choosePreset}
              options={CUSTOM_PROVIDER_PRESETS.map((p) => ({
                value: p.id,
                label: p.label,
              }))}
            />
          </label>
          <div className="text-xs text-text-4 -mt-1">{preset.hint}</div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">
              Name{" "}
              <code className="text-text-5">openai_compat:{slug || "…"}</code>
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Azure GPT-4o"
              className="h-7 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">Base URL</span>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="h-7 text-sm font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">Model</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o"
              className="h-7 text-sm font-mono"
            />
          </label>
          {preset.needs_api_version && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-3">API version</span>
              <Input
                value={apiVersion}
                onChange={(e) => setApiVersion(e.target.value)}
                placeholder={AZURE_API_VERSION_DEFAULT}
                className="h-7 text-sm font-mono"
              />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">
              API key{" "}
              {!preset.needs_key && (
                <span className="text-text-5">(optional)</span>
              )}
            </span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={preset.needs_key ? "sk-…" : "leave blank for local"}
              className="h-7 text-sm"
            />
          </label>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="default"
              disabled={disabled}
              onClick={() => void submit()}
            >
              {busy ? "Adding…" : "Add provider"}
            </Button>
            <span className="text-xs text-text-4">
              Keys go straight to your OS keychain, never to settings.
            </span>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── Cloud singletons (Bedrock / Vertex) ──────────────────────────────
//
// AWS Bedrock and Google Vertex AI both run Anthropic's Claude, but neither
// authenticates with a single API key: Bedrock needs an access-key pair +
// region and SigV4-signs each call; Vertex needs a project + location + a
// service-account JSON it exchanges for an OAuth token. They're compiled-in
// singletons (not openai_compat:<slug>), so instead of the one-key field in
// the "Available brains" list, they get this multi-field form. Non-secret
// fields land in brain_settings.json; the credential (AWS secret key / the
// SA-JSON) goes straight to the OS keychain via `brain_configure_cloud`.

type CloudField = {
  key: string;
  label: string;
  placeholder: string;
  mono?: boolean;
  optional?: boolean;
};

type CloudBrainPreset = {
  id: "bedrock" | "vertex";
  label: string;
  defaultModel: string;
  fields: CloudField[];
  secretLabel: string;
  secretPlaceholder: string;
  secretMultiline?: boolean;
  hint: string;
};

const CLOUD_BRAIN_PRESETS: CloudBrainPreset[] = [
  {
    id: "bedrock",
    label: "AWS Bedrock",
    // Was Claude 3.5 Sonnet from October 2024, two generations back, while
    // the Vertex preset beside it already defaulted to Sonnet 4.5. Newer
    // Anthropic models are reached through a cross-region inference profile,
    // hence the `us.` prefix — `bedrock.rs` already handles that shape.
    // Anyone outside US regions edits the field, same as before.
    defaultModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    fields: [
      { key: "region", label: "Region", placeholder: "us-east-1", mono: true },
      {
        key: "access_key_id",
        label: "Access key ID",
        placeholder: "AKIA…",
        mono: true,
      },
      {
        key: "session_token",
        label: "Session token",
        placeholder: "only for temporary STS credentials",
        mono: true,
        optional: true,
      },
    ],
    secretLabel: "Secret access key",
    secretPlaceholder: "AWS secret access key",
    hint: "Runs Claude on your AWS account. Needs an IAM key pair with bedrock:InvokeModel and the model enabled in the region.",
  },
  {
    id: "vertex",
    label: "Google Vertex AI",
    defaultModel: "claude-sonnet-4-5@20250929",
    fields: [
      {
        key: "project_id",
        label: "Project ID",
        placeholder: "my-gcp-project",
        mono: true,
      },
      {
        key: "location",
        label: "Location",
        placeholder: "us-east5",
        mono: true,
      },
    ],
    secretLabel: "Service-account JSON",
    secretPlaceholder:
      '{ "type": "service_account", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----\\n…" }',
    secretMultiline: true,
    hint: "Runs Claude on your GCP project. Paste the JSON key for a service account that has the Vertex AI User role.",
  },
];

function CloudBrainForm({
  descriptors,
  onSaved,
}: {
  descriptors: BrainDescriptor[];
  onSaved: () => void;
}) {
  // Only offer the cloud singletons that were actually compiled into this
  // build (feature-gated) — no point showing a form that can't resolve.
  const presets = useMemo(
    () =>
      CLOUD_BRAIN_PRESETS.filter((p) =>
        descriptors.some((d) => d.provider_id === p.id),
      ),
    [descriptors],
  );
  const [presetId, setPresetId] = useState<"bedrock" | "vertex">(
    presets[0]?.id ?? "bedrock",
  );
  const preset =
    presets.find((p) => p.id === presetId) ?? presets[0] ?? null;

  const [model, setModel] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Prefill from the saved config whenever the selected cloud brain changes.
  // The credential itself never comes back — only whether one is stored.
  const loadConfig = useCallback(async (id: "bedrock" | "vertex") => {
    setErr(null);
    setOk(null);
    setSecret("");
    try {
      const cfg = await api.brainCloudConfigGet(id);
      setModel(cfg.model ?? "");
      setExtra(cfg.extra ?? {});
      setHasSecret(cfg.has_secret);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    if (preset) void loadConfig(preset.id);
  }, [preset, loadConfig]);

  if (!preset) return null;

  function choose(id: string) {
    if (id === "bedrock" || id === "vertex") setPresetId(id);
  }

  const missingField = preset.fields.some(
    (f) => !f.optional && !(extra[f.key] ?? "").trim(),
  );
  const disabled =
    busy ||
    !model.trim() ||
    missingField ||
    // Credential is required the first time; on re-save it may be left blank
    // to keep the stored one.
    (!hasSecret && !secret.trim());

  async function submit() {
    if (!preset) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const cleanExtra: Record<string, string> = {};
      for (const f of preset.fields) {
        const v = (extra[f.key] ?? "").trim();
        if (v) cleanExtra[f.key] = v;
      }
      await api.brainConfigureCloud({
        providerId: preset.id,
        model: model.trim(),
        extra: cleanExtra,
        // Omit → keep the stored credential; non-empty → replace it.
        secret: secret.trim() ? secret.trim() : undefined,
        setActive: false,
      });
      setSecret("");
      setOk(`Saved ${preset.label}. Select it above to make it active.`);
      await loadConfig(preset.id);
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Claude on your own cloud">
      <div className="py-1">
        <div className="text-xs text-text-3 mb-3">
          Run Anthropic&apos;s Claude through your own AWS Bedrock or Google
          Vertex account. Billed on your cloud, no Anthropic key needed.
        </div>
        {err && (
          <div className="text-sm text-red mb-2" role="alert">
            {err}
          </div>
        )}
        {ok && <div className="text-sm text-green mb-2">{ok}</div>}
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">Provider</span>
            <Select
              value={presetId}
              onChange={choose}
              options={presets.map((p) => ({ value: p.id, label: p.label }))}
            />
          </label>
          <div className="text-xs text-text-4 -mt-1">{preset.hint}</div>
          {preset.fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-xs text-text-3">
                {f.label}{" "}
                {f.optional && (
                  <span className="text-text-5">(optional)</span>
                )}
              </span>
              <Input
                value={extra[f.key] ?? ""}
                onChange={(e) =>
                  setExtra((s) => ({ ...s, [f.key]: e.target.value }))
                }
                placeholder={f.placeholder}
                className={`h-7 text-sm ${f.mono ? "font-mono" : ""}`}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">Model</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={preset.defaultModel}
              className="h-7 text-sm font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-3">
              {preset.secretLabel}{" "}
              {hasSecret && (
                <span className="text-green">
                  ✓ stored. Leave blank to keep
                </span>
              )}
            </span>
            {preset.secretMultiline ? (
              <Textarea
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={
                  hasSecret
                    ? "Paste a new service-account JSON to replace…"
                    : preset.secretPlaceholder
                }
                className="text-xs font-mono min-h-[96px]"
              />
            ) : (
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={
                  hasSecret ? "Replace stored secret…" : preset.secretPlaceholder
                }
                className="h-7 text-sm"
              />
            )}
          </label>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="default"
              disabled={disabled}
              onClick={() => void submit()}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <span className="text-xs text-text-4">
              The credential goes straight to your OS keychain, never to
              settings.
            </span>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── Aura Pro row ──────────────────────────────────────────────────────
//
// v0.2.31 task #352. Special-case panel rendered inside the Brain tab
// when the descriptor is `aura_pro`. Unlike the BYOK rows, this brain
// has no API-key field — it reuses the cloud token OnboardingDialog
// already stashed. We show:
//
//   - "Signed in as <email>" or a "Sign in to Aura" button that fires
//     the existing `aura:open-onboarding` window event the onboarding
//     dialog already listens for.
//   - "1,234,567 / 2,000,000 tokens used this period" (or "∞" for the
//     unlimited tier), pulled from the cloud `/v1/brain/quota` endpoint
//     via the `aura_pro_quota` tauri command. Refresh button alongside
//     so the user can see the bucket move after a long session.

function AuraProRow() {
  const [signIn, setSignIn] = useState<AuraProSignInState | null>(null);
  const [quota, setQuota] = useState<AuraProQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The cloud rejected the token we hold. `signed_in` can't tell us this —
  // it only reads whether a token string exists on disk — so without this the
  // panel claims the account is fine and offers a Refresh that repeats the
  // same 401 every time it's pressed.
  const [expired, setExpired] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setExpired(false);
    try {
      const state = await api.auraProIsSignedIn();
      setSignIn(state);
      if (state.signed_in) {
        // Quota is only meaningful when signed in. Tolerate failure —
        // a 5xx from the cloud shouldn't blank out the sign-in label.
        try {
          const q = await api.auraProQuota();
          setQuota(q);
        } catch (e) {
          setQuota(null);
          setErr(`quota: ${isAuraProQuotaError(e) ? e.message : String(e)}`);
          setExpired(isAuraProQuotaError(e) && e.kind === "unauthorized");
        }
      } else {
        setQuota(null);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Refresh on dialog reopen elsewhere — when the user signs in via
    // the OnboardingDialog from another surface, the dialog dispatches
    // `aura:onboarding-refresh` on completion. Cheap to listen.
    const onRefresh = () => void refresh();
    window.addEventListener("aura:onboarding-refresh", onRefresh);
    return () =>
      window.removeEventListener("aura:onboarding-refresh", onRefresh);
  }, [refresh]);

  function openSignIn() {
    window.dispatchEvent(new CustomEvent("aura:open-onboarding"));
  }

  if (loading && !signIn) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-text-4" role="status">
        <AsciiSpinner className="text-xs leading-none" />
        Checking whether you're signed in…
      </div>
    );
  }

  if (!signIn?.signed_in) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-text-3">Not signed in.</span>
        <Button size="sm" variant="secondary" onClick={openSignIn}>
          Sign in to Aura
        </Button>
        {err && (
          <span className="text-xs text-red ml-1" title={err}>
            (error)
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div
        className="flex items-center gap-1.5 text-xs"
        title={signIn.cloud_origin ?? undefined}
      >
        {signIn.user ? (
          <>
            {/* Past tense once the cloud has rejected the token: the account
                is still theirs, but this machine is no longer signed in to
                it, and the present tense here is what made the failure below
                read as a glitch. */}
            <span className="text-text-3">
              {expired ? "Was signed in as" : "Signed in as"}
            </span>
            <span className="text-text-1 font-medium">{signIn.user}</span>
          </>
        ) : (
          <span className="text-text-3">
            {expired ? "Was signed in." : "Signed in."}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs">
        {expired ? (
          // The one failure a Refresh cannot mend. Say what happened in the
          // words it happened in, and offer the only control that fixes it.
          <>
            <span className="text-text-3">
              Your Aura session has expired.
            </span>
            <Button size="sm" variant="secondary" onClick={openSignIn}>
              Sign in again
            </Button>
          </>
        ) : quota ? (
          <span className="text-text-1">
            <span className="text-text-3">Usage: </span>
            {compactNumber(quota.tokens_used_current_period)} /{" "}
            {quota.monthly_token_limit == null
              ? "∞"
              : compactNumber(quota.monthly_token_limit)}{" "}
            tokens this period
            <span className="text-text-4 ml-2">tier: {quota.tier}</span>
            {!quota.active && (
              <span className="text-red ml-2">subscription inactive</span>
            )}
          </span>
        ) : err ? (
          <span className="text-text-3">
            Couldn&rsquo;t load your usage.
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-text-4" role="status">
            <AsciiSpinner className="text-xs leading-none" />
            Loading&hellip;
          </span>
        )}
        {/* Withheld while the session is dead. Re-reading a quota the cloud
            has already refused can only produce the same 401, and offering
            it beside "Sign in again" implies the two are alternatives. */}
        {!expired && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh sign-in + quota"
          >
            Refresh
          </Button>
        )}
      </div>
      {/* The detail, for the times the sentence above isn't enough. Shown
          alongside a good quota (a stale-but-readable number) and alongside
          an expired session (which status, from which origin) — but never as
          the *only* thing said, which is what "Couldn't load your usage."
          with no explanation amounted to. */}
      {err && (quota || expired) && (
        <div className="text-xs text-text-4">{err}</div>
      )}
    </div>
  );
}

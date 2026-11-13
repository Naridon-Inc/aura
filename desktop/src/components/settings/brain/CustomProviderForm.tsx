import { useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { SettingsError } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { api } from "../../../lib/api";
import {
  AZURE_API_VERSION_DEFAULT,
  CUSTOM_PROVIDER_PRESETS,
  slugifyProvider,
} from "./presets";

// Adds any OpenAI-compatible endpoint as a first-class brain via
// `brain_upsert_provider`. A new provider lands in the brain list above,
// where it is picked like any other and carries a Remove button, because
// unlike the compiled-in brains it is the user's own state.

export function CustomProviderForm({ onAdded }: { onAdded: () => void }) {
  const [presetId, setPresetId] = useState<string>(CUSTOM_PROVIDER_PRESETS[0]!.id);
  const preset =
    CUSTOM_PROVIDER_PRESETS.find((p) => p.id === presetId) ?? CUSTOM_PROVIDER_PRESETS[0]!;
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
      setOk(`Added ${res.provider_id}. Choose Use on it above to make it active.`);
      setName("");
      setApiKey("");
      onAdded();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const text = (
    id: string,
    title: string,
    value: string,
    onChange: (v: string) => void,
    extra: { placeholder?: string; description?: string; secret?: boolean } = {},
  ) => (
    <SettingsRow
      title={title}
      htmlFor={`brain-custom-${id}`}
      description={extra.description}
      control={
        <Input
          id={`brain-custom-${id}`}
          type={extra.secret ? "password" : "text"}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={extra.placeholder}
        />
      }
    />
  );

  return (
    <SettingsSection
      title="Cloud & custom providers"
      description="Add any OpenAI-compatible endpoint (Azure OpenAI, OpenRouter, Groq, a local vLLM) as a brain you can pick above."
    >
      {err && <SettingsError>{err}</SettingsError>}
      <SettingsRow
        title="Provider"
        description={preset.hint}
        control={
          <Select
            aria-label="Provider"
            value={presetId}
            onChange={choosePreset}
            options={CUSTOM_PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          />
        }
      />
      <SettingsRow
        title="Name"
        htmlFor="brain-custom-name"
        description={
          <>
            Saved as <code>openai_compat:{slug || "…"}</code>
          </>
        }
        control={
          <Input
            id="brain-custom-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Azure GPT-4o"
          />
        }
      />
      {text("url", "Base URL", baseUrl, setBaseUrl, {
        placeholder: "https://api.example.com/v1",
      })}
      {text("model", "Model", model, setModel, { placeholder: "gpt-4o" })}
      {preset.needs_api_version &&
        text("version", "API version", apiVersion, setApiVersion, {
          placeholder: AZURE_API_VERSION_DEFAULT,
        })}
      {text("key", "API key", apiKey, setApiKey, {
        secret: true,
        placeholder: preset.needs_key ? "sk-…" : "leave blank for local",
        description: preset.needs_key
          ? "Goes straight to your OS keychain, never to settings."
          : "Optional. A server on your own machine usually takes none.",
      })}
      <SettingsRow
        title="Add this provider"
        description={ok ?? "It joins the brain list above. Nothing switches until you pick it."}
        control={
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void submit()}>
            {busy ? "Adding…" : "Add provider"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

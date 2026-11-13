import { useState, type ReactNode } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import type { OpenAiCompatProfile } from "../../../lib/api";
import { OPENAI_COMPAT_PRESETS, parseHeaderLines } from "./presets";

// Adding or editing one local or hosted model, as rows on the page itself.
// Escape cancels; nothing is written until Add model / Save changes.

export function LocalModelEditor({
  entry,
  existingNames,
  busy,
  onCancel,
  onSave,
}: {
  entry: OpenAiCompatProfile;
  existingNames: string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (entry: OpenAiCompatProfile) => void;
}) {
  const [draft, setDraft] = useState<OpenAiCompatProfile>({
    ...entry,
    headers: entry.headers ?? {},
  });
  const [presetId, setPresetId] = useState("");
  // Headers as one textarea, `Key: Value` per line, so a multi-header auth
  // block (HF dedicated endpoints) pastes in one go.
  const [headersText, setHeadersText] = useState<string>(() =>
    Object.entries(entry.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );

  const isNew = !entry.created_at;
  const nameTaken =
    isNew && existingNames.some((n) => n.toLowerCase() === draft.name.trim().toLowerCase());

  function applyPreset(id: string) {
    const preset = OPENAI_COMPAT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setDraft((prev) => ({
      ...prev,
      base_url: preset.base_url,
      model: prev.model || preset.default_model,
      description: prev.description || preset.hint,
    }));
  }

  function save() {
    onSave({
      ...draft,
      name: draft.name.trim(),
      base_url: draft.base_url.trim(),
      model: draft.model.trim(),
      api_key: draft.api_key?.trim() || null,
      headers: parseHeaderLines(headersText),
      temperature:
        typeof draft.temperature === "number" && !Number.isNaN(draft.temperature)
          ? draft.temperature
          : null,
      description: draft.description?.trim() || null,
    });
  }

  const saveDisabled =
    busy || !draft.name.trim() || !draft.base_url.trim() || !draft.model.trim() || nameTaken;

  const row = (id: string, title: string, description: ReactNode, control: ReactNode, help?: ReactNode) => (
    <SettingsRow
      title={title}
      htmlFor={`local-model-${id}`}
      description={description}
      help={help}
      control={control}
    />
  );

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <SettingsSection
        title={isNew ? "Add a model" : `Edit ${entry.name}`}
        description="Tell Aura where the model lives and what it is called. Once it is here you chat with it exactly like a built-in model: it appears in the same “+” menu, under the name you give it."
      >
        {isNew &&
          row(
            "preset",
            "Start from",
            "Fills in the address and a model that provider is known to serve. Everything below stays editable.",
            <Select
              id="local-model-preset"
              aria-label="Start from"
              placeholder="Choose a provider"
              value={presetId}
              onChange={applyPreset}
              options={OPENAI_COMPAT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            />,
            OPENAI_COMPAT_PRESETS.find((p) => p.id === presetId)?.hint,
          )}
        {row(
          "name",
          "Name",
          "What you'll see it called in the “+” menu. Letters, digits, spaces.",
          <Input
            id="local-model-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            disabled={!isNew}
            placeholder="Llama 3 (local)"
            invalid={nameTaken}
          />,
          nameTaken ? (
            <span role="alert" className="ui-field-error">
              You already have one called that.
            </span>
          ) : undefined,
        )}
        {row(
          "url",
          "Base URL",
          "The address the model answers on, usually ending in /v1. Aura adds /chat/completions and /models itself, so stop before those.",
          <Input
            id="local-model-url"
            value={draft.base_url}
            onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
            placeholder="http://localhost:11434/v1"
          />,
        )}
        {row(
          "model",
          "Model",
          "The name that provider knows the model by: an Ollama tag, a HuggingFace repo path, a vendor's model name. Copy it exactly.",
          <Input
            id="local-model-model"
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            placeholder="llama3.2"
          />,
        )}
        {/* The consequence comes first on the key row itself, where the key
            is typed: anyone deciding whether to paste one reads it there. */}
        {row(
          "key",
          "API key",
          <>
            A key you paste here is saved unencrypted in{" "}
            <code>~/.aura/agents/openai-compat.json</code>,
            so anyone who can read that file can read the key.
          </>,
          <Input
            id="local-model-key"
            type="password"
            value={draft.api_key ?? ""}
            onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
            placeholder="sk-… / hf_…"
            autoComplete="off"
          />,
          "Optional. Leave it blank for Ollama and anything else on your own machine; hosted providers ask for one.",
        )}
        {row(
          "temp",
          "Temperature",
          "0.0 = deterministic, 1.0 = creative. Blank leaves the server default.",
          <Input
            id="local-model-temp"
            className="ui-settings-number"
            type="number"
            step="0.05"
            min="0"
            max="2"
            value={typeof draft.temperature === "number" ? draft.temperature : ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                temperature: e.target.value === "" ? null : Number(e.target.value),
              })
            }
            placeholder="0.7"
          />,
        )}
        {row(
          "headers",
          "Extra headers",
          "Optional. One header per line, Name: Value. Useful for HF dedicated endpoints and OpenRouter routing hints.",
          <Textarea
            id="local-model-headers"
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={3}
            placeholder={"X-HF-Endpoint: my-endpoint\nHTTP-Referer: https://example.com"}
          />,
        )}
        {row(
          "desc",
          "Description",
          "Optional. Shown under the name in the “+” menu, to tell two similar ones apart.",
          <Input
            id="local-model-desc"
            value={draft.description ?? ""}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Local Llama 3 via Ollama"
          />,
        )}
        <SettingsRow
          title={isNew ? "Add this model" : "Save changes"}
          control={
            <SettingsActions>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saveDisabled}>
                {isNew ? "Add model" : "Save changes"}
              </Button>
            </SettingsActions>
          }
        />
      </SettingsSection>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { SettingsError } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { api, type BrainDescriptor } from "../../../lib/api";
import { CLOUD_BRAIN_PRESETS, type CloudBrainId } from "./presets";

// Claude on your own AWS Bedrock or Google Vertex account. Each needs more
// than one key, so instead of the single key row the brain list gives a
// keyed brain, these get a form of their own.

export function CloudBrainForm({
  descriptors,
  onSaved,
}: {
  descriptors: BrainDescriptor[];
  onSaved: () => void;
}) {
  // Only the cloud brains compiled into this build (they are feature-gated);
  // a form that cannot resolve is not offered.
  const presets = useMemo(
    () => CLOUD_BRAIN_PRESETS.filter((p) => descriptors.some((d) => d.provider_id === p.id)),
    [descriptors],
  );
  const [presetId, setPresetId] = useState<CloudBrainId>(presets[0]?.id ?? "bedrock");
  const preset = presets.find((p) => p.id === presetId) ?? presets[0] ?? null;

  const [model, setModel] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Prefill from the saved config whenever the selected cloud brain changes.
  // The credential itself never comes back, only whether one is stored.
  const loadConfig = useCallback(async (id: CloudBrainId) => {
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

  const missingField = preset.fields.some((f) => !f.optional && !(extra[f.key] ?? "").trim());
  const disabled =
    busy ||
    !model.trim() ||
    missingField ||
    // Required the first time; on a re-save a blank keeps the stored one.
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
      setOk(`Saved ${preset.label}. Choose Use on it above to make it active.`);
      await loadConfig(preset.id);
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const secretId = `brain-cloud-${preset.id}-secret`;
  return (
    <SettingsSection
      title="Claude on your own cloud"
      description="Run Anthropic's Claude through your own AWS Bedrock or Google Vertex account. Billed on your cloud, no Anthropic key needed."
    >
      {err && <SettingsError>{err}</SettingsError>}
      <SettingsRow
        title="Cloud"
        description={preset.hint}
        control={
          <Select
            aria-label="Cloud"
            value={preset.id}
            onChange={choose}
            options={presets.map((p) => ({ value: p.id, label: p.label }))}
          />
        }
      />
      {preset.fields.map((f) => (
        <SettingsRow
          key={f.key}
          title={f.label}
          htmlFor={`brain-cloud-${f.key}`}
          description={f.optional ? "Optional." : undefined}
          control={
            <Input
              id={`brain-cloud-${f.key}`}
              value={extra[f.key] ?? ""}
              onChange={(e) => setExtra((s) => ({ ...s, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
            />
          }
        />
      ))}
      <SettingsRow
        title="Model"
        htmlFor="brain-cloud-model"
        control={
          <Input
            id="brain-cloud-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={preset.defaultModel}
          />
        }
      />
      <SettingsRow
        title={preset.secretLabel}
        htmlFor={secretId}
        description={
          hasSecret
            ? "Stored in your OS keychain. Leave blank to keep it."
            : "Goes straight to your OS keychain, never to settings."
        }
        control={
          preset.secretMultiline ? (
            <Textarea
              id={secretId}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                hasSecret ? "Paste a new service-account JSON to replace…" : preset.secretPlaceholder
              }
            />
          ) : (
            <Input
              id={secretId}
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={hasSecret ? "Replace stored secret…" : preset.secretPlaceholder}
            />
          )
        }
      />
      <SettingsRow
        title={`Save ${preset.label}`}
        description={ok ?? "It joins the brain list above. Nothing switches until you pick it."}
        control={
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

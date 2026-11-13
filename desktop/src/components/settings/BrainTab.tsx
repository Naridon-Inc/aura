// Settings → Brain & models.
//
// Every brain compiled into this build, one row each, with the active one
// marked and a Use button on the rest. The active brain's own setting sits
// directly under it: an API key for the keyed brains (it lands in the OS
// keychain via `brain_keychain_set` and never round-trips to the frontend
// after the first save). Below the list, the two ways to add a brain of your
// own: Claude on your own cloud and any OpenAI-compatible endpoint.

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  SettingsActions,
  SettingsEmpty,
  SettingsError,
  SettingsIntro,
  SettingsStatusLine,
} from "../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
import { api, type BrainDescriptor } from "../../lib/api";
import { askConfirm } from "../ui/ask";
import { CloudBrainForm } from "./brain/CloudBrainForm";
import { CustomProviderForm } from "./brain/CustomProviderForm";

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
      const [ds, settings, brains] = await Promise.all([
        api.brainListDescriptors(),
        api.brainGetSettings(),
        api.managerListBrains(),
      ]);
      setDescriptors(ds);
      // With nothing saved, a turn runs on the first agent or key that is set
      // up, and the list marks that one; the row says so too.
      setActive(settings.active_provider_id ?? brains.find((b) => b.active)?.id ?? null);
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
      <SettingsIntro>
        Which model Aura thinks with. The ones marked (CLI) reuse the login you already have on this
        machine; the rest take an API key.
      </SettingsIntro>
      {err && <SettingsError>{err}</SettingsError>}
      {msg && <SettingsStatusLine text={msg} />}
      <SettingsSection title="Available brains">
        {descriptors.length === 0 ? (
          <SettingsEmpty>
            No brains compiled into this build. Rebuild with at least one of{" "}
            <code>brain_anthropic_native</code>, <code>brain_cli_wrapper</code>,{" "}
            <code>brain_openai_native</code>, <code>brain_gemini_native</code>,{" "}
            <code>brain_openai_compat</code>.
          </SettingsEmpty>
        ) : (
          descriptors.map((d) => {
            const isActive = active === d.provider_id;
            const removable = d.provider_id.startsWith("openai_compat:");
            // Whether a key is stored is a fact about the row; the field for
            // typing one belongs to the brain you have chosen.
            const keyNote = !d.requires_api_key
              ? null
              : d.has_api_key
                ? "Key saved"
                : "Needs an API key";
            return (
              <div key={d.provider_id}>
                <SettingsRow
                  title={d.display_name}
                  description={d.blurb}
                  help={keyNote ?? undefined}
                  control={
                    <SettingsActions>
                      {isActive ? (
                        <Badge variant="highlight">Active</Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Use ${d.display_name}`}
                          disabled={busy === d.provider_id}
                          onClick={() => void pick(d.provider_id)}
                        >
                          Use
                        </Button>
                      )}
                      {removable && (
                        <Button
                          size="iconSm"
                          variant="ghost"
                          aria-label={`Remove ${d.display_name}`}
                          disabled={busy === d.provider_id}
                          onClick={() => void removeProvider(d.provider_id)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </SettingsActions>
                  }
                />
                {isActive && d.requires_api_key && (
                  <ApiKeyRow
                    descriptor={d}
                    draft={keyDrafts[d.provider_id] ?? ""}
                    busy={busy === d.provider_id}
                    onDraft={(v) => setKeyDrafts((s) => ({ ...s, [d.provider_id]: v }))}
                    onSave={() => void saveKey(d.provider_id)}
                    onForget={() => void forgetKey(d.provider_id)}
                  />
                )}
              </div>
            );
          })
        )}
      </SettingsSection>
      <CloudBrainForm descriptors={descriptors} onSaved={() => void load()} />
      <CustomProviderForm onAdded={() => void load()} />
    </>
  );
}

function ApiKeyRow({
  descriptor: d,
  draft,
  busy,
  onDraft,
  onSave,
  onForget,
}: {
  descriptor: BrainDescriptor;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
  onForget: () => void;
}) {
  const id = `brain-key-${d.provider_id}`;
  return (
    <SettingsRow
      title={`API key for ${d.display_name}`}
      htmlFor={id}
      description={
        d.has_api_key
          ? "Stored in your OS keychain. Paste a new one to replace it."
          : "Kept in your OS keychain, never in settings."
      }
      control={
        <SettingsActions>
          <Input
            id={id}
            type="password"
            autoComplete="off"
            placeholder={d.has_api_key ? "Replace stored API key…" : "API key"}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft) onSave();
            }}
          />
          <Button size="sm" variant="outline" disabled={!draft || busy} onClick={onSave}>
            Save
          </Button>
          {d.has_api_key && (
            <Button
              size="sm"
              variant="outlineDestructive"
              disabled={busy}
              onClick={onForget}
              title="Remove from OS keychain"
            >
              Forget
            </Button>
          )}
        </SettingsActions>
      }
    />
  );
}

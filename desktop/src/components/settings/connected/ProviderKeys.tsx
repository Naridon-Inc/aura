// Reaching a model provider is a key you paste. Two shapes, because the two
// halves of the pane ask two different questions:
//
//   ProviderKeyEntry    — the store: "I don't have this yet." One field.
//   ProviderKeyControls — the list:  "I have this." Make it the active one,
//                         replace it, or take it away.
//
// The key itself is never shown back. It is written to
// `~/.aura/credentials.json` (mode 0600) and read back only as its last four
// characters, which is enough to tell two keys apart and not enough to use
// one. Clearing a key also clears the environment-variable fallback from
// `aura`'s point of view, so "no key" means no key.

import { useState } from "react";

import { api } from "../../../lib/api";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import type { ServiceId } from "./catalog";

/** Paste a key for a provider that has none. Enter saves, Escape gives up. */
export function ProviderKeyEntry({
  provider,
  label,
  onSaved,
  onCancel,
}: {
  provider: ServiceId;
  label: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.settingsSetProviderKey(provider, value);
      setValue("");
      onSaved();
    } catch (e) {
      // A rejected key used to vanish silently and leave the row looking
      // unchanged, which reads as "nothing happened" rather than "that
      // didn't work".
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Paste your ${label} key…`}
          aria-label={`${label} API key`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) void save();
            if (e.key === "Escape") onCancel();
          }}
          className="flex-1 font-mono"
        />
        <Button size="sm" onClick={() => void save()} disabled={!value.trim() || busy}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}

/** What you can do to a key you already have. */
export function ProviderKeyControls({
  provider,
  label,
  active,
  onChanged,
}: {
  provider: ServiceId;
  label: string;
  /** True when this is the provider the app currently asks. */
  active: boolean;
  onChanged: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (replacing) {
    return (
      <ProviderKeyEntry
        provider={provider}
        label={label}
        onSaved={() => {
          setReplacing(false);
          onChanged();
        }}
        onCancel={() => setReplacing(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {!active && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => api.settingsSetActiveProvider(provider))}
          >
            Use this one
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setReplacing(true)}
        >
          Replace key
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="text-red hover:text-red"
          onClick={() => void run(() => api.settingsSetProviderKey(provider, ""))}
        >
          Remove
        </Button>
      </div>
      {active && (
        <p className="text-xs text-text-4">
          This is the provider Aura is asking right now.
        </p>
      )}
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}

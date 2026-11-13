// Reaching a model provider is a key you paste. Two rows, because the two
// halves of the pane ask two different questions:
//
//   ProviderStoreRow — the store: "I don't have this yet." Add a key.
//   ProviderKeyRow   — the list:  "I have this." Make it the active one,
//                      replace it, or take it away.
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
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { ServiceName } from "./ServiceGlyph";
import { CardError } from "./trackerParts";
import type { CatalogEntry, ConnectedService, ServiceId } from "./catalog";

/** Paste a key. Enter saves, Escape gives up. Drawn in a row's control slot;
 *  a failure goes back to the row, which prints it under its own title. */
function KeyEntry({
  provider,
  label,
  onSaved,
  onCancel,
  onError,
}: {
  provider: ServiceId;
  label: string;
  onSaved: () => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await api.settingsSetProviderKey(provider, value);
      setValue("");
      onSaved();
    } catch (e) {
      // A rejected key used to vanish silently and leave the row looking
      // unchanged, which reads as "nothing happened" rather than "that
      // didn't work".
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsActions>
      <Input
        type="password"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`Paste your ${label} key…`}
        aria-label={`${label} API key`}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) void save();
          if (e.key === "Escape") {
            // Giving up on the key ends here; Settings stays open.
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <Button size="sm" onClick={() => void save()} disabled={!value.trim() || busy}>
        Save
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </SettingsActions>
  );
}

/** A provider with no key yet, in the store. */
export function ProviderStoreRow({
  entry,
  open,
  onToggle,
  onSaved,
}: {
  entry: CatalogEntry;
  /** The key field is showing. Held by the pane so leaving the store and
   *  coming back does not leave a half-typed key behind. */
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsRow
      title={<ServiceName entry={entry} />}
      description={entry.blurb}
      help={error ? <CardError msg={error} /> : undefined}
      control={
        open ? (
          <KeyEntry
            provider={entry.id}
            label={entry.label}
            onSaved={onSaved}
            onCancel={() => {
              setError(null);
              onToggle();
            }}
            onError={setError}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={onToggle}>
            Add key
          </Button>
        )
      }
    />
  );
}

/** A provider you have a key for, on the connected list. */
export function ProviderKeyRow({
  svc,
  onChanged,
}: {
  svc: ConnectedService;
  onChanged: () => void;
}) {
  const { entry, detail, active } = svc;
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

  return (
    <SettingsRow
      title={<ServiceName entry={entry} active={active} />}
      description={
        active ? `${detail ?? "Key saved"} · the provider Aura is asking right now` : detail
      }
      help={error ? <CardError msg={error} /> : undefined}
      control={
        replacing ? (
          <KeyEntry
            provider={entry.id}
            label={entry.label}
            onSaved={() => {
              setReplacing(false);
              onChanged();
            }}
            onCancel={() => {
              setError(null);
              setReplacing(false);
            }}
            onError={setError}
          />
        ) : (
          <SettingsActions>
            {!active && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => api.settingsSetActiveProvider(entry.id))}
              >
                Use this one
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setReplacing(true)}>
              Replace key
            </Button>
            <Button
              variant="outlineDestructive"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => api.settingsSetProviderKey(entry.id, ""))}
            >
              Remove
            </Button>
          </SettingsActions>
        )
      }
    />
  );
}

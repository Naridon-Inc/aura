// "Secrets & tools" — what an agent finds in its environment on a machine.
//
// Two halves that people conflate and the backend keeps apart. The top half
// is the vault: named values (API keys, tokens) kept in a 0600 file on this
// laptop and handed to the work's process environment at boot — never shown
// back, not even masked. The bottom half is the project's declared toolchain,
// checked and installed on the chosen machine in place.
//
// Pasting KEY=VALUE lines into the add dialog's name field is the fast way in
// for someone holding a `.env` file: each line becomes one kept secret. That
// is what "environment" means to the person typing, and it is honest about
// where those lines go.

import { useCallback, useEffect, useState } from "react";
import type { Place } from "../../lib/place/contract";
import {
  forgetSecret,
  keepSecret,
  listSecrets,
  type SecretRef,
} from "../../lib/place/secrets";
import { askConfirm } from "../ui/ask";
import { Input } from "../ui/input";
import {
  SettingsEnvironmentDialog,
  SettingsEnvironmentSecrets,
  type EnvironmentEntry,
} from "../ui/settings-environment-secrets";
import { SettingsRow } from "../ui/settings-row";
import { PlaceEnvSpecSection } from "./PlaceEnvSpecSection";
import { PlacePicker, useProjectPlaces } from "./PlacePicker";
import { PlaceSecretRow } from "./PlaceSecretRow";

export { parseEnvLines } from "../ui/settings-environment-secrets";

export function PlaceEnvPane({ repoRoot }: { repoRoot: string }) {
  const places = useProjectPlaces(repoRoot);
  const [place, setPlace] = useState<Place>(places[0]);
  // The place object is rebuilt when the machine list changes; keep the
  // selection by id rather than by reference.
  useEffect(() => {
    const kept = places.find((p) => p.machineId === place.machineId);
    if (!kept) setPlace(places[0]);
    else if (kept !== place) setPlace(kept);
  }, [places, place]);

  const [secrets, setSecrets] = useState<SecretRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  // undefined = dialog closed, null = adding, a name = replacing that one.
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [gitHost, setGitHost] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSecrets(await listSecrets(repoRoot));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (name: string | null) => {
    // A replaced Git token keeps pushing to the host it was kept for unless
    // the person says otherwise.
    setGitHost(name ? (secrets.find((s) => s.name === name)?.git_host ?? "") : "");
    setTarget(name);
  };

  /** Keep what the dialog collected. One name may carry a Git host; a pasted
   *  block is plain variables. A failure part-way reloads the list, so the
   *  rows show what was actually kept before the dialog reports the error. */
  const keep = async (entries: EnvironmentEntry[]) => {
    const host = entries.length === 1 ? gitHost.trim() : "";
    let last: SecretRef[] = secrets;
    try {
      for (const entry of entries) {
        last = await keepSecret(
          repoRoot,
          entry.name,
          entry.value,
          host ? { gitHost: host } : undefined,
        );
      }
      setSecrets(last);
      setError(null);
    } catch (e) {
      void load();
      throw e;
    }
  };

  const forget = async (s: SecretRef) => {
    const ok = await askConfirm({
      title: `Forget ${s.name}?`,
      body: "Work you start after this will not have it. Anything already running keeps it until it finishes.",
      confirmLabel: "Forget",
      tone: "danger",
    });
    if (!ok) return;
    setBusyName(s.name);
    setError(null);
    try {
      setSecrets(await forgetSecret(repoRoot, s.name));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyName(null);
    }
  };

  return (
    <>
      <SettingsEnvironmentSecrets
        description="Configure environment variables passed to agents. Values stay on this laptop and are never shown back."
        count={secrets.length}
        loading={loading}
        loadingLabel="Reading your variables…"
        error={error}
        onAdd={() => open(null)}
        after={
          <PlaceEnvSpecSection
            place={place}
            picker={
              <SettingsRow
                title="Machine"
                description="Variables reach whichever machine the work runs on. The tools below are checked per machine."
                control={<PlacePicker places={places} value={place} onChange={setPlace} />}
              />
            }
          />
        }
      >
        {secrets.map((s) => (
          <PlaceSecretRow
            key={s.name}
            secret={s}
            busy={busyName === s.name}
            onReplace={() => open(s.name)}
            onForget={() => void forget(s)}
          />
        ))}
      </SettingsEnvironmentSecrets>
      <SettingsEnvironmentDialog
        target={target}
        existing={secrets.map((s) => s.name)}
        onClose={() => setTarget(undefined)}
        onSave={keep}
        extra={(block) =>
          block ? null : (
            <label className="ui-form-field">
              Pushes to (optional)
              <Input
                aria-label="Pushes to"
                value={gitHost}
                onChange={(e) => setGitHost(e.target.value)}
                placeholder="github.com"
                spellCheck={false}
              />
              <span className="ui-settings-help">
                For a Git token, so pushes to that host go out under your name: github.com,
                gitlab.com, or your own host.
              </span>
            </label>
          )
        }
      />
    </>
  );
}

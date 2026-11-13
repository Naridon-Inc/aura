import { useEffect, useMemo, useState } from "react";

import { api, type TelemetryConsent, type TelemetryView } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { askConfirm } from "../../ui/ask";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsActions, SettingsEmpty, SettingsError } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { Switch } from "../../ui/switch";
import { Table, TableBody, TableCell, TableRow } from "../../ui/table";

// What Aura shares about how it is used, and the tally it keeps on this
// machine. Both read the same consent, so a change to one reloads the other.

export function UsageDataPage() {
  const [view, setView] = useState<TelemetryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    try {
      setView(await api.settingsTelemetryShow());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  return (
    <>
      <SharingSection onChanged={reload} />
      <LocalCounts view={view} error={error} reload={reload} />
    </>
  );
}

// The cloud-sharing consent. Two independent switches mirroring the
// first-run prompt; persisted in credentials.json via telemetry.rs, which
// gates every event on them. Saving here also marks consent "decided" so
// the launch prompt won't reappear.
function SharingSection({ onChanged }: { onChanged: () => void }) {
  const [consent, setConsent] = useState<TelemetryConsent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .telemetryConsentGet()
      .then(setConsent)
      .catch(() => setConsent(null));
  }, []);
  const apply = async (product: boolean, crash: boolean) => {
    try {
      setConsent(await api.telemetrySetConsent(product, crash));
      setError(null);
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };
  const crash = consent?.crash ?? true;
  const product = consent?.product ?? true;
  return (
    <SettingsSection
      title="Share with Aura"
      description="Anonymous only, never your code, files, what you type, or your name. We use it to see which features help and to fix crashes. Change it anytime."
    >
      {error && <SettingsError>{error}</SettingsError>}
      <SettingsRow
        title="Crash reports"
        description="Tells us when Aura breaks so we can fix it. The most useful to leave on."
        control={
          <Switch aria-label="Crash reports" checked={crash} onCheckedChange={(v) => apply(product, v)} />
        }
      />
      {/* This one switch is the whole of it. It gates the desktop's events
          AND the `aura` command-line tool's own ping — `track_event` in
          aura-cli/src/main.rs reads the same `telemetry_enabled` out of the
          same credentials.json — so the description has to name both, or
          turning it off looks narrower than it is. */}
      <SettingsRow
        title="Usage analytics"
        description="Counts of which features get opened, and which commands the aura command-line tool runs. Counts only, never your code, file paths, or anything you type. Sent with a fixed anonymous ID, not your name."
        control={
          <Switch aria-label="Usage analytics" checked={product} onCheckedChange={(v) => apply(v, crash)} />
        }
      />
    </SettingsSection>
  );
}

function LocalCounts({
  view,
  error,
  reload,
}: {
  view: TelemetryView | null;
  error: string | null;
  reload: () => void;
}) {
  const sorted = useMemo(
    () => (view ? Object.entries(view.counts).sort((a, b) => b[1] - a[1]) : []),
    [view],
  );
  const total = sorted.reduce((sum, [, n]) => sum + n, 0);
  const clear = async () => {
    const ok = await askConfirm({
      title: "Clear local telemetry counters?",
      body: "The counts Aura keeps on this machine go back to zero.",
      confirmLabel: "Clear",
      tone: "danger",
    });
    if (!ok) return;
    await api.settingsTelemetryClear();
    reload();
  };
  return (
    <SettingsSection title="Anonymous usage">
      {error && <SettingsError>{error}</SettingsError>}
      {!view ? (
        <p className="ui-settings-status" role="status">
          <AsciiSpinner />
          Loading what Aura has sent…
        </p>
      ) : !view.enabled ? (
        <SettingsEmpty>Usage analytics is off, so nothing is counted. Turn it on above to start.</SettingsEmpty>
      ) : (
        <>
          <SettingsRow
            title="Recorded on this machine"
            description={
              view.last_updated
                ? `Last updated ${new Date(view.last_updated * 1000).toLocaleString()}`
                : "Nothing sent yet."
            }
            control={
              <SettingsActions>
                <Badge variant="secondary">{total} events</Badge>
                <Button size="sm" variant="outlineDestructive" onClick={clear}>
                  Clear counters
                </Button>
              </SettingsActions>
            }
          />
          {sorted.length > 0 ? (
            <div className="ui-settings-counts">
              <Table>
                <TableBody>
                  {sorted.map(([name, n]) => (
                    <TableRow key={name}>
                      <TableCell>{name}</TableCell>
                      <TableCell>{n}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <SettingsEmpty>No events recorded yet.</SettingsEmpty>
          )}
        </>
      )}
    </SettingsSection>
  );
}

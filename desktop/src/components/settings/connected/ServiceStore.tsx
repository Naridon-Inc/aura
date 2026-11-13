// The store: everything you could connect, and nothing you already have.
//
// Two questions, two views: the list answers "what do I have", this answers
// "what else is there". A service disappears from here the moment it is
// connected, which is what makes the list trustworthy — it never offers to set
// up something you set up months ago.
//
// It is a step inside the pane, not a modal over it. A nested dialog on top of
// the settings dialog gives two Escape keys with different meanings and two
// scroll containers fighting over the wheel.

import { ArrowLeft, Plug, X } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsActions, SettingsEmpty } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { AuthFallback, CardError, SetupNeeded } from "./trackerParts";
import { BeadsImportRow } from "./BeadsImport";
import { ProviderStoreRow } from "./ProviderKeys";
import { ServiceName } from "./ServiceGlyph";
import { groupAvailable, type AvailableService, type ServiceId } from "./catalog";
import type { TrackerKind, Trackers } from "./useTrackers";

/** Where each tracker's app is created, for the "not set up here" message.
 *  Aura signs in through an OAuth app *you* own — there is no Aura-hosted
 *  client — so a machine with no credentials cannot start the flow at all. */
const TRACKER_HOME: Record<TrackerKind, string> = {
  jira: "the Atlassian developer console",
  linear: "Linear's API settings",
};

export function ServiceStore({
  available,
  trackers,
  repoRoot,
  openId,
  onOpen,
  onBack,
  onKeySaved,
}: {
  available: AvailableService[];
  trackers: Trackers;
  repoRoot: string;
  /** Which row has its key field showing. Held by the pane so leaving the
   *  store and coming back does not leave a half-typed key behind. */
  openId: ServiceId | null;
  onOpen: (id: ServiceId | null) => void;
  onBack: () => void;
  onKeySaved: () => void;
}) {
  const groups = groupAvailable(available);

  return (
    <>
      <div className="ui-settings-services-back">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />
          Back to what's connected
        </Button>
      </div>

      {groups.length === 0 ? (
        <SettingsEmpty>
          You have connected everything Aura knows how to connect. More services
          arrive with new versions.
        </SettingsEmpty>
      ) : (
        groups.map((group) => (
          <SettingsSection key={group.category} title={group.label}>
            {group.items.map((item) =>
              item.entry.category === "model" ? (
                <ProviderStoreRow
                  key={item.entry.id}
                  entry={item.entry}
                  open={openId === item.entry.id}
                  onToggle={() => onOpen(openId === item.entry.id ? null : item.entry.id)}
                  onSaved={onKeySaved}
                />
              ) : item.entry.category === "import" ? (
                <BeadsImportRow key={item.entry.id} entry={item.entry} repoRoot={repoRoot} />
              ) : (
                <TrackerStoreRow key={item.entry.id} item={item} trackers={trackers} />
              ),
            )}
          </SettingsSection>
        ))
      )}
    </>
  );
}

function TrackerStoreRow({ item, trackers }: { item: AvailableService; trackers: Trackers }) {
  const { entry, ready, known } = item;
  const isTracker = entry.category === "tracker";
  const kind = entry.id as TrackerKind;
  const busy = isTracker && trackers.busyKind === kind;
  const error = trackers.error?.kind === kind ? trackers.error.msg : null;

  const help = (
    <>
      {isTracker && !known && (
        // The list call is how we know whether this machine has an app for
        // the tracker. When it fails, "Not set up here" would be us reporting
        // something we did not find out — the same lie as drawing an empty
        // list over a request still in flight.
        <p>
          Aura couldn't check whether {entry.label} is set up on this machine.
          Retry from the list, then come back.
        </p>
      )}
      {isTracker && known && !ready && (
        <SetupNeeded what={entry.label} where={TRACKER_HOME[kind]} block={entry.id} />
      )}
      {busy && trackers.fallbackUrl && (
        <AuthFallback url={trackers.fallbackUrl} />
      )}
      {error && <CardError msg={error} />}
    </>
  );
  const hasHelp = !known || !ready || (busy && trackers.fallbackUrl) || error;

  return (
    <SettingsRow
      title={<ServiceName entry={entry} />}
      description={entry.blurb}
      help={hasHelp ? help : undefined}
      control={
        isTracker && (!known || !ready) ? null : isTracker ? (
          <SettingsActions>
            {busy && (
              // Cancel aborts the loopback listener, so the next attempt can
              // rebind the port instead of waiting out the five-minute
              // server-side timeout. Atlassian's error pages never redirect
              // back, so without this the only way out was to wait.
              <Button variant="outline" size="sm" onClick={() => void trackers.cancel(kind)}>
                <X />
                Cancel
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => void trackers.connect(kind)}>
              {busy ? <AsciiSpinner /> : <Plug />}
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </SettingsActions>
        ) : null
      }
    />
  );
}

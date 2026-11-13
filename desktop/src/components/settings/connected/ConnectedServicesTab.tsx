// Settings → Connected services.
//
// This pane shows what you have; the store shows what you could add, and drops
// anything you already have. That split is what makes the list worth reading:
// every row on it is a live connection, so a short list means a short answer
// rather than a page you have to scan.
//
// It is user-scoped, not project-scoped. Both halves are machine-level
// credentials — a key in `~/.aura/credentials.json`, an OAuth token in the
// keychain — and neither changes when you switch project. The one genuinely
// per-project thing, which Jira issues mirror onto which repo, gets its own
// section under the list once Jira is connected.

import { useCallback, useMemo, useState } from "react";
import { Plus, RotateCw } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsGroup, SettingsIntro } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import type { SettingsView } from "../../../lib/api";
import { MirrorsSection } from "./JiraMirrors";
import { PeopleSection } from "./JiraPeople";
import { ProviderKeyRow } from "./ProviderKeys";
import { ServiceStore } from "./ServiceStore";
import { TrackerRow } from "./TrackerRow";
import { formatExpiry } from "./trackerParts";
import {
  splitServices,
  type ConnectedService,
  type ServiceFacts,
  type ServiceId,
} from "./catalog";
import { useTrackers, type TrackerKind } from "./useTrackers";

export function ConnectedServicesTab({
  view,
  repoRoot,
  onChanged,
}: {
  view: SettingsView;
  repoRoot: string;
  onChanged: () => void;
}) {
  const trackers = useTrackers();
  const [shopping, setShopping] = useState(false);
  const [openId, setOpenId] = useState<ServiceId | null>(null);

  const facts = useMemo<ServiceFacts>(
    () => ({
      keyLast4: {
        anthropic: view.anthropic_key_last4,
        openai: view.openai_key_last4,
        gemini: view.gemini_key_last4,
        mercury: view.mercury_key_last4,
      },
      activeProvider: view.ai_provider,
      trackers: trackers.statuses,
      trackersKnown: trackers.loadError === null,
    }),
    [view, trackers.statuses, trackers.loadError],
  );

  const { connected, available } = useMemo(() => splitServices(facts), [facts]);

  // Connecting something moves it out of the store and into the list, so the
  // row you just acted on is gone from the screen you acted on. Leaving the
  // store is one click away and lands on the list the new connection is now
  // part of; the store itself never has to be told anything happened, because
  // `available` is derived and the row simply stops being in it.
  const leaveStore = useCallback(() => {
    setOpenId(null);
    setShopping(false);
  }, []);

  const openStore = useCallback(() => {
    setOpenId(null);
    setShopping(true);
  }, []);

  if (trackers.loading) {
    return (
      <p className="ui-settings-status" role="status">
        <AsciiSpinner /> Looking at what you're connected to…
      </p>
    );
  }

  if (shopping) {
    return (
      <ServiceStore
        available={available}
        trackers={trackers}
        repoRoot={repoRoot}
        openId={openId}
        onOpen={setOpenId}
        onBack={leaveStore}
        onKeySaved={() => {
          setOpenId(null);
          onChanged();
        }}
      />
    );
  }

  const jira = trackers.statuses.find((s) => s.kind === "jira" && s.connected) ?? null;
  const jiraSites = jira?.sites ?? [];

  return (
    <>
      <SettingsIntro>
        The model providers and issue trackers this copy of Aura can reach. Keys
        live in <code>~/.aura/credentials.json</code> and tracker sign-ins in
        your keychain — never in the repo.
      </SettingsIntro>

      <SettingsGroup>
        {/* The list call is how we know what is connected. When it fails we
            know nothing, and "nothing is connected" is an answer we do not
            have. Model keys still render below: they are read from a local
            file, and a keychain read failing has no bearing on them. */}
        {trackers.loadError && (
          <SettingsRow
            title="Aura couldn't check your trackers."
            description={trackers.loadError}
            control={
              <Button variant="outline" size="sm" onClick={() => void trackers.refresh()}>
                <RotateCw />
                Try again
              </Button>
            }
          />
        )}

        {connected.length === 0 ? (
          <SettingsRow
            title="Nothing is connected yet."
            description="Aura needs at least one model provider to answer anything — that is the one to add first."
            control={
              <Button size="sm" onClick={openStore}>
                <Plus />
                Add a service
              </Button>
            }
          />
        ) : (
          <>
            {connected.map((svc) => (
              <ConnectedRow
                key={svc.entry.id}
                svc={svc}
                trackers={trackers}
                onChanged={onChanged}
              />
            ))}
            <SettingsRow
              title="Add a service"
              description="Another model provider, an issue tracker, or a one-time import."
              control={
                <Button variant="outline" size="sm" onClick={openStore}>
                  <Plus />
                  Add
                </Button>
              }
            />
          </>
        )}
      </SettingsGroup>

      {jira && jiraSites.length > 0 && (
        <MirrorsSection
          sites={jiraSites}
          mirrors={jira.mirrors ?? []}
          autoMirrorRepoRoot={jira.auto_mirror_repo_root ?? null}
          repoRoot={repoRoot}
          onStatusUpdate={trackers.applyStatus}
        />
      )}
      {jira && (
        <PeopleSection repoRoot={repoRoot} />
      )}
    </>
  );
}

/** Linear has no per-project binding yet, so its row says so instead of
 *  leaving you to look for one. */
const LINEAR_NOTE =
  "Linear issues arrive alongside your work. Per-project mirroring is Jira only for now.";

function ConnectedRow({
  svc,
  trackers,
  onChanged,
}: {
  svc: ConnectedService;
  trackers: ReturnType<typeof useTrackers>;
  onChanged: () => void;
}) {
  const { entry } = svc;
  if (entry.category !== "tracker") {
    return <ProviderKeyRow svc={svc} onChanged={onChanged} />;
  }
  const kind = entry.id as TrackerKind;
  const status = trackers.statuses.find((s) => s.kind === entry.id) ?? null;
  const busy = trackers.busyKind === kind;
  const error = trackers.error?.kind === kind ? trackers.error.msg : null;
  const note =
    kind === "linear"
      ? LINEAR_NOTE
      : status?.expires_at
        ? `Token refreshes in ${formatExpiry(status.expires_at)}.`
        : null;

  return (
    <TrackerRow
      entry={entry}
      status={status}
      busy={busy}
      error={error}
      note={note}
      onDisconnect={() => void trackers.disconnect(kind)}
    />
  );
}

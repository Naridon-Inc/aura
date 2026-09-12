// Settings → Connected services.
//
// One pane where there were two. "Integrations" listed Jira, Linear and Beads
// whether or not you used any of them; "API keys" listed four model providers
// whether or not you had keys for any of them. Both were catalogues wearing an
// inventory's clothes: six cards, and reading all six was the only way to
// learn that one thing was actually connected. Worse, they answered the same
// question — what is this app hooked up to — from two different rail rows, so
// the answer depended on which one you happened to click.
//
// This pane shows what you have. The store shows what you could add, and drops
// anything you already have. That split is what makes the list worth reading:
// every row on it is a live connection, so a short list means a short answer
// rather than a page you have to scan.
//
// It is user-scoped, not project-scoped. Both halves are machine-level
// credentials — a key in `~/.aura/credentials.json`, an OAuth token in the
// keychain — and neither changes when you switch project. The one genuinely
// per-project thing, which Jira issues mirror onto which repo, stays inside
// the connected Jira row where the binding is made.

import { useCallback, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { ErrorState, LoadingState } from "../../ui/state";
import type { SettingsView } from "../../../lib/api";
import { PaneIntro } from "../kit";
import { Button } from "../../ui/button";
import { JiraDetail } from "./JiraDetail";
import { LinearDetail } from "./LinearDetail";
import { ProviderKeyControls } from "./ProviderKeys";
import { ServiceGlyph } from "./ServiceGlyph";
import { ServiceStore } from "./ServiceStore";
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

  const { connected, available } = useMemo(
    () => splitServices(facts),
    [facts],
  );

  // Connecting something moves it out of the store and into the list, so the
  // row you just acted on is gone from the screen you acted on. Leaving the
  // store is one click away and lands on the list the new connection is now
  // part of; the store itself never has to be told anything happened, because
  // `available` is derived and the row simply stops being in it.
  const leaveStore = useCallback(() => {
    setOpenId(null);
    setShopping(false);
  }, []);

  if (trackers.loading) {
    return <LoadingState label="Looking at what you're connected to…" />;
  }

  return (
    <>
      {shopping ? (
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
      ) : (
        <>
          <PaneIntro
            text={
              <>
                The model providers and issue trackers this copy of Aura can
                reach. Keys live in{" "}
                <code className="rounded bg-bg-2/60 px-1 py-px text-text-2">
                  ~/.aura/credentials.json
                </code>{" "}
                and tracker sign-ins in your keychain — never in the repo.
              </>
            }
          />

          {/* The list call is how we know what is connected. When it fails we
              know nothing, and "nothing is connected" is an answer we do not
              have. Model keys still render below: they are read from a local
              file, and a keychain read failing has no bearing on them. */}
          {trackers.loadError && (
            <div className="mb-4">
              <ErrorState
                title="Aura couldn't check your trackers."
                message={trackers.loadError}
                onRetry={() => void trackers.refresh()}
                size="sm"
              />
            </div>
          )}

          {connected.length === 0 ? (
            <div className="flex flex-col items-start gap-3 border-t border-line-soft py-8">
              <p className="text-[13px] leading-relaxed text-text-3">
                Nothing is connected yet. Aura needs at least one model
                provider to answer anything — that is the one to add first.
              </p>
              <Button size="sm" onClick={() => setShopping(true)}>
                Add a service
              </Button>
            </div>
          ) : (
            <>
              <div className="divide-y divide-line-soft border-t border-line-soft">
                {connected.map((svc) => (
                  <ConnectedRow
                    key={svc.entry.id}
                    svc={svc}
                    trackers={trackers}
                    repoRoot={repoRoot}
                    open={openId === svc.entry.id}
                    onToggle={() =>
                      setOpenId(openId === svc.entry.id ? null : svc.entry.id)
                    }
                    onChanged={onChanged}
                  />
                ))}
              </div>
              <div className="pt-5">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setOpenId(null);
                    setShopping(true);
                  }}
                >
                  Add a service
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function ConnectedRow({
  svc,
  trackers,
  repoRoot,
  open,
  onToggle,
  onChanged,
}: {
  svc: ConnectedService;
  trackers: ReturnType<typeof useTrackers>;
  repoRoot: string;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { entry, detail, active } = svc;
  const isTracker = entry.category === "tracker";
  const kind = entry.id as TrackerKind;
  const status = isTracker
    ? trackers.statuses.find((s) => s.kind === entry.id) ?? null
    : null;
  const busy = isTracker && trackers.busyKind === kind;
  const error =
    isTracker && trackers.error?.kind === kind ? trackers.error.msg : null;

  return (
    <div className="py-5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 text-left"
      >
        <ServiceGlyph id={entry.id} label={entry.label} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium leading-snug text-text-1">
              {entry.label}
            </span>
            {active && (
              <span className="rounded-full bg-accent-green/10 px-2 py-0.5 text-2xs text-accent-green">
                In use
              </span>
            )}
          </span>
          {detail && (
            <span className="truncate text-[13px] text-text-3">{detail}</span>
          )}
        </span>
        <ChevronRight
          className={`ml-auto h-4 w-4 shrink-0 text-text-4 transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="mt-4 pl-10">
          {entry.category === "model" && (
            <ProviderKeyControls
              provider={entry.id}
              label={entry.label}
              active={active}
              onChanged={onChanged}
            />
          )}
          {entry.id === "jira" && status && (
            <JiraDetail
              status={status}
              repoRoot={repoRoot}
              busy={busy}
              error={error}
              onDisconnect={() => void trackers.disconnect("jira")}
              onStatusUpdate={trackers.applyStatus}
              onError={(msg) => trackers.setError("jira", msg)}
            />
          )}
          {entry.id === "linear" && status && (
            <LinearDetail
              status={status}
              busy={busy}
              error={error}
              onDisconnect={() => void trackers.disconnect("linear")}
            />
          )}
        </div>
      )}
    </div>
  );
}

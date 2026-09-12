// The store: everything you could connect, and nothing you already have.
//
// The pane this replaced listed the catalogue as though it were an inventory
// — six cards, four of them offering to set up something you had set up
// months ago — so reading it told you almost nothing about your own machine.
// Splitting the two questions is the whole point: the list answers "what do I
// have", this answers "what else is there". A service disappears from here the
// moment it is connected, which is what makes the list above trustworthy.
//
// It is a step inside the pane, not a modal over it. A nested dialog on top of
// the settings dialog gives two Escape keys with different meanings and two
// scroll containers fighting over the wheel.

import { ArrowLeft, Plug, X } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { AuthFallback, CardError, SetupNeeded } from "./trackerParts";
import { BeadsImport } from "./BeadsImport";
import { ProviderKeyEntry } from "./ProviderKeys";
import { ServiceGlyph } from "./ServiceGlyph";
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
  /** Which row has its action expanded. Held by the pane so leaving the store
   *  and coming back does not leave a half-typed key behind. */
  openId: ServiceId | null;
  onOpen: (id: ServiceId | null) => void;
  onBack: () => void;
  onKeySaved: () => void;
}) {
  const groups = groupAvailable(available);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[13px] text-text-3 transition-colors hover:text-text-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to what's connected
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-text-3">
          You have connected everything Aura knows how to connect. More
          services arrive with new versions.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.category} className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-text-4">
              {group.label}
            </span>
            <div className="divide-y divide-line-soft border-t border-line-soft">
              {group.items.map((item) => (
                <StoreRow
                  key={item.entry.id}
                  item={item}
                  trackers={trackers}
                  repoRoot={repoRoot}
                  open={openId === item.entry.id}
                  onToggle={() =>
                    onOpen(openId === item.entry.id ? null : item.entry.id)
                  }
                  onKeySaved={onKeySaved}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function StoreRow({
  item,
  trackers,
  repoRoot,
  open,
  onToggle,
  onKeySaved,
}: {
  item: AvailableService;
  trackers: Trackers;
  repoRoot: string;
  open: boolean;
  onToggle: () => void;
  onKeySaved: () => void;
}) {
  const { entry, ready, known } = item;
  const isTracker = entry.category === "tracker";
  const kind = entry.id as TrackerKind;
  const busy = isTracker && trackers.busyKind === kind;
  const error =
    isTracker && trackers.error?.kind === kind ? trackers.error.msg : null;

  return (
    <div className="flex flex-col gap-3 py-5">
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 items-start gap-3">
          <ServiceGlyph id={entry.id} label={entry.label} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium leading-snug text-text-1">
              {entry.label}
            </span>
            <span className="text-[13px] leading-relaxed text-text-3">
              {entry.blurb}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 pt-px">
          {isTracker && (!known || !ready) ? null : isTracker ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void trackers.connect(kind)}
              >
                {busy ? (
                  <AsciiSpinner className="text-xs leading-none" />
                ) : (
                  <Plug className="h-3 w-3" />
                )}
                {busy ? "Connecting…" : "Connect"}
              </Button>
              {busy && (
                // Cancel aborts the loopback listener, so the next attempt can
                // rebind the port instead of waiting out the five-minute
                // server-side timeout. Atlassian's error pages never redirect
                // back, so without this the only way out was to wait.
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void trackers.cancel(kind)}
                >
                  <X className="h-3 w-3" />
                  Cancel
                </Button>
              )}
            </>
          ) : (
            <Button
              variant={open ? "ghost" : "secondary"}
              size="sm"
              onClick={onToggle}
            >
              {open
                ? "Cancel"
                : entry.category === "import"
                  ? "Import…"
                  : "Add key"}
            </Button>
          )}
        </div>
      </div>

      {isTracker && !known && (
        // The list call is how we know whether this machine has an app for
        // the tracker. When it fails, "Not set up here" would be us reporting
        // something we did not find out — the same lie as drawing an empty
        // list over a request still in flight.
        <p className="text-sm text-text-4">
          Aura couldn't check whether {entry.label} is set up on this machine.
          Retry from the list, then come back.
        </p>
      )}

      {isTracker && known && !ready && (
        <SetupNeeded
          what={entry.label}
          where={TRACKER_HOME[kind]}
          block={entry.id}
        />
      )}

      {open && entry.category === "model" && (
        <ProviderKeyEntry
          provider={entry.id}
          label={entry.label}
          onSaved={onKeySaved}
          onCancel={onToggle}
        />
      )}

      {open && entry.category === "import" && (
        <BeadsImport repoRoot={repoRoot} />
      )}

      {busy && trackers.fallbackUrl && (
        <AuthFallback url={trackers.fallbackUrl} />
      )}

      {error && <CardError msg={error} />}
    </div>
  );
}

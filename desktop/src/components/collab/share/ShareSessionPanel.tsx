// ShareSessionPanel — turning a session you are running into one your teammates
// can be inside.
//
// Two honesty rules shape everything here, and both come straight out of
// `docs/collab/SESSION_LIVE_PROTOCOL.md`:
//
//  1. THE LINK IS NOT THE KEY. The live socket refuses anonymous connections
//     outright — "there is no anonymous mode and no code-possession mode on
//     this endpoint". Whoever opens the link is checked against the team that
//     owns the session before a single frame moves. So this panel never says
//     "anyone with this link"; it says who can get in, by name, above the link
//     itself. Getting that sentence wrong is how someone pastes a link into a
//     public channel believing it is inert.
//  2. THEY ARE ON YOUR MACHINE. A guest who can drive instructs an agent that
//     is running here, on these files. That is the whole point of the feature
//     and it is also the part people underestimate, so it is stated in the
//     summary before they share, not discovered afterwards.

import { useState, type JSX } from "react";
import { Link2, Users } from "lucide-react";

import { Button } from "../../ui/button";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { SegmentedControl } from "../../ui/segmented";
import { EmptyState, ErrorState, LoadingState } from "../../ui/state";
import { CopyField } from "./CopyField";
import { WhoCanJoin } from "./SecurityNotes";
import { ParticipantAccessList } from "./ParticipantAccessList";
import { AccessGlyph } from "./AccessLevelMenu";
import {
  ACCESS_LEVELS,
  ACCESS_META,
  type AccessLevel,
  type SharedSession,
} from "./shareTypes";

export type ShareSessionPanelProps = {
  /** The session once it is shared. `null` means it is still private. */
  session: SharedSession | null;
  /** The repo whose people would be let in, known before anything is shared. */
  repoName: string;
  /** True while we're finding out whether this session is already shared. */
  loading: boolean;
  /** Whatever stopped us, shown verbatim. */
  error: string | null;
  onRetry: () => void;
  /** Open the session up. Resolves once the link and code exist. */
  onShare: (defaultAccess: AccessLevel) => Promise<void> | void;
  /** Close it. Everyone currently inside is disconnected. */
  onStopSharing: () => Promise<void> | void;
  /** Change what the next person to arrive gets. */
  onDefaultAccessChange: (level: AccessLevel) => void;
  /** Change one person's level, live. */
  onAccessChange: (participantId: string, level: AccessLevel) => void;
  /** Your own participant id, so the list can say "You". */
  youId: string;
  savingIds?: string[];
};

export function ShareSessionPanel({
  session,
  repoName,
  loading,
  error,
  onRetry,
  onShare,
  onStopSharing,
  onDefaultAccessChange,
  onAccessChange,
  youId,
  savingIds,
}: ShareSessionPanelProps): JSX.Element {
  const [pendingAccess, setPendingAccess] = useState<AccessLevel>("watch");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(fn: () => Promise<void> | void) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <LoadingState size="md" label="Checking who can reach this session…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} size="md" />;
  }

  // ── Still private ───────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex flex-col gap-5">
        <EmptyState
          icon={Users}
          title="Only you are in this session"
          body="Open it up and a teammate can watch the agents work, or take a turn themselves, on this machine."
          size="md"
        />

        <div className="flex flex-col gap-2.5">
          <span className="text-xs font-medium text-text-4">
            What someone gets when they arrive
          </span>
          <SegmentedControl<AccessLevel>
            value={pendingAccess}
            onChange={setPendingAccess}
            ariaLabel="What someone gets when they arrive"
            options={ACCESS_LEVELS.map((l) => ({
              value: l,
              label: ACCESS_META[l].label,
            }))}
          />
          <p className="text-xs leading-snug text-text-4">
            {ACCESS_META[pendingAccess].hostBlurb} You can change this for any
            one person once they&apos;re in.
          </p>
        </div>

        <WhoCanJoin repoName={repoName} />

        <Button
          variant="accentSoft"
          onClick={() => void run(() => onShare(pendingAccess))}
          disabled={busy}
          className="w-full"
        >
          {busy ? <AsciiSpinner /> : <Link2 size={14} />}
          Let teammates in
        </Button>

        {actionError && (
          <p role="alert" className="text-sm leading-snug text-red">
            {actionError}
          </p>
        )}
      </div>
    );
  }

  // ── Shared ──────────────────────────────────────────────────────────────
  const humans = session.participants.filter((p) => p.kind === "human").length;

  return (
    <div className="flex flex-col gap-5">
      <CopyField
        label="Link"
        value={session.link}
        hint={`Opens straight into this session for anyone who works on ${session.repoName}. Everyone else is turned away, link or no link.`}
      />

      <CopyField
        label="Or read them this code"
        value={session.code}
        code
        hint="Six characters, typed into Join. Same check on the other side. The code is how they find the session, not how they get in."
      />

      <WhoCanJoin repoName={session.repoName} />

      {/* What the next arrival gets. Separate from the per-person control
          below, because "the default" and "Shahabas specifically" are two
          different decisions and merging them means changing one by accident. */}
      <div className="flex items-center justify-between gap-3 border-t border-line-soft pt-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-4">
            New arrivals start as
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-text-3">
            <AccessGlyph
              level={session.defaultAccess}
              size={12}
              className="text-text-4"
            />
            {ACCESS_META[session.defaultAccess].hostBlurb}
          </p>
        </div>
        <SegmentedControl<AccessLevel>
          value={session.defaultAccess}
          onChange={onDefaultAccessChange}
          ariaLabel="What new arrivals start as"
          options={ACCESS_LEVELS.map((l) => ({
            value: l,
            label: ACCESS_META[l].label,
          }))}
          className="shrink-0"
        />
      </div>

      <section className="flex flex-col gap-1 border-t border-line-soft pt-4">
        <h3 className="text-xs font-medium text-text-4">
          In this session
          {humans > 0 && (
            <span className="ml-1.5 font-normal text-text-5">
              · {humans === 1 ? "just you so far" : `${humans} people`}
            </span>
          )}
        </h3>
        <ParticipantAccessList
          session={session}
          youId={youId}
          canManage
          onAccessChange={onAccessChange}
          savingIds={savingIds}
        />
      </section>

      <section className="flex items-center justify-between gap-3 border-t border-line-soft pt-4">
        <p className="min-w-0 text-sm leading-snug text-text-3">
          Closing it disconnects everyone and makes the link and the code stop
          working. Your session keeps running here.
        </p>
        <Button
          variant="subtle"
          size="sm"
          className="shrink-0"
          onClick={() => void run(onStopSharing)}
          disabled={busy}
        >
          {busy ? <AsciiSpinner size={12} /> : null}
          Stop sharing
        </Button>
      </section>

      {actionError && (
        <p role="alert" className="text-sm leading-snug text-red">
          {actionError}
        </p>
      )}
    </div>
  );
}

// JoinSessionPanel — the other end of Share. Type a code (or paste the link),
// see what you're walking into, then walk in.
//
// The preview step is not decoration. Joining a session means someone else's
// agents, someone else's files, and — if you can drive — your words running on
// their machine. Being told all three before you press Join, rather than after,
// is the difference between collaborating and being dropped somewhere.
//
// Every way this can fail gets its own sentence and its own verdict on whether
// trying again is worth anything (see `joinFailureCopy`). "You're not in this
// team" is not a transient error and must never offer a retry button — the
// person would sit there retyping a code that was always going to be refused.

import { useState, type JSX } from "react";
import { CircleAlert, FolderGit2, LogIn, Server, User, Users } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsMemberRow } from "../../ui/settings-team-members";
import { EmptyState, ErrorNote, LoadingState } from "../../ui/state";
import { Avatar } from "../../team/presentation/Avatar";
import { AccessGlyph } from "./AccessLevelMenu";
import { JoinFailureNotice } from "./JoinFailureNotice";
import { ACCESS_META, type JoinFailure, type JoinPreview } from "./shareTypes";
import "../../ui/cloud-patterns.css";
import "../../ui/join-session.css";

/** Take whatever someone pasted and find the code in it. People paste the whole
 *  link as often as they type the six characters, and rejecting a valid link
 *  because it isn't a bare code is a self-inflicted dead end. */
export function extractJoinCode(input: string): string {
  const text = input.trim();
  const fromLink = /(?:\/join\/|\/s\/|[?&]code=)([A-Za-z0-9]{4,12})/.exec(text);
  if (fromLink) return fromLink[1].toLowerCase();
  return text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export type JoinSessionPanelProps = {
  /** What we found for the code that was looked up. `null` until there is one. */
  preview: JoinPreview | null;
  /** True while a lookup is in flight. */
  looking: boolean;
  /** Why the lookup didn't produce a preview. */
  failure: JoinFailure | null;
  /** Look up a code. The caller resolves it to a preview, a failure, or throws. */
  onLookup: (code: string) => Promise<void> | void;
  /** Actually join the previewed session. */
  onJoin: (externalId: string) => Promise<void> | void;
  /** Clear the current preview/failure and go back to the code box. */
  onReset: () => void;
};

export function JoinSessionPanel({
  preview,
  looking,
  failure,
  onLookup,
  onJoin,
  onReset,
}: JoinSessionPanelProps): JSX.Element {
  const [raw, setRaw] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const code = extractJoinCode(raw);

  // Leaving a preview leaves its join error behind with it. Kept, it would
  // sit under the NEXT session you look up, blaming that one for a join that
  // never touched it.
  function reset() {
    setJoinError(null);
    onReset();
  }

  async function join() {
    if (!preview || joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      await onJoin(preview.externalId);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }

  // ── Something went wrong ────────────────────────────────────────────────
  if (failure) {
    return (
      <JoinFailureNotice
        failure={failure}
        onTryAnother={() => {
          setRaw("");
          reset();
        }}
        onBack={reset}
      />
    );
  }

  // ── Found it — here's what you're joining ───────────────────────────────
  if (preview) {
    const others = preview.participants.filter((p) => p.kind === "human");
    const agents = preview.participants.filter((p) => p.kind === "agent");
    const meta = ACCESS_META[preview.yourAccess];

    return (
      <div className="ui-join-session">
        <div className="ui-cloud-details">
          <header>
            <strong title={preview.title}>{preview.title}</strong>
          </header>
          {/* Whose machine, which machine, which project, and what you can
              do once you are in: the four things to know before walking in. */}
          <dl className="ui-cloud-resource-table">
            <dt>
              <User />
              Host
            </dt>
            <dd>{preview.hostName}</dd>
            <dt>
              <Server />
              Machine
            </dt>
            <dd>{preview.hostMachine}</dd>
            {preview.repoName && (
              <>
                <dt>
                  <FolderGit2 />
                  Repository
                </dt>
                <dd>{preview.repoName}</dd>
              </>
            )}
            <dt>
              <AccessGlyph level={preview.yourAccess} />
              Your access
            </dt>
            <dd>
              <strong>{meta.label}</strong>
            </dd>
          </dl>
          <p className="ui-cloud-note">{meta.guestBlurb}</p>

          <section>
            <div className="ui-cloud-row">
              <strong>Already in there</strong>
              {preview.participants.length > 0 && (
                <span className="ui-join-session-count">
                  {others.length === 1 ? "1 person" : `${others.length} people`}
                  {agents.length > 0 &&
                    `, and ${agents.length === 1 ? "1 agent" : `${agents.length} agents`} working`}
                </span>
              )}
            </div>
            {preview.participants.length === 0 ? (
              <p>Nobody yet. You&apos;d be the first in.</p>
            ) : (
              preview.participants.map((p) => (
                <SettingsMemberRow
                  key={p.id}
                  avatar={
                    <Avatar
                      name={p.name}
                      src={p.avatar}
                      size={26}
                      shape={p.kind === "agent" ? "rounded" : "circle"}
                      title=""
                    />
                  }
                  name={p.name}
                  detail={p.kind === "agent" ? "Agent" : p.role === "host" ? "Host" : "Person"}
                />
              ))
            )}
          </section>
        </div>

        {/* Host offline is a caution, not a wall: the session stays open and
            what you send is kept until they're back. */}
        {!preview.hostOnline && (
          <Alert role="status">
            <AlertTitle>
              <CircleAlert size={13} aria-hidden />
              {preview.hostName} isn&apos;t at their machine right now
            </AlertTitle>
            <AlertDescription>
              Nothing will run yet. You can still go in and read what happened. Anything you
              send waits for them.
            </AlertDescription>
          </Alert>
        )}

        {joinError && <ErrorNote>{joinError}</ErrorNote>}

        <div className="ui-pattern-actions">
          <Button variant="ghost" onClick={reset} disabled={joining}>
            Back
          </Button>
          <Button onClick={() => void join()} disabled={joining}>
            {joining ? <AsciiSpinner /> : <LogIn />}
            Join this session
          </Button>
        </div>
      </div>
    );
  }

  // ── Looking it up ───────────────────────────────────────────────────────
  if (looking) {
    return <LoadingState size="md" label="Finding that session…" />;
  }

  // ── The code box ────────────────────────────────────────────────────────
  return (
    <div className="ui-join-session">
      <EmptyState
        icon={Users}
        title="Join someone's session"
        body="Paste the link a teammate sent you, or type the six-character code they read out."
        size="sm"
      />

      <form
        className="ui-cloud-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (code) void onLookup(code);
        }}
      >
        <Input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Code or link"
          aria-label="Session code or link"
          autoFocus
        />
        <Button type="submit" disabled={!code}>
          Look it up
        </Button>
      </form>

      <p className="ui-cloud-note">
        You&apos;ll see what the session is and who&apos;s in it before you join anything. Aura
        checks your account against the team that owns it. You can only get into sessions
        belonging to a team you&apos;re part of.
      </p>
    </div>
  );
}

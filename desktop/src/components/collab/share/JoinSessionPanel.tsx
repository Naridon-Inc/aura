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
import { CircleAlert, LogIn, Users } from "lucide-react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { EmptyState } from "../../ui/state";
import { Avatar } from "../../team/presentation/Avatar";
import { AccessGlyph } from "./AccessLevelMenu";
import { JoinFailureNotice } from "./JoinFailureNotice";
import { ACCESS_META, type JoinFailure, type JoinPreview } from "./shareTypes";

/** Take whatever someone pasted and find the code in it. People paste the whole
 *  link as often as they type the six characters, and rejecting a valid link
 *  because it isn't a bare code is a self-inflicted dead end. */
export function extractJoinCode(input: string): string {
  const text = input.trim();
  const fromLink = /(?:\/join\/|[?&]code=)([A-Za-z0-9]{4,12})/.exec(text);
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
          onReset();
        }}
        onBack={onReset}
      />
    );
  }

  // ── Found it — here's what you're joining ───────────────────────────────
  if (preview) {
    const others = preview.participants.filter((p) => p.kind === "human");
    const agents = preview.participants.filter((p) => p.kind === "agent");
    const meta = ACCESS_META[preview.yourAccess];

    return (
      <div className="flex flex-col gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-4">You&apos;re joining</p>
          <p className="mt-1 text-lg font-semibold leading-snug text-text-1">
            {preview.title}
          </p>
          <p className="mt-1 text-sm leading-snug text-text-3">
            Running on {preview.hostName}&apos;s machine ({preview.hostMachine})
            {preview.repoName ? ` · ${preview.repoName}` : ""}
          </p>
        </div>

        <section className="flex flex-col gap-2 border-t border-line-soft pt-3.5">
          <h3 className="text-xs font-medium text-text-4">Already in there</h3>
          {preview.participants.length === 0 ? (
            <p className="text-sm text-text-3">
              Nobody yet. You&apos;d be the first in.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {preview.participants.map((p) => (
                  <span
                    key={p.id}
                    className="flex items-center gap-1.5 text-sm text-text-2"
                  >
                    <Avatar
                      name={p.name}
                      src={p.avatar}
                      size={22}
                      shape={p.kind === "agent" ? "rounded" : "circle"}
                    />
                    {p.name}
                  </span>
                ))}
              </div>
              <p className="text-xs text-text-4">
                {others.length === 1 ? "1 person" : `${others.length} people`}
                {agents.length > 0 &&
                  `, and ${agents.length === 1 ? "1 agent" : `${agents.length} agents`} working`}
                .
              </p>
            </>
          )}
        </section>

        <section className="flex items-start gap-2.5 border-t border-line-soft pt-3.5">
          <AccessGlyph
            level={preview.yourAccess}
            size={14}
            className={`mt-0.5 shrink-0 ${
              preview.yourAccess === "drive" ? "text-accent" : "text-text-3"
            }`}
          />
          <p className="min-w-0 text-sm leading-snug text-text-3">
            <span className="font-medium text-text-2">{meta.label}.</span>{" "}
            {meta.guestBlurb}
          </p>
        </section>

        {/* Host offline is a caution, not a wall: the session stays open and
            what you send is kept until they're back. */}
        {!preview.hostOnline && (
          <p className="flex items-start gap-2 text-sm leading-snug text-amber">
            <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
            {preview.hostName} isn&apos;t at their machine right now, so nothing
            will run yet. You can still go in and read what happened. Anything
            you send waits for them.
          </p>
        )}

        {joinError && (
          <p role="alert" className="text-sm leading-snug text-red">
            {joinError}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            variant="accentSoft"
            onClick={() => void join()}
            disabled={joining}
            className="flex-1"
          >
            {joining ? <AsciiSpinner /> : <LogIn size={14} />}
            Join this session
          </Button>
          <Button variant="ghost" onClick={onReset} disabled={joining}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  // ── Looking it up ───────────────────────────────────────────────────────
  if (looking) {
    return (
      <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
        <AsciiSpinner className="text-base" />
        <p className="text-base text-text-3">Finding that session…</p>
      </div>
    );
  }

  // ── The code box ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <EmptyState
        icon={Users}
        title="Join someone's session"
        body="Paste the link a teammate sent you, or type the six-character code they read out."
        size="sm"
      />

      <form
        className="flex items-center gap-2"
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
          className="font-mono text-base"
        />
        <Button type="submit" variant="accentSoft" disabled={!code}>
          Look it up
        </Button>
      </form>

      <p className="text-xs leading-snug text-text-4">
        You&apos;ll see what the session is and who&apos;s in it before you join
        anything. Aura checks your account against the team that owns it. You
        can only get into sessions belonging to a team you&apos;re part of.
      </p>
    </div>
  );
}

// One repo's "this is me" row.
//
// Plain language for non-engineers (the app's audience): we say "team",
// "you", "this project" — never "roster", "override", "alias", or "AST".
// The mechanism (per-repo identity pin, deterministic email alias) is
// real, but it stays under the hood.
//
// States, by `confusion`:
//   clear         → quiet "You're @handle ✓" with a subtle "Not you?"
//   needs_confirm → "We think you're @best_guess." + This is me / Pick someone
//   unclaimed     → same prompt without a strong guess
//   not_on_roster → adds an "I'm new — add me" action

import * as React from "react";

import { Button } from "../ui/button";
import { Select, type SelectOption } from "../ui/select";
import { Avatar } from "../team/presentation/Avatar";
import {
  identityOverrideClear,
  identityOverrideSet,
  teamAliasAdd,
  teamClaim,
  type IdentityStatus,
  type RosterLite,
} from "../../lib/identityApi";

type IdentityRepoRowProps = {
  status: IdentityStatus;
  /** Re-fetch this repo's status after any mutation. */
  onChanged: () => void | Promise<void>;
};

export function IdentityRepoRow({ status, onChanged }: IdentityRepoRowProps) {
  const [busy, setBusy] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [pick, setPick] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await onChanged();
        setPicking(false);
        setPick("");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  // "This is me": take the seat, then link the local git email to the
  // resulting handle so a future open recognises this machine silently.
  const confirmMe = React.useCallback(() => {
    void run(async () => {
      await teamClaim(status.repo_root);
      const handle = status.best_guess ?? status.effective_handle;
      if (handle && status.email) {
        // Best-effort: the seat is claimed even if the alias link is
        // refused (e.g. the email already belongs to someone else).
        try {
          await teamAliasAdd(status.repo_root, handle, status.email);
        } catch {
          /* keep the claim; alias is an optimisation, not a requirement */
        }
      }
    });
  }, [run, status.repo_root, status.best_guess, status.effective_handle, status.email]);

  // "I'm new — add me": claim creates the seat for an unknown email.
  const addMe = React.useCallback(() => {
    void run(() => teamClaim(status.repo_root));
  }, [run, status.repo_root]);

  // "Pick someone else" → choose a teammate → pin them for this repo.
  const choosePerson = React.useCallback(
    (handle: string) => {
      const member = status.candidates.find((c) => c.handle === handle);
      if (!member) return;
      void run(() =>
        identityOverrideSet({
          repoRoot: status.repo_root,
          handle: member.handle,
          name: member.name,
          email: status.email,
        }),
      );
    },
    [run, status.candidates, status.repo_root, status.email],
  );

  // "Not you? Change" on an already-settled repo: clear the pin and open
  // the picker so the user can pick someone else.
  const resetPin = React.useCallback(() => {
    void run(() => identityOverrideClear(status.repo_root));
  }, [run, status.repo_root]);

  // Git may simply have no email for you here — a fresh machine, or a repo
  // nobody configured. That is not the same as "we don't recognise this
  // email": there is no email to recognise, and the row used to say both at
  // once. It also matters for the actions. `team_claim` reads
  // `git config user.email` and answers "git user.email is not configured for
  // this repo", so This is me / I'm new can only fail. Picking a teammate
  // still works — a pin is stored against the project, not the email.
  const noEmail = !status.email?.trim();

  const options: SelectOption[] = status.candidates.map((c) => ({
    value: c.handle,
    label: <CandidateLabel member={c} />,
    icon: <Avatar name={c.name || c.handle} size={18} />,
  }));

  const settled = status.confusion === "clear";

  return (
    // A repo is a settings row, not a card: the pane it lives in is a
    // ruled list and a bordered box per project made five projects read as
    // five separate panels. Same 28px rhythm, same 14/13 scale.
    <div className="flex flex-col gap-2 py-7">
      {/* header: project + committing-as */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-text-1 truncate">
          {status.repo_name}
        </span>
        <span className="text-[13px] text-text-3 truncate">
          {/* "Committing as an unset git email" filled the value slot with a
              description of the hole. It reads like an address until you
              finish the sentence, and it names nothing to do about it. */}
          {noEmail ? "No git email set here" : `Committing as ${status.email}`}
        </span>
      </div>

      {/* verdict line */}
      {settled ? (
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-[13px] text-text-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-accent-green"
              aria-hidden
            />
            You&apos;re @{status.effective_handle}
          </span>
          {!picking && (
            <button
              type="button"
              onClick={() => setPicking(true)}
              disabled={busy}
              className="text-[13px] text-text-3 hover:text-text-1 transition-colors disabled:opacity-50"
            >
              Not you? Change
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-text-2 leading-relaxed">
            {noEmail ? (
              status.candidates.length > 0 ? (
                <>
                  Git has no email for you in this project, so Aura can&apos;t
                  tell which teammate you are here. Pick yourself and it will
                  remember.
                </>
              ) : (
                <>
                  Git has no email for you in this project, and nobody has
                  joined this project&apos;s team yet — so there&apos;s nobody to
                  match you to.
                </>
              )
            ) : status.confusion === "not_on_roster" ? (
              <>We don&apos;t recognise this email on your team yet.</>
            ) : status.best_guess ? (
              <>
                We think you&apos;re{" "}
                <span className="text-text-1 font-medium">
                  @{status.best_guess}
                </span>{" "}
                in this project.
              </>
            ) : (
              <>Confirm who you are in this project.</>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Both of these claim a seat keyed on the git email, so with no
                email they are buttons whose only outcome is an error. */}
            {!noEmail && status.confusion !== "not_on_roster" && (
              <Button size="xs" onClick={confirmMe} disabled={busy}>
                This is me
              </Button>
            )}
            {!noEmail && status.confusion === "not_on_roster" && (
              <Button size="xs" onClick={addMe} disabled={busy}>
                I&apos;m new. Add me
              </Button>
            )}
            {!picking && status.candidates.length > 0 && (
              <Button
                size="xs"
                // With no git email this is the only thing left that works,
                // and the only action in a row shouldn't read as the
                // secondary one.
                variant={noEmail ? "default" : "subtle"}
                onClick={() => setPicking(true)}
                disabled={busy}
              >
                {noEmail ? "Pick who you are" : "Pick someone else"}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* picker — shared by the settled "Change" path and the unsettled
          "Pick someone else" path */}
      {picking && (
        <div className="flex flex-col gap-2 pt-1">
          <Select
            value={pick}
            onChange={(v) => {
              setPick(v);
              choosePerson(v);
            }}
            options={options}
            placeholder="Choose your teammate…"
            disabled={busy}
            aria-label="Choose who you are in this project"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setPicking(false);
                setPick("");
              }}
              disabled={busy}
              className="text-[13px] text-text-3 hover:text-text-1 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            {settled && (
              <button
                type="button"
                onClick={resetPin}
                disabled={busy}
                className="text-[13px] text-text-3 hover:text-text-1 transition-colors disabled:opacity-50"
              >
                Use my git email instead
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="text-[13px] text-text-3" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CandidateLabel({ member }: { member: RosterLite }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-text-1">@{member.handle}</span>
      {member.name && (
        <span className="text-text-3 truncate">{member.name}</span>
      )}
    </span>
  );
}

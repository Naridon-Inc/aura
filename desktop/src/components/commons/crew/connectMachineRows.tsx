// The connect-a-machine wizard's status lines: one fact the machine reported,
// with a tick, a spinner or a warning in front of it.

import { CircleAlert, CircleCheck } from "lucide-react";
import type { MemberAccount } from "../../../lib/api";
import { warmSentence, warmShortfall, type BaseBuild } from "../../../lib/place";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import "../../ui/connect-machine.css";

export function StatusRow({
  ok,
  spinner,
  alert,
  text,
}: {
  ok?: boolean;
  spinner?: boolean;
  alert?: boolean;
  text: string;
}) {
  return (
    <div
      className="ui-connect-machine-status"
      data-tone={alert ? "alert" : ok ? "ok" : undefined}
      role={spinner ? "status" : undefined}
    >
      {spinner ? (
        <AsciiSpinner />
      ) : ok ? (
        <CircleCheck size={14} />
      ) : alert ? (
        <CircleAlert size={14} />
      ) : null}
      <span>{text}</span>
    </div>
  );
}

/**
 * What the box said about this member's own account.
 *
 * Every line is read back off the machine rather than inferred from what we
 * asked for. "Your home is closed to everyone else" because a `chmod` was sent
 * is not the same claim as because the box then said `drwx------`, and on this
 * screen only the second one is worth making — the whole promise is that a
 * teammate cannot read your credentials, and a promise nobody checked is how
 * that stops being true quietly.
 */
export function AccountRows({ account }: { account: MemberAccount }) {
  return (
    <div className="ui-connect-machine-rows">
      <StatusRow
        ok
        text={
          account.created
            ? `Made you an account of your own here: ${account.login}.`
            : `You already had an account here: ${account.login}.`
        }
      />
      {account.private ? (
        <StatusRow ok text="Your home directory is closed to everyone else on this machine." />
      ) : (
        <StatusRow
          alert
          text={`Aura couldn't close ${account.home} to the other people on this machine. Anything it holds may be readable by them.`}
        />
      )}
      {!account.umask && (
        <StatusRow
          alert
          text="Files you create here later may be readable by the others — Aura couldn't set a umask in your profile."
        />
      )}
      {account.linger === "off" && (
        <StatusRow
          alert
          text="Your runner won't come back on its own after a reboot until someone with root on this machine turns lingering on for you."
        />
      )}
      {account.linger === "unavailable" && (
        <StatusRow
          alert
          text="This machine has no systemd user services, so your runner can only run while you're logged in."
        />
      )}
      {account.key === "absent" && (
        <StatusRow
          alert
          text={`Nothing was installed to let you in as ${account.login} directly, so you'll keep arriving through the login you connected with.`}
        />
      )}
      {account.swap === "added" && (
        <StatusRow
          ok
          text="Added swap to this machine, so a build that runs out of memory slows down instead of taking the box with it."
        />
      )}
      {account.swap === "none" && (
        <StatusRow
          alert
          text="This machine has no swap and Aura couldn't add any. Your runner still has a memory limit, but a build that reaches it will be killed rather than slowed."
        />
      )}
    </div>
  );
}

/** What joining this place cost — the install this member paid, or the one
 *  somebody already paid for them.
 *
 *  Quiet when there is nothing to report. A machine the team has never built an
 *  environment on has no news here, and a row saying so would be a line about
 *  something not happening on every first connection anybody ever makes. The
 *  shortfall is a row of its own because it fails apart from the good news: a
 *  home that looks warm and is short otherwise announces itself in the middle of
 *  a build. */
export function WarmRows({
  warm,
  problem,
}: {
  warm: BaseBuild | null;
  problem: string | null;
}) {
  if (problem) {
    return <StatusRow alert text={problem} />;
  }
  if (!warm) return null;
  // Nothing built, nothing copied, nobody waiting — the first person on a box
  // whose project declares no environment. True, and not worth a line.
  if (!warm.start.warm && warm.already_built && !warm.start.refused) return null;
  const short = warmShortfall(warm.start);
  return (
    <>
      <StatusRow
        ok={!warm.start.refused}
        alert={!!warm.start.refused}
        text={warmSentence(warm)}
      />
      {short && <StatusRow alert text={short} />}
    </>
  );
}

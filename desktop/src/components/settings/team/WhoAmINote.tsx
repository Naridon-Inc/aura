import { type TeamIdentity } from "../../../lib/api";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/settings-row";

/** What the roster says when Aura cannot point at a row and say "that one is
 *  you".
 *
 *  On a machine whose git has no `user.email`, the roster read two members,
 *  one an admin, neither marked as you. Asking `identity?.admin ?? false`
 *  gets a truthful answer to a question never asked out loud: we don't know
 *  who you are. So the reader is told they lack a permission, when what
 *  actually happened is that Aura never found their row.
 *
 *  `in_team` is exactly the difference between "you're a member, not an
 *  admin" and "we couldn't match you". */
export function WhoAmINote({ identity }: { identity: TeamIdentity | null }) {
  if (identity?.in_team) return null;
  const email = (identity?.email ?? "").trim();
  const why =
    identity === null ? (
      <>Aura couldn’t work out who you are in this repository, so nothing below is matched to you.</>
    ) : email ? (
      <>
        Nobody here signs work as <code>{email}</code>, so none of these rows is you.
      </>
    ) : (
      <>
        This machine hasn’t set the name and email it signs work with, so Aura can’t tell
        which of these people is you.
      </>
    );
  return (
    <SettingsRow
      title="Which one is you?"
      description={
        <>
          {why} Anything only your own row can do stays switched off until it can.
        </>
      }
      control={
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("aura:open-settings", {
                detail: { pane: "identity" },
              }),
            )
          }
        >
          Say which one is you
        </Button>
      }
    />
  );
}

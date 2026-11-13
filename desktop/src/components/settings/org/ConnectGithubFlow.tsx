// Connecting another GitHub account or organization, from Settings →
// Organization. A round trip through GitHub: install the app on the account
// (GitHub's page picks which repositories), sign in to GitHub so Aura can see
// which accounts you may connect, then pick one. Only an owner or admin gets
// here; the server checks again. The trip itself is useConnectGithub.

import { Plus } from "lucide-react";

import { candidateLine, candidateState } from "../../../lib/cloudGithub";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/settings-row";
import { ErrorNote, LoadingState } from "../../ui/state";
import { useConnectGithub } from "./useConnectGithub";

export function ConnectGithubFlow({ first, onConnected }: { first: boolean; onConnected: (note: string) => void }) {
  const { phase, error, connecting, begin, signIn, reopen, connect, cancel } = useConnectGithub(onConnected);

  const note = error && <ErrorNote>{error}</ErrorNote>;

  if (phase.at === "idle" || phase.at === "starting") {
    return (
      <>
        {note}
        <SettingsRow
          title={first ? "Connect GitHub" : "Another account"}
          description="Repositories in a GitHub account or organization you connect can run on this organization’s cloud."
          control={
            <Button size="sm" variant="secondary" disabled={phase.at === "starting"} onClick={begin}>
              <Plus />
              {first ? "Connect a GitHub account or organization" : "Connect another GitHub account or organization"}
            </Button>
          }
        />
      </>
    );
  }

  if (phase.at === "installing") {
    const { start } = phase;
    return (
      <>
        {note}
        <SettingsRow
          title="Install the app on GitHub"
          description="Pick the account or organization, and which of its repositories Aura may use. If the app is already there, go straight to Continue."
          control={
            <span className="ui-pattern-actions">
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              {start.install_url && (
                <Button size="sm" variant="secondary" onClick={() => reopen(start.install_url as string)}>
                  Open GitHub again
                </Button>
              )}
              <Button size="sm" onClick={() => signIn(start)}>
                Continue
              </Button>
            </span>
          }
        />
      </>
    );
  }

  if (phase.at === "signing_in") {
    const { start } = phase;
    return (
      <>
        {note}
        <SettingsRow
          title="Sign in to GitHub"
          description={<LoadingState label="Waiting for GitHub to say which accounts you can connect…" />}
          control={
            <span className="ui-pattern-actions">
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" onClick={() => signIn(start)}>
                Sign in again
              </Button>
            </span>
          }
        />
      </>
    );
  }

  const { start, ticket } = phase;
  if (ticket.status !== "answered") {
    return (
      <>
        <ErrorNote>
          {ticket.status === "expired" ? "This took too long. Start connecting again." : ticket.problem || "GitHub didn’t answer."}
        </ErrorNote>
        <SettingsRow
          title="Connect GitHub"
          control={
            <span className="ui-pattern-actions">
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" onClick={begin}>
                Start again
              </Button>
            </span>
          }
        />
      </>
    );
  }

  return (
    <>
      {note}
      {ticket.candidates.length === 0 && (
        <SettingsRow
          title="No account with the app yet"
          description="GitHub didn’t list any account or organization of yours with the app installed. Install it there first."
          control={
            <Button size="sm" variant="secondary" onClick={begin}>
              Start again
            </Button>
          }
        />
      )}
      {ticket.candidates.map((c) => {
        const { connectable, note: why } = candidateState(c);
        const line = candidateLine(c);
        return (
          <SettingsRow
            key={c.id}
            title={c.account_login}
            description={[line, why].filter(Boolean).join(" · ") || undefined}
            control={
              connectable ? (
                <Button size="sm" disabled={connecting !== null} onClick={() => connect(start, c.id)}>
                  {connecting === c.id ? "Connecting…" : "Connect"}
                </Button>
              ) : null
            }
          />
        );
      })}
      <SettingsRow
        title="Not listed?"
        description="Install the app on that account on GitHub, then start again."
        control={
          <span className="ui-pattern-actions">
            <Button size="sm" variant="ghost" onClick={cancel}>
              Done
            </Button>
            <Button size="sm" variant="secondary" onClick={begin}>
              Start again
            </Button>
          </span>
        }
      />
    </>
  );
}

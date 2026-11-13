// Settings → Git → Your GitHub: the GitHub account a member's cloud work goes
// out as. Pushes, commits and pull requests made in a cloud workspace use it,
// and the member only starts cloud workspaces on repositories it can open.
//
// Connecting is a GitHub sign-in in the browser; the row asks the server what
// GitHub answered until it has. The token stays on the server.

import { useCallback, useEffect, useState } from "react";

import { useCloudAuthStatus } from "../../lib/cloudAuthCache";
import {
  disconnectMyGithub,
  myGithubLine,
  myTicketProblem,
  myTicketSettled,
  readMyGithub,
  readMyGithubRepos,
  readMyGithubTicket,
  startMyGithubConnect,
  type MyGithub,
  type MyGithubStart,
} from "../../lib/cloudMyGithub";
import { messageOf } from "../../lib/cloudOrgs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
import { ErrorNote, LoadingState } from "../ui/state";

const ASK_EVERY_MS = 2000;

async function open(url: string) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** How many of the organization's repositories the account opens, said once. */
function reachLine(count: number | null): string | null {
  if (count === null) return null;
  if (count === 0) return "It can’t open any of this organization’s repositories yet.";
  return count === 1 ? "Opens 1 of this organization’s repositories." : `Opens ${count} of this organization’s repositories.`;
}

export function YourGithubSection() {
  const authState = useCloudAuthStatus();
  const auth = authState.data;
  const signedIn = !!auth?.connected;
  const [me, setMe] = useState<MyGithub | null>(null);
  const [reach, setReach] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [waiting, setWaiting] = useState<MyGithubStart | null>(null);
  const [asked, setAsked] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(() => {
    readMyGithub()
      .then((m) => {
        setMe(m);
        setError(null);
        if (!m.connected) return setReach(null);
        // Which repositories it opens needs an organization; without one the
        // row just says who is connected.
        readMyGithubRepos()
          .then((r) => setReach(r.repos ? r.repos.length : null))
          .catch(() => setReach(null));
      })
      .catch((e: unknown) => {
        setMe((m) => m ?? { connected: false, login: null, linked_at: null });
        setError(messageOf(e));
      });
  }, []);
  useEffect(() => {
    if (signedIn) load();
  }, [signedIn, auth?.user, auth?.org_slug, load]);

  // While the member signs in on GitHub, ask the server what GitHub said.
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const ask = () =>
      readMyGithubTicket(waiting.ticket)
        .then((t) => {
          if (stopped || !myTicketSettled(t.status)) return;
          setWaiting(null);
          const problem = myTicketProblem(t);
          if (problem) return setError(problem);
          setDone(
            `Connected as @${t.login ?? "you"}. Pushes and pull requests from cloud workspaces now go out as this account.`,
          );
          load();
        })
        .catch((e: unknown) => !stopped && setError(messageOf(e)));
    const timer = window.setInterval(ask, ASK_EVERY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waiting, load]);

  const connect = () => {
    setError(null);
    setDone(null);
    setStarting(true);
    startMyGithubConnect()
      .then((start) => {
        setWaiting(start);
        return open(start.authorize_url);
      })
      .catch((e: unknown) => {
        setWaiting(null);
        setError(messageOf(e));
      })
      .finally(() => setStarting(false));
  };

  const disconnect = () => {
    setAsked(false);
    setError(null);
    setDone(null);
    setRemoving(true);
    disconnectMyGithub()
      .then((r) => {
        setMe({ connected: false, login: null, linked_at: null });
        setReach(null);
        setDone(
          r.revoked_on_github
            ? "Disconnected. GitHub has forgotten Aura’s sign-in too."
            : "Disconnected. GitHub didn’t confirm it forgot Aura’s sign-in; you can remove it on GitHub under Settings → Applications.",
        );
      })
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setRemoving(false));
  };

  const description =
    "Pushes, commits and pull requests you make in cloud workspaces go out as this GitHub account, and you can start cloud workspaces on the repositories it can open.";

  if (!signedIn && authState.loading)
    return (
      <SettingsSection title="Your GitHub" description={description}>
        <LoadingState label="Reading your GitHub connection…" />
      </SettingsSection>
    );

  if (!signedIn)
    return (
      <SettingsSection title="Your GitHub" description={description}>
        <p className="ui-cloud-note">Sign in to Aura Cloud first, then connect your GitHub here.</p>
      </SettingsSection>
    );

  return (
    <SettingsSection title="Your GitHub" description={description}>
      {me === null && !error && <LoadingState label="Reading your GitHub connection…" />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {done && <p className="ui-cloud-note">{done}</p>}
      {waiting ? (
        <SettingsRow
          title="Sign in to GitHub"
          description={<LoadingState label="Waiting for GitHub to connect your account…" />}
          control={
            <span className="ui-pattern-actions">
              <Button size="sm" variant="ghost" onClick={() => setWaiting(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void open(waiting.authorize_url).catch(() => undefined)}>
                Open GitHub again
              </Button>
            </span>
          }
        />
      ) : me?.connected ? (
        <SettingsRow
          title={myGithubLine(me)}
          description={reachLine(reach) ?? undefined}
          control={
            <Button size="sm" variant="ghost" disabled={removing} onClick={() => setAsked(true)}>
              {removing ? "Disconnecting…" : "Disconnect"}
            </Button>
          }
        />
      ) : (
        me !== null && (
          <SettingsRow
            title="GitHub"
            description={myGithubLine(me)}
            control={
              <Button size="sm" disabled={starting} onClick={connect}>
                {starting ? "Opening GitHub…" : "Connect your GitHub"}
              </Button>
            }
          />
        )
      )}
      <AlertDialog open={asked} onOpenChange={(o) => !o && setAsked(false)}>
        <AlertDialogContent>
          <AlertDialogTitle>Disconnect @{me?.login ?? "your GitHub"}?</AlertDialogTitle>
          <AlertDialogDescription>
            Cloud workspaces can’t push or open pull requests as you until you connect again, and Aura asks GitHub to forget
            its sign-in. Your workspaces and their work stay.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={disconnect}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

// Cloud — the desktop face of your always-on machines: the account they run
// under, the machines on the board, and the way to connect another.
//
// Two homes. Settings › Cloud computer mounts it as it is. The Crew's "Cloud
// machine" dialog mounts it with `queue`, which adds the hand-a-job-off loop
// (`CloudJobQueue`) under the machines — that loop is work for the Crew's
// board, and it is not something a computer's settings need fed.
//
// Sign-in is the same cloud account the sidebar's avatar manages — we only read
// it here (`cloudAuthStatus`); we never ask for a second login. We do offer the
// button, though: `aura:open-signin` is the app-wide way to raise the sign-in
// welcome, and this panel telling you to go and find a menu instead was a
// dead end from inside Settings, which covers the whole window.


import { useCallback, useEffect, useState } from "react";
import { CircleCheck, Cloud, CloudOff } from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { CloudGlyph } from "../../ui/cloud-glyph";
import { CloudStatus } from "../../ui/cloud-workspace";
import {
  SettingsActions,
  SettingsEmpty,
  SettingsError,
  SettingsIntro,
} from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import "../../ui/cloud-patterns.css";
import "../../ui/cloud-runner.css";

import { api } from "../../../lib/api";
import type { CloudAuthStatus, CloudRunner } from "../../../lib/api";
import { CloudJobQueue } from "./CloudJobQueue";
import { AddComputer } from "./AddComputer";
import { ConnectMachineWizard } from "./ConnectMachineWizard";
import { GetComputerWizard } from "./GetComputerWizard";
import { blockedNote, machineLine } from "./cloudRunnerLabels";

// The label helpers live beside the page; the page is still where callers
// look for the one that decides a machine is blocked.
export { blockedNote } from "./cloudRunnerLabels";

export function CloudRunnerPanel({
  repoRoot,
  queue = false,
}: {
  repoRoot: string;
  /** Also offer sending a job and bringing finished work back. */
  queue?: boolean;
}) {
  const [auth, setAuth] = useState<CloudAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // The "bring your own box and turn it into the always-on machine" flow.
  // Adding a computer opens the one-line way; SSH and getting one from Aura
  // are reached from inside it.
  const [showConnect, setShowConnect] = useState<"add" | "ssh" | "aura" | null>(null);

  // The machines themselves. `null` = we haven't managed to read the board yet,
  // which is NOT the same as an empty board — one means "we don't know", the
  // other means "you have none", and the panel says something different for
  // each. Nothing here is inferred from local files: a box in another
  // datacenter leaves no trace on this disk, so the cloud registry is the only
  // witness.
  const [runners, setRunners] = useState<CloudRunner[] | null>(null);
  // Why the last board read failed, when it did. `runners === null` alone
  // can't carry this: it means "haven't managed to read it", which the
  // panel drew as a spinner — so a board call that failed every time span
  // "Checking your board…" forever, on a machine that may well have one.
  const [boardError, setBoardError] = useState<string | null>(null);

  const refreshAuth = useCallback(async () => {
    setAuthLoading(true);
    try {
      setAuth(await api.cloudAuthStatus());
    } catch {
      // Treat an unreadable status as signed-out — the panel then shows the
      // gentle sign-in prompt rather than a scary error.
      setAuth(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  // Signing in happens elsewhere — the welcome surface App.tsx raises. It
  // broadcasts when it lands, so this panel comes to life on its own instead
  // of waiting for the user to press a "check again" button we'd otherwise
  // have to leave as the only way back.
  useEffect(() => {
    const onAuthChanged = () => void refreshAuth();
    window.addEventListener("aura:cloud-auth-changed", onAuthChanged);
    return () =>
      window.removeEventListener("aura:cloud-auth-changed", onAuthChanged);
  }, [refreshAuth]);

  const connected = !!auth?.connected;

  const refreshRunners = useCallback(async () => {
    try {
      setRunners(await api.cloudRunners());
      setBoardError(null);
    } catch (e) {
      // Leave the last known board up rather than blanking it on one failed
      // poll — a dropped request doesn't mean the machine went away. But
      // record why, because with no board yet there is nothing to leave up
      // and the panel would otherwise spin on this forever.
      setRunners((prev) => prev);
      setBoardError(String(e));
    }
  }, []);

  // Poll while signed in. A runner beats every 20s, so 15s here means the strip
  // is never showing something more than one missed beat out of date.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    void refreshRunners();
    const t = setInterval(() => {
      if (alive) void refreshRunners();
    }, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connected, refreshRunners]);

  const live = (runners ?? []).filter((r) => r.online);
  // Rows that never checked in are a registration that never came up — real,
  // but not a machine yet, and not worth a line each on the main surface.
  const seen = (runners ?? []).filter((r) => !r.online && r.last_heartbeat_at);
  const hasMachine = live.length > 0;

  return (
    <div className="ui-cloud-runner">
      {/* One plain line under the page title; no jargon. */}
      <SettingsIntro>
        {queue
          ? "Hand off a job and keep working. A machine that stays awake picks it up, and you bring the finished work back with one click."
          : "The machines that keep working while this laptop sleeps. Connect one here and the team's cloud chats and crews can run on it."}
      </SettingsIntro>

      {/* Sign-in gate. We don't run a second login here — the welcome
          surface owns it — but we do raise it, and keep Send/Bring
          disabled until you're connected.

          This used to read "Use the account menu in the top-right corner
          to connect". The account menu is at the foot of the left
          sidebar, not the top right; and this panel's other home is
          Settings, which covers the whole window, so the menu it named
          wasn't reachable without closing the surface you were reading
          the instruction on. The only way forward was a button labelled
          "I've signed in" — for a sign-in the panel never offered. */}
      {authLoading ? (
        <SettingsRow
          title="Cloud account"
          description={
            <span className="ui-settings-status">
              <AsciiSpinner />
              Checking your cloud sign-in…
            </span>
          }
          control={null}
        />
      ) : !connected ? (
        <SettingsRow
          title={
            <span className="ui-cloud-inline">
              <CloudOff size={14} />
              Sign in to use your always-on machine
            </span>
          }
          description="It's your Aura account — the same one the app already uses."
          control={
            <SettingsActions>
              {/* Signing in from the app announces itself and this panel
                  updates on its own. `aura login` in a terminal doesn't —
                  so there's still a way to ask again by hand. */}
              <Button variant="ghost" size="sm" onClick={() => void refreshAuth()}>
                Check again
              </Button>
              <Button
                size="sm"
                onClick={() => window.dispatchEvent(new CustomEvent("aura:open-signin"))}
              >
                Sign in
              </Button>
            </SettingsActions>
          }
        />
      ) : (
        <SettingsRow
          title="Cloud account"
          description={
            <span className="ui-cloud-inline">
              <CircleCheck size={13} className="ui-cloud-runner-ok" />
              {/* When the backend confirms a session without a name, say so
                  and stop — "Connected as your cloud account" fills the slot
                  where a name goes with a phrase that isn't one, and reads as
                  though the account is literally called that. */}
              {auth?.user || auth?.org_slug ? (
                <span>
                  Connected as <strong>{auth.user || auth.org_slug}</strong>
                </span>
              ) : (
                "Connected."
              )}
            </span>
          }
          control={
            <Button variant="secondary" size="sm" onClick={() => setShowConnect("add")}>
              <Cloud />
              {hasMachine ? "Connect another" : "Connect a machine"}
            </Button>
          }
        />
      )}

      {/* The machines themselves. Signing in and owning a machine are two
          different facts, and the panel used to show only the first — so a
          board with nothing on it looked identical to one with a box running,
          and Send promised a pickup that could never come. */}
      {connected && (
        <SettingsSection title="Your machines">
          {runners === null && boardError ? (
            // Never read it, and we know why. Saying "no machine is online"
            // here would be an answer; we don't have one.
            <SettingsError>
              Aura couldn&apos;t reach your board, so it doesn&apos;t know what machines you
              have.{" "}
              <Button variant="link" size="xs" onClick={() => void refreshRunners()}>
                Try again
              </Button>
            </SettingsError>
          ) : runners === null ? (
            <SettingsEmpty>
              <span className="ui-settings-status">
                <AsciiSpinner />
                Checking your board…
              </span>
            </SettingsEmpty>
          ) : !hasMachine ? (
            <SettingsEmpty>
              No machine is online.{" "}
              {seen.length > 0
                ? `${seen.length === 1 ? "The one you connected" : `The ${seen.length} you connected`} ${seen.length === 1 ? "isn't" : "aren't"} reporting in right now. Work waits until ${seen.length === 1 ? "it comes" : "one comes"} back.`
                : "Connect one and it can keep working while this Mac sleeps."}
            </SettingsEmpty>
          ) : (
            live.map((r) => (
              <SettingsRow
                key={r.id}
                title={
                  <span className="ui-cloud-inline">
                    {/* The cloud mark, not a server box: this row is the one
                        place a machine is unambiguously *elsewhere*, and the
                        same glyph marks every other cloud-run thing in the
                        app so the association is learned once. */}
                    <CloudGlyph size={16} label="Cloud machine" />
                    {r.name}
                  </span>
                }
                // The detail line is deliberately the quietest text on the
                // row — except when it carries the one thing that makes the
                // rest of the row a lie.
                description={
                  <span data-blocked={blockedNote(r) ? "" : undefined} className="ui-cloud-runner-line">
                    {machineLine(r)}
                  </span>
                }
                // A machine that can't sign its agent in still beats, so it isn't
                // "unresponsive" — the red line is its status.
                control={blockedNote(r) ? null : <CloudStatus state="running" />}
              />
            ))
          )}
        </SettingsSection>
      )}

      {showConnect === "add" && (
        <AddComputer
          initial="own"
          onClose={() => setShowConnect(null)}
          onGetOne={() => setShowConnect("aura")}
          onSsh={() => setShowConnect("ssh")}
          onConnected={() => {
            void refreshAuth();
            void refreshRunners();
          }}
        />
      )}
      {showConnect === "aura" && (
        <GetComputerWizard
          onClose={() => setShowConnect(null)}
          onReady={() => void refreshRunners()}
          onConnectInstead={() => setShowConnect("add")}
        />
      )}
      {showConnect === "ssh" && (
        <ConnectMachineWizard
          repoRoot={repoRoot}
          onClose={() => setShowConnect(null)}
          // The wizard polls until the runner reports online. Without this
          // the panel kept rendering whatever status it read on mount, so
          // a machine you just connected still looked absent until the
          // drawer was reopened.
          onOnline={() => {
            void refreshAuth();
            void refreshRunners();
          }}
        />
      )}

      {queue && (
        <CloudJobQueue
          repoRoot={repoRoot}
          connected={connected}
          runsOn={hasMachine ? live[0].name : null}
        />
      )}
    </div>
  );
}

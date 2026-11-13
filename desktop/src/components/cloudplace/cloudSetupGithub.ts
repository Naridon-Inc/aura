// The Connect GitHub button on the setup steps, for each point of the trip
// through GitHub (useConnectGithub). It used to send you to the web console
// and back, which lost your place; now the trip runs right on the step.

import { candidateState } from "../../lib/cloudGithub";
import type { ConnectPhase } from "../settings/org/useConnectGithub";

export type GithubButton = {
  label: string;
  /** What pressing it does; null while there is nothing to press. */
  act: "begin" | "continue" | "again" | "choose" | null;
  /** The line under the repositories, when the trip has something to say. */
  note: string | null;
};

export function githubButton(phase: ConnectPhase, connecting: boolean): GithubButton {
  switch (phase.at) {
    case "idle":
      return { label: "Connect GitHub", act: "begin", note: null };
    case "starting":
      return { label: "Opening GitHub…", act: null, note: null };
    case "installing":
      return {
        label: "Installed it? Continue",
        act: "continue",
        note: "On GitHub, pick the account and which repositories Aura may use. This page moves on by itself when GitHub is done.",
      };
    case "signing_in":
      return {
        label: "Open GitHub again",
        act: "again",
        note: "Waiting for GitHub to say which accounts you can connect…",
      };
    case "answered": {
      const { ticket } = phase;
      if (ticket.status === "expired")
        return { label: "Start again", act: "begin", note: "This took too long. Start connecting again." };
      if (ticket.status !== "answered")
        return { label: "Start again", act: "begin", note: ticket.problem || "GitHub didn’t answer." };
      if (connecting) return { label: "Connecting…", act: null, note: null };
      const open = ticket.candidates.filter((c) => candidateState(c).connectable).length;
      if (open > 1)
        return {
          label: "Choose an account",
          act: "choose",
          note: "GitHub listed more than one account you can connect. Pick one in Settings → Organization.",
        };
      if (open === 0)
        return {
          label: "Install the app on GitHub",
          act: "begin",
          note: ticket.candidates.length
            ? "Every account GitHub listed is connected already, or can’t be connected by you."
            : "GitHub didn’t list an account of yours with the app installed yet.",
        };
      return { label: "Connecting…", act: null, note: null };
    }
  }
}

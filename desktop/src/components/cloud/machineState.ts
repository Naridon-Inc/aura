// Whether the machine in front of you is up, in the cloud workspace's own
// words — the six states the library's status names — so the header, the
// details and the banner can't disagree about the same box.
//
// Each state comes from the one thing that knows it. A wake in flight is the
// engine's (`place_waking`), and wins, because a booting box still carries its
// sleeping row in the book for the minute it takes. Asleep is the book's: Aura
// stopped it. Unresponsive is the board's: the runner stopped checking in. And
// a box the board still hears from but this window can't read is reconnecting
// — the reads retry on their own.

import type { CloudRunner, Waking } from "../../lib/api";
import type { CloudSessionState } from "../ui/cloud-workspace";

export function machineCloudState({
  asleep,
  waking,
  runner,
  unreachable,
}: {
  asleep: boolean;
  waking: Waking | null;
  runner: CloudRunner | null;
  /** The last read of the box failed. */
  unreachable: boolean;
}): CloudSessionState {
  if (waking?.state === "waking") return "starting";
  if (asleep) return "sleeping";
  if (runner && !runner.online) return "unresponsive";
  if (unreachable) return "reconnecting";
  return "running";
}

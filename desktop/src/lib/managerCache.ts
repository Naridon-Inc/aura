// managerCache — the list of Aura conversations, read once per instant.
//
// `manager_list` looks cheap and is not. Beyond the live sessions held in
// memory it walks every persisted conversation on disk and deserialises each
// one whole — objective, projects, and the entire message transcript — to
// produce a summary row. Seven call sites ask for it: boot, opening a project,
// the Sessions pane, the manager dashboard, the manager store's own refresh,
// and two slash commands, several of which fire within the same moment of
// opening a workspace.
//
// No freshness window, for the third time and the same reason as the task board
// and the crew graph: this list is written to by the surfaces that read it —
// starting a chat, appending a turn, cancelling a run — and each of those
// re-reads immediately to show what it did. Collapsing the reads that are in
// flight together is the part that is both free and safe.

import { api, type ManagerSummary } from "./api";
import { readShared, sharedReader } from "./sharedRead";

/** Zero window — conversations are written constantly by the same surfaces
 *  that list them. See the header. */
const COALESCE_ONLY = 0;

const list = sharedReader(
  (key: string) => api.managerList(key === "" ? null : key),
  COALESCE_ONLY,
);

/** Conversations for a repo, or every workspace's when called with nothing.
 *
 *  Rejects if they could not be read. An empty list is a real answer — you
 *  have not talked to Aura here — and showing it for a failed read tells
 *  somebody their conversations are gone. */
export function fetchManagerList(
  repoRoot?: string | null,
): Promise<ManagerSummary[]> {
  return readShared(list, repoRoot ?? "");
}

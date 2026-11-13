// The `box-drive` scene of the cloud place harness: a workspace one of the
// team's computers answers by itself. Priya handed it over; Sam and she both
// send the normal way. One prompt was answered, one was not run because she
// had no sign-in yet, and the newest is still being worked on.

import type { CloudMessageRow, CloudWorkspacePlace, CloudWorkspaceRow } from "../../../lib/cloudWorkspacesApi";

export const BOX_DRIVE_ID = "2b7e9c41-8d3a-4f60-a1c5-9e4d7b2f0c18";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export function boxDrivePlace(machine: string, placeId: string, linkedMinutesAgo = 30): CloudWorkspacePlace {
  return {
    kind: "machine",
    machine,
    remote_root: "~/aura-workspaces",
    branch: null,
    engine: "claude",
    agent_session_id: null,
    place_id: placeId,
    driver: "box",
    linked_at: minutesAgo(linkedMinutesAgo),
  };
}

/** The log as the cloud answers it, oldest first. */
export function boxDriveLog(me: string, priya: string): CloudMessageRow[] {
  const turn = (
    id: string,
    role: string,
    body: string,
    minutes: number,
    over: Partial<CloudMessageRow> = {},
  ): CloudMessageRow => ({ id, role, body, source: "public-api", created_at: minutesAgo(minutes), ...over });
  return [
    turn("bd1", "user", "Send a “back in stock” email when a sold-out product is restocked.", 25, {
      author_id: me,
      author_name: "Sam Ortega",
    }),
    turn(
      "bd2",
      "assistant",
      "Done. A restock now emails everyone who asked to be told, once, and the unsubscribe link works. " +
        "The change is on the branch `aura/back-in-stock`, with tests.",
      21,
      { source: "box", answers: "bd1" },
    ),
    turn("bd3", "user", "Also send a text when they left a phone number.", 12, {
      author_id: priya,
      author_name: "Priya Nair",
    }),
    turn(
      "bd4",
      "assistant",
      "Not run: Priya Nair has no Claude sign-in on this team yet. Connect one under Agents, then send it again.",
      11,
      { source: "box", answers: "bd3", failed: true },
    ),
    turn("bd5", "user", "Connected now. Please add the text message.", 1, {
      author_id: priya,
      author_name: "Priya Nair",
    }),
  ];
}

/** What `cloud_box_link` answers: the workspace, handed to the computer. */
export function linkedRow(
  row: CloudWorkspaceRow,
  link: { machine: string; placeId: string },
  by: string,
): CloudWorkspaceRow {
  return { ...row, place: boxDrivePlace(link.machine, link.placeId, 0), place_linked_by: by };
}

// A tracker you are signed in to, as one row on the connected list: who you
// are on it, a line about what the connection does, and the way out. Jira and
// Linear draw the same row; what Jira adds beyond it lives in its own
// sections below the list.

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/settings-row";
import { type ConnectionStatus } from "../../../lib/integrationsApi";
import { ServiceName } from "./ServiceGlyph";
import { CardError } from "./trackerParts";
import type { CatalogEntry } from "./catalog";

/** A tracker you are signed in to: who you are on it, and the way out. */
export function TrackerRow({
  entry,
  status,
  busy,
  error,
  note,
  onDisconnect,
}: {
  entry: CatalogEntry;
  status: ConnectionStatus | null;
  busy: boolean;
  error: string | null;
  /** One line about what the connection does, or how long it lasts. */
  note?: string | null;
  onDisconnect: () => void;
}) {
  const who = status?.identity;
  return (
    <SettingsRow
      title={<ServiceName entry={entry} />}
      description={
        who
          ? `Signed in as ${who.display_name}${who.email ? ` · ${who.email}` : ""}`
          : "Signed in"
      }
      help={
        note || error ? (
          <>
            {note && <p>{note}</p>}
            {error && <CardError msg={error} />}
          </>
        ) : undefined
      }
      control={
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>
          {busy && <AsciiSpinner />}
          Disconnect
        </Button>
      }
    />
  );
}

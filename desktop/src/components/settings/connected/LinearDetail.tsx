// What a connected Linear looks like. Simpler than Jira: one workspace per
// token, no sites list and no mirror picker yet — so this is the signed-in
// identity and the way out, and it says so rather than drawing empty
// sections where Jira has full ones.

import { Unlink } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { type ConnectionStatus } from "../../../lib/integrationsApi";
import { CardError, initials } from "./trackerParts";

export function LinearDetail({
  status,
  busy,
  error,
  onDisconnect,
}: {
  status: ConnectionStatus;
  busy: boolean;
  error: string | null;
  onDisconnect: () => void;
}) {
  return (
    <div className="space-y-3 text-sm text-text-3">
      {status.identity && (
        <div className="flex items-center gap-3">
          {status.identity.avatar_url ? (
            <img
              src={status.identity.avatar_url}
              alt=""
              className="h-7 w-7 rounded-full border border-line-soft"
            />
          ) : (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-2 text-2xs uppercase text-text-3">
              {initials(status.identity.display_name)}
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm text-text-1">
              {status.identity.display_name}
            </div>
            {status.identity.email && (
              <div className="truncate text-xs text-text-4">
                {status.identity.email}
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-text-4">
        Linear issues arrive alongside your work. Per-project mirroring is Jira
        only for now.
      </p>

      <div className="pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={onDisconnect}
          disabled={busy}
        >
          {busy ? (
            <AsciiSpinner className="text-xs leading-none" />
          ) : (
            <Unlink className="h-3 w-3" />
          )}
          Disconnect
        </Button>
      </div>

      {error && <CardError msg={error} />}
    </div>
  );
}

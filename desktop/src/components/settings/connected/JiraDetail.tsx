// What a connected Jira looks like: who you are on it, which sites it
// reaches, the per-repo mirror bindings, the people-matching table, and the
// way out.
//
// It draws no name, no icon and no "Connected" chip. The row that expanded to
// show this already said all three — the card this used to be repeated them
// under a second heading, so a connected Jira was announced twice within
// 40px. Connecting lives in the store; this is only the after.

import {
  LinkIcon,
  Unlink,
} from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { onExternalAnchorClick } from "../../../lib/openExternal";
import { type ConnectionStatus } from "../../../lib/integrationsApi";
import { CardError, formatExpiry, initials } from "./trackerParts";
import { MirrorsSection } from "./JiraMirrors";
import { PeopleSection } from "./JiraPeople";

export function JiraDetail({
  status,
  repoRoot,
  busy,
  error,
  onDisconnect,
  onStatusUpdate,
  onError,
}: {
  status: ConnectionStatus;
  repoRoot: string;
  busy: boolean;
  error: string | null;
  onDisconnect: () => void;
  onStatusUpdate: (next: ConnectionStatus) => void;
  onError: (msg: string | null) => void;
}) {
  const sites = status.sites ?? [];
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

      {sites.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-text-4">
            Sites ({sites.length})
          </div>
          <ul className="space-y-1">
            {sites.map((s) => (
              <li key={s.cloud_id} className="flex items-center gap-2 text-sm">
                <LinkIcon className="h-3 w-3 flex-shrink-0 text-text-4" />
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onExternalAnchorClick}
                  className="truncate text-text-2 hover:text-text-1 hover:underline"
                >
                  {s.name}
                </a>
                <span className="truncate text-xs text-text-5">
                  {s.url.replace(/^https?:\/\//, "")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sites.length > 0 && (
        <MirrorsSection
          sites={sites}
          mirrors={status.mirrors ?? []}
          autoMirrorRepoRoot={status.auto_mirror_repo_root ?? null}
          repoRoot={repoRoot}
          onStatusUpdate={onStatusUpdate}
          onError={onError}
        />
      )}

      <div className="border-t border-line-soft/60 pt-1">
        <PeopleSection repoRoot={repoRoot} onError={onError} />
      </div>

      {status.expires_at && (
        <div className="text-xs text-text-4">
          Token refreshes in {formatExpiry(status.expires_at)}.
        </div>
      )}

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

// One mode card — used by the marketplace dialog AND the Settings →
// Modes pane. Compact horizontal layout: accent stripe + display name,
// description, tags, optional permissions badge + install/uninstall
// action.
//
// The card is intentionally presentational. It accepts a `state`
// discriminator that controls which CTA the card draws (Install,
// Installed, Update available, Disabled). All side-effect handlers
// come in via props so the same card renders the same way regardless
// of where it's mounted.

import { Check, Download, Pencil, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "../ui/button";
import { ModePermissionsBadge } from "./ModePermissionsBadge";

import type { MarketplaceIndexEntry, ModeDescriptor, ToolAcl } from "../../lib/api";

type CardState =
  | { kind: "marketplace"; entry: MarketplaceIndexEntry }
  | { kind: "installed"; entry: ModeDescriptor; updateAvailable: boolean };

type Props = {
  state: CardState;
  /** Hide actions when the card is rendered inside a sheet that owns
   *  its own primary button (install sheet). */
  inert?: boolean;
  onInstall?: () => void;
  onUpdate?: () => void;
  onUninstall?: () => void;
  onEdit?: () => void;
  onSelect?: () => void;
};

export function ModeCard({
  state,
  inert = false,
  onInstall,
  onUpdate,
  onUninstall,
  onEdit,
  onSelect,
}: Props) {
  const isInstalled = state.kind === "installed";
  const e = state.entry;
  const displayName = e.display_name;
  const description = e.description;
  const tags = e.tags;
  const author = e.author;
  // A published mode may declare its own stripe colour; without one it takes
  // the app's accent rather than a violet that appears nowhere else here.
  const accent =
    isInstalled && state.entry.ui?.accent
      ? state.entry.ui.accent
      : "var(--color-accent)";
  const badgeText = isInstalled ? state.entry.ui?.badge : undefined;

  // Marketplace cards don't know the tool_acl until install — fall
  // back to a synthesized empty ACL so the permissions badge stays
  // neutral. Installed cards have the real ACL.
  const toolAcl: ToolAcl = isInstalled
    ? state.entry.tool_acl
    : { allow: [], deny: [], advanced: [] };

  return (
    <div
      className="flex items-stretch rounded-md border border-bg-3 bg-bg-1 overflow-hidden cursor-pointer hover:border-bg-4 transition-colors"
      onClick={onSelect}
    >
      <div
        className="w-1.5 flex-shrink-0"
        style={{ backgroundColor: accent }}
        aria-hidden
      />
      <div className="flex-1 min-w-0 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {badgeText && (
                <span
                  className="text-[9px] font-bold rounded px-1 py-0.5 text-white"
                  style={{ backgroundColor: accent }}
                >
                  {badgeText}
                </span>
              )}
              <span className="font-medium text-[13px] text-text-1 truncate">
                {displayName}
              </span>
              {isInstalled && state.entry.bundled && (
                <span className="text-[9.5px] text-text-4 uppercase tracking-wider">
                  bundled
                </span>
              )}
              {isInstalled && state.updateAvailable && (
                <span className="text-[9.5px] text-amber uppercase tracking-wider">
                  update
                </span>
              )}
            </div>
            <div className="text-[11px] text-text-3 mt-0.5 line-clamp-2">
              {description}
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {author && (
                <span className="text-[10px] text-text-4">by {author}</span>
              )}
              {tags.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="text-[10px] text-text-3 bg-bg-2 rounded px-1.5 py-0.5"
                >
                  {t}
                </span>
              ))}
              <ModePermissionsBadge toolAcl={toolAcl} />
            </div>
          </div>
          {!inert && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {state.kind === "marketplace" && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onInstall?.();
                  }}
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  Install
                </Button>
              )}
              {state.kind === "installed" && state.updateAvailable && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onUpdate?.();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Update
                </Button>
              )}
              {state.kind === "installed" && !state.updateAvailable && (
                <span
                  className="inline-flex items-center text-[10.5px] text-text-3"
                  title="Installed"
                >
                  <Check className="h-3.5 w-3.5 mr-0.5" />
                  Installed
                </span>
              )}
              {state.kind === "installed" && (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onEdit?.();
                    }}
                    title="Edit YAML"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {!state.entry.bundled && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onUninstall?.();
                      }}
                      title="Uninstall"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

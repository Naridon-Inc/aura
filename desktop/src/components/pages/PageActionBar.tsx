import { useEffect, useState } from "react";
import {
  Copy,
  Globe,
  Link2,
  Lock,
  MoreHorizontal,
  PanelRightOpen,
  Share2,
  Star,
  Trash2,
  Unlock,
} from "lucide-react";
import { IconButton } from "@medusajs/ui";

import { PageActionBar as UiPageActionBar } from "../ui/PageActionBar";
import { pageRefUrl } from "../../lib/auraRelay";
import { parsePageKey } from "../pages2/pagesApi";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type Props = {
  pageKey: string;
  published: boolean;
  onTogglePublish: () => void;
  locked: boolean;
  onToggleLock: () => void;
  onShare: () => void;
  onToggleSide?: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  className?: string;
};

const FAVORITE_KEY_PREFIX = "aura.page.favorite.";

export function PageActionBar({
  pageKey,
  published,
  onTogglePublish,
  locked,
  onToggleLock,
  onShare,
  onToggleSide,
  onDelete,
  onDuplicate,
  className,
}: Props) {
  const [copied, setCopied] = useState<"link" | null>(null);
  const [favorited, setFavorited] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FAVORITE_KEY_PREFIX + pageKey) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      setFavorited(localStorage.getItem(FAVORITE_KEY_PREFIX + pageKey) === "1");
    } catch {
      // localStorage denied
    }
  }, [pageKey]);

  async function copyLink() {
    try {
      // `pageKey` is the in-app composite (`scope|bucket|id`) — pasting THAT
      // after `aura://page/` produced a link nothing could open, because the
      // ref parser reads slash segments. Same page, spelled the way the rest
      // of the app spells it.
      const parsed = parsePageKey(pageKey);
      if (!parsed) return;
      await navigator.clipboard.writeText(pageRefUrl(parsed));
      setCopied("link");
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      // clipboard denied
    }
  }

  function toggleFavorite() {
    const next = !favorited;
    setFavorited(next);
    try {
      if (next) localStorage.setItem(FAVORITE_KEY_PREFIX + pageKey, "1");
      else localStorage.removeItem(FAVORITE_KEY_PREFIX + pageKey);
    } catch {
      // localStorage denied; UI state still toggles for the session
    }
  }

  return (
    <UiPageActionBar
      className={className}
      primary={{
        label: published ? "Published" : "Publish",
        icon: Globe,
        onClick: onTogglePublish,
      }}
      actions={[
        {
          key: "lock",
          label: locked ? "Unlock page" : "Lock page",
          tooltip: locked ? "Unlock page (allow editing)" : "Lock page (read-only)",
          icon: locked ? Lock : Unlock,
          onClick: onToggleLock,
          active: locked,
        },
        {
          key: "copy-link",
          label: "Copy link",
          tooltip: copied === "link" ? "Copied aura://page link" : "Copy link",
          icon: Link2,
          onClick: copyLink,
          active: copied === "link",
        },
        {
          key: "favorite",
          label: "Favorite page",
          tooltip: favorited ? "Remove from favorites" : "Add to favorites",
          icon: Star,
          onClick: toggleFavorite,
          active: favorited,
        },
        { key: "share", label: "Share page", icon: Share2, onClick: onShare },
        ...(onToggleSide
          ? [{ key: "side", label: "Toggle side view", icon: PanelRightOpen, onClick: onToggleSide }]
          : []),
      ]}
      kebab={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="small" variant="transparent" aria-label="More actions">
              <MoreHorizontal className="size-4" aria-hidden />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onDuplicate && (
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="size-3.5" aria-hidden />
                Duplicate page
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onDelete} className="text-red">
              <Trash2 className="size-3.5" aria-hidden />
              Delete page
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}

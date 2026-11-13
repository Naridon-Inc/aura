// A repository's picture, looked up for a root on disk (or on the machine the
// root is open on). The shared `RepoAvatar` draws whatever it is handed; this
// is the one place that hands it the emoji the person picked, the icon they
// picked, the repository's own icon file and its GitHub owner's face.

import type { ReactNode } from "react";
import { RepoAvatar } from "./ui/repo-avatar";
import { useRepoIcons } from "./repo-icon/loadRepoIcons";
import { useChosenRepoIcon, useRepoAvatar } from "../lib/useRepoAvatar";
import { useWorkspaceCustomization } from "../lib/workspaceCustomization";

export function ProjectAvatar({
  root,
  name,
  emoji,
  size = 16,
  fallback,
  labelled,
  className,
}: {
  /** The repository root. Null draws the fallback and looks nothing up. */
  root: string | null | undefined;
  name: string;
  /** The picked emoji. Left out, the one saved for this root is used. */
  emoji?: string | null;
  size?: number;
  fallback?: ReactNode;
  labelled?: boolean;
  className?: string;
}) {
  const custom = useWorkspaceCustomization();
  const picked = emoji === undefined ? (root ? custom[root]?.emoji : undefined) : emoji;
  const chosen = useChosenRepoIcon(picked ? null : root);
  const named = chosen && !chosen.startsWith("data:") ? chosen : null;
  const icons = useRepoIcons(!!named);
  const Glyph = named && icons ? icons.REPO_ICONS[named] : undefined;
  // A picked emoji or icon outranks every found picture, so nothing is
  // looked up for it.
  const picture = useRepoAvatar(picked || chosen ? null : root);
  return (
    <RepoAvatar
      name={name}
      emoji={picked}
      glyph={Glyph ? <Glyph size={size} /> : undefined}
      picked={chosen && !named ? chosen : null}
      icon={picture.icon}
      avatar={picture.avatar}
      size={size}
      fallback={fallback}
      labelled={labelled}
      className={className}
    />
  );
}

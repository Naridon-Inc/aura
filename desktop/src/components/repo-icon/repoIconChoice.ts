// What a repository wears, and the three ways to change it. One picture at a
// time: picking an emoji forgets a picked icon and the other way round, and
// "automatic" forgets both so the repository's file or owner face shows.

import { chooseRepoIcon } from "../../lib/repoAvatar";
import { useChosenRepoIcon } from "../../lib/useRepoAvatar";
import { setWorkspaceEmoji, useWorkspaceCustomization } from "../../lib/workspaceCustomization";

export type RepoLook = {
  emoji: string | null;
  /** A named icon or an uploaded image `data:` URL. */
  chosen: string | null;
  /** True when the person picked anything at all. */
  custom: boolean;
  setAutomatic: () => void;
  setEmoji: (emoji: string) => void;
  /** False when the icon could not be kept. */
  setIcon: (value: string) => boolean;
};

export function useRepoLook(root: string): RepoLook {
  const custom = useWorkspaceCustomization();
  const emoji = custom[root]?.emoji ?? null;
  const chosen = useChosenRepoIcon(root);
  return {
    emoji,
    chosen,
    custom: !!emoji || !!chosen,
    setAutomatic: () => {
      setWorkspaceEmoji(root, undefined);
      chooseRepoIcon(root, null);
    },
    setEmoji: (next) => {
      chooseRepoIcon(root, null);
      setWorkspaceEmoji(root, next);
    },
    setIcon: (value) => {
      if (!chooseRepoIcon(root, value)) return false;
      setWorkspaceEmoji(root, undefined);
      return true;
    },
  };
}

export type RepoIconTabProps = {
  root: string;
  name: string;
  look: RepoLook;
  onClose: () => void;
};

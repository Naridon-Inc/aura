// A cloud repository's picture: its GitHub owner's face, the folder until it
// loads and when there is no owner to show — the per-caller container, or a
// name that isn't `owner/name`.

import { RepoAvatar } from "../ui/repo-avatar";
import { githubOwnerOf, ownerAvatarUrl } from "../../lib/repoAvatar";

const IMPLICIT_REPO = "aura-workspace/";
const OWNER_SLASH_NAME = /^[^/\s]+\/[A-Za-z0-9._-]+$/;

/** `owner/name` → `owner`; null for anything else. The owner has to be a
 *  real GitHub login, by the same rule a local checkout's remote is read
 *  with (lib/repoAvatar), since the picture comes from that address. */
export function cloudRepoOwner(fullName: string | null | undefined): string | null {
  const name = (fullName ?? "").trim();
  if (name.startsWith(IMPLICIT_REPO) || !OWNER_SLASH_NAME.test(name)) return null;
  return githubOwnerOf(`github.com/${name}`);
}

export function CloudRepoAvatar({
  fullName,
  name,
  size = 16,
}: {
  fullName: string | null | undefined;
  /** Read by assistive tech; defaults to the repository's short name. */
  name?: string;
  size?: number;
}) {
  const owner = cloudRepoOwner(fullName);
  return (
    <RepoAvatar
      name={name ?? (fullName ?? "").split("/").pop() ?? ""}
      avatar={owner ? ownerAvatarUrl(owner) : null}
      size={size}
    />
  );
}

/** The repository's picture for a slot that shows its own icon otherwise:
 *  the owner's face when there is an owner, nothing when there isn't. */
export function cloudRepoPicture(
  fullName: string | null | undefined,
  size: number,
  name?: string,
) {
  return cloudRepoOwner(fullName) ? (
    <CloudRepoAvatar fullName={fullName} name={name} size={size} />
  ) : null;
}

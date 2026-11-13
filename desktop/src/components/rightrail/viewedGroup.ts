// Files marked as viewed leave their group and gather in a last one,
// "Viewed", so what is still to look at stays at the top of the list.

import type { ChangedFile } from "../../lib/useGitChanges";
import type { ChangeGroup } from "./ChangesTree";

export const VIEWED_GROUP_KEY = "viewed";

export function withViewedGroup(
  groups: ChangeGroup[],
  isViewed: (file: ChangedFile) => boolean,
): ChangeGroup[] {
  const viewed: ChangeGroup["files"] = [];
  const rest = groups.map((g) => {
    const keep = g.files.filter((entry) => {
      if (!isViewed(entry.file)) return true;
      viewed.push(entry);
      return false;
    });
    return keep.length === g.files.length ? g : { ...g, files: keep };
  });
  if (viewed.length === 0) return groups;
  // A group emptied by it keeps its caption only if it had one to begin with.
  const shown = rest.filter((g, i) => g.files.length > 0 || groups[i].title);
  return [...shown, { key: VIEWED_GROUP_KEY, title: "Viewed", files: viewed }];
}

// A changed file's row label the way a diff lists it: the folder dim, the
// file name bright, so a flat list of paths still reads at a glance. When the
// row is too narrow the folder gives way first and the name stays.

import { GitBranch } from "lucide-react";
import type { NestedRepo } from "../../lib/api";
import "../ui/diff-review.css";

export function ChangePath({ path }: { path: string }) {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  const dir = cut > 0 ? path.slice(0, cut + 1) : "";
  const name = cut > 0 ? path.slice(cut + 1) : path;
  return (
    <span className="ui-changes-path" title={path}>
      {dir && <span className="ui-changes-path-dir">{dir}</span>}
      <span className="ui-changes-path-name">{name}</span>
    </span>
  );
}

/** The small tag on a file that belongs to a git repository of its own inside
 *  the project: that repository's branch, or its folder when it has none. */
export function RepoTag({ repo }: { repo: NestedRepo }) {
  const kind = repo.kind === "submodule" ? "Submodule" : "Separate repository";
  const where = repo.branch ? ` on ${repo.branch}` : "";
  return (
    <span className="ui-changes-repo-tag" title={`${kind} at ${repo.rel_path}/${where}`}>
      <GitBranch size={11} aria-hidden />
      <span className="ui-changes-repo-tag-name">{repo.branch ?? repo.rel_path}</span>
    </span>
  );
}

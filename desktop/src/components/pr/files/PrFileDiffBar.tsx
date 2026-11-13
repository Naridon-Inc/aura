// The bar over one file's patch: which file, how much it changed, its
// language, and the Viewed tick the file list mirrors.

import type { PrFileStat } from "../../../lib/api";
import { detectLanguage } from "../../../lib/fileLang";
import { Checkbox } from "../../ui/checkbox";
import { DiffCount } from "../../ui/sidebar";
import "../../ui/pr-files.css";
import "../../ui/pr-review.css";

export function PrFileDiffBar({
  path,
  file,
  viewed,
  onToggleViewed,
}: {
  path: string | null;
  file: PrFileStat | null;
  viewed: boolean;
  onToggleViewed: (viewed: boolean) => void;
}) {
  if (!path) {
    return (
      <div className="ui-pr-file-bar">
        <span className="ui-pr-file-none">No file selected</span>
      </div>
    );
  }
  const language = detectLanguage(path);
  return (
    <div className="ui-pr-file-bar">
      <span className="ui-pr-file-path" title={path}>
        {path}
      </span>
      {file && <DiffCount added={file.additions} removed={file.deletions} />}
      {language && <span className="ui-pr-file-lang">{language}</span>}
      <label className="ui-pr-review-check ui-pr-file-viewed">
        <Checkbox checked={viewed} onCheckedChange={(v) => onToggleViewed(v === true)} />
        Viewed
      </label>
    </div>
  );
}

import { TriangleAlert } from "lucide-react";
import { Button } from "./button";
import "./file-changed-banner.css";

/** The strip over an open file whose copy on disk changed while it had
 *  unsaved edits: the edits stay until one of the two buttons says which
 *  copy wins. */
export function FileChangedBanner({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <div role="alert" className="ui-file-changed-banner">
      <TriangleAlert className="ui-file-changed-banner-icon" strokeWidth={2.5} aria-hidden />
      <div className="ui-file-changed-banner-text">File changed on disk</div>
      <Button variant="ghost" size="sm" onClick={onDiscard}>
        Discard my edits
      </Button>
      <Button variant="outline" size="sm" onClick={onKeep}>
        Keep mine
      </Button>
    </div>
  );
}

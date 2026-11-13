import { Button } from "../ui/button";
import { useRepoAvatar } from "../../lib/useRepoAvatar";
import type { RepoIconTabProps } from "./repoIconChoice";

/** The picture found for the repository by itself: an icon file in the
 *  checkout, else its GitHub owner's face. */
export function FaviconTab({ root, name, look, onClose }: RepoIconTabProps) {
  const found = useRepoAvatar(root);
  const automatic = () => {
    look.setAutomatic();
    onClose();
  };
  const src = found.icon ?? found.avatar;
  return (
    <div className="ui-repo-icon-pane">
      <div className="ui-repo-icon-stage">
        {src ? (
          <div className="ui-repo-icon-preview">
            <img src={src} alt={found.icon ? "Detected favicon" : "GitHub avatar"} />
            <Button variant={look.custom ? "outline" : "secondary"} size="sm" onClick={automatic}>
              {found.icon
                ? look.custom
                  ? "Use favicon"
                  : "Using favicon"
                : look.custom
                  ? "Use GitHub avatar"
                  : "Using GitHub avatar"}
            </Button>
          </div>
        ) : (
          <div className="ui-repo-icon-preview">
            <div className="ui-repo-icon-initial">{name.charAt(0).toUpperCase()}</div>
            <p>No favicon detected</p>
          </div>
        )}
      </div>
      <p className="ui-repo-icon-note">
        Aura looks for favicons in your repo at common paths like <code>public/favicon.svg</code>,{" "}
        <code>apple-touch-icon.png</code>, and similar locations.
      </p>
    </div>
  );
}

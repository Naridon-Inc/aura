import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { pickPath } from "../../lib/nativeDialog";
import { MAX_UPLOAD_BYTES, shrinkIcon, uploadType } from "./shrinkIcon";
import type { RepoIconTabProps } from "./repoIconChoice";

/** Any image from disk, shrunk to icon size and kept on this device. */
export function UploadTab({ look, onClose }: RepoIconTabProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploaded = look.chosen?.startsWith("data:image/") ? look.chosen : null;

  const choose = async () => {
    const path = await pickPath({ title: "Choose an icon image" });
    if (typeof path !== "string") return;
    const type = uploadType(path);
    if (!type) {
      setError("Choose a PNG, JPEG, GIF, WebP, or SVG image.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const file = await api.readFileBase64(path);
      if (file.size > MAX_UPLOAD_BYTES) throw new Error("Image is larger than 10 MB");
      const icon = await shrinkIcon(file.data_base64, type);
      if (!look.setIcon(icon)) throw new Error("The icon could not be saved");
      onClose();
    } catch {
      setError("Failed to set the icon. Try a different image.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-repo-icon-pane">
      <div className="ui-repo-icon-stage">
        <div className="ui-repo-icon-preview">
          {uploaded ? (
            <img src={uploaded} alt="Uploaded icon" />
          ) : (
            <div className="ui-repo-icon-initial">
              <ImageIcon size={16} />
            </div>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void choose()}>
            {uploaded ? "Replace image…" : "Choose image…"}
          </Button>
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
      <p className="ui-repo-icon-note">
        Upload a PNG, JPEG, GIF, WebP, or SVG image. Aura resizes it to icon size.
      </p>
    </div>
  );
}

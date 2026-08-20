// Publish a local mode to a GitHub Gist. The Rust command does the
// HTTPS POST anonymously — no token needed — and returns the gist URL
// + raw URL the user can paste into the marketplace PR.
//
// Why Gist? It's the closest thing to "shareable, no-auth, raw URL"
// available without standing up our own CDN. The marketplace PR step
// (live on auravcs.com) eventually copies the raw URL into the
// curated index.

import { useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { ExternalLink } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { api } from "../../lib/api";

type Props = {
  open: boolean;
  slug: string | null;
  onClose: () => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "publishing" }
  | { kind: "done"; url: string; rawUrl: string }
  | { kind: "error"; message: string };

export function PublishModeDialog({ open, slug, onClose }: Props) {
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const handlePublish = async () => {
    if (!slug) return;
    setPhase({ kind: "publishing" });
    try {
      const res = await api.modesPublishToGist({
        slug,
        description: description.trim() || null,
      });
      setPhase({ kind: "done", url: res.url, rawUrl: res.raw_url });
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const reset = () => {
    setPhase({ kind: "idle" });
    setDescription("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to Gist</DialogTitle>
          <DialogDescription>
            Uploads <code className="text-text-1">{slug}.yaml</code> to an
            anonymous public Gist. Share the raw URL to let others
            install via "Install from URL".
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "idle" || phase.kind === "publishing" ? (
          <>
            <div>
              <label className="text-xs text-text-3 mb-1 block">
                Gist description (optional)
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Architect mode tuned for Rust async work"
                className="h-8 text-sm"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" size="xs" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={handlePublish}
                disabled={!slug || phase.kind === "publishing"}
              >
                {phase.kind === "publishing" ? (
                  <>
                    <AsciiSpinner className="text-sm leading-none mr-1" />
                    Publishing…
                  </>
                ) : (
                  "Publish"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : phase.kind === "done" ? (
          <>
            <div className="space-y-3 text-sm">
              <div className="text-text-1">Published.</div>
              <div>
                <div className="text-text-3 text-xs mb-1">Gist URL</div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-text-1 bg-bg-2 rounded p-1 flex-1 truncate">
                    {phase.url}
                  </code>
                  <a
                    href={phase.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={onExternalAnchorClick}
                    className="text-text-3 hover:text-text-1"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
              <div>
                <div className="text-text-3 text-xs mb-1">
                  Raw URL (use this for "Install from URL")
                </div>
                <code className="text-xs text-text-1 bg-bg-2 rounded p-1 block truncate">
                  {phase.rawUrl}
                </code>
              </div>
            </div>
            <DialogFooter>
              <Button size="xs" onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="text-sm text-red bg-red/10 rounded p-2">
              {phase.message}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="xs" onClick={reset}>
                Try again
              </Button>
              <Button size="xs" onClick={handleClose}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

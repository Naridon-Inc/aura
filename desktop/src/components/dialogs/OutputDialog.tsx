// Read-only modal for showing the result of a CLI passthrough. Used by
// the dispatcher whenever an Aura command runs in fire-and-show mode
// (status / doctor / impacts / handover / etc.). The host owns the
// command — this component just renders the captured stdout/stderr in
// a scrollable monospace pane with a copy button.

import { Dialog } from "../Dialog";
import { Button } from "../ui/button";

type OutputDialogProps = {
  open: boolean;
  title: string;
  body: string;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
};

export function OutputDialog({ open, title, body, loading, error, onClose }: OutputDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={680}
      footer={
        <>
          {body && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => navigator.clipboard?.writeText(body).catch(() => {})}
            >
              Copy
            </Button>
          )}
          <Button variant="default" size="xs" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? (
        <div role="alert" className="text-red text-sm">{error}</div>
      ) : body ? (
        // Render the body even while still loading so streamed agent
        // output appears live. The "running…" pill drops in next to the
        // copy button so the user can tell it isn't done.
        <pre
          className="bg-bg-1 border border-line rounded p-3 overflow-auto text-xs font-mono text-text-2 whitespace-pre-wrap leading-relaxed"
          style={{ maxHeight: "60vh" }}
        >
          {body}
          {loading && <span className="text-text-4">▌</span>}
        </pre>
      ) : loading ? (
        <div className="text-text-4 text-sm py-6 text-center">running…</div>
      ) : (
        <div className="text-text-4 text-sm">no output</div>
      )}
    </Dialog>
  );
}

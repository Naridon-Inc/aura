// Pre-flight confirmation when the user is about to commit while
// strict mode is on AND the in-session heuristic spotted tool_uses
// without a matching intent log entry. The pre-commit hook is the
// real gate — but it'll surface the failure as a CLI error after the
// commit attempt, costing the typed message. This catches it earlier
// so the user can either log intent (recommended) or proceed
// knowingly (and own the hook failure if it lands).

import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import type { StrictReadiness } from "../../lib/strictModeGate";

type StrictCommitDialogProps = {
  open: boolean;
  readiness: StrictReadiness | null;
  /** Called when the user clicks "Log intent" — App handler should
   *  open LogIntentDialog (with a prefill that lists the unpaired
   *  files) and keep this dialog dismissed. */
  onOpenLogIntent: () => void;
  /** Called when the user chooses to bypass the warning and let the
   *  commit attempt fly. The pre-commit hook will still run. */
  onContinue: () => void;
  onClose: () => void;
};

export function StrictCommitDialog({
  open,
  readiness,
  onOpenLogIntent,
  onContinue,
  onClose,
}: StrictCommitDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a note first"
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={onContinue}
            className="text-amber border-amber/40 hover:bg-bg-2"
          >
            Continue anyway
          </Button>
          <Button variant="default" size="xs" onClick={onOpenLogIntent}>
            Add a note
          </Button>
        </>
      }
    >
      <div className="text-text-2 text-[12.5px] leading-relaxed space-y-2">
        <p>
          {readiness?.unpaired ?? 0} change
          {(readiness?.unpaired ?? 0) === 1 ? "" : "s"} here don&apos;t have a
          note yet. Aura is set to ask for a short note about what changed, so
          it&apos;ll hold this save until you add one.
        </p>
        {readiness?.files && readiness.files.length > 0 && (
          <ul className="list-disc list-inside text-text-3 text-[11.5px] font-mono space-y-0.5">
            {readiness.files.map((f) => (
              <li key={f} className="truncate">
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

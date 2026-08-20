// What the agent was asked to do, next to what it actually did.
//
// This replaces a warning that counted files without notes. The difference
// matters more than it sounds: "three changes have no note" is a filing
// complaint, and a person can clear it by typing anything at all. What a
// reader actually needs to know is that a function the nightly settlement job
// depends on is gone — and no amount of note-writing surfaces that.
//
// Everything rendered here comes from `aura verify-intent --staged --json`,
// the same command the pre-commit hook runs. The dialog reformats that verdict
// and adds nothing to it. If the hook would block, this blocks; if the hook
// would pass, this passes. There is no second opinion to get out of sync.

import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import type { IntentVerdict } from "../../lib/api";

type Props = {
  open: boolean;
  verdict: IntentVerdict | null;
  /** Test summary someone actually recorded, e.g. "18 passed". Omitted when
   *  nobody ran the suite — the dialog will not invent a number. */
  tests?: string | null;
  busy?: string | null;
  onRestore: (symbol: string) => void;
  onApproveRemoval: (symbol: string) => void;
  onClose: () => void;
};

/** The one finding that stops a commit. Everything else is advisory. */
const BLOCKING = "protected_export_removed";

export function IntentVerificationDialog({
  open,
  verdict,
  tests,
  busy,
  onRestore,
  onApproveRemoval,
  onClose,
}: Props) {
  if (!verdict) return null;

  const blocking = verdict.violations.filter((v) => v.finding === BLOCKING);
  const failed = !verdict.passed && blocking.length > 0;
  const primary = blocking[0];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      title={failed ? "This doesn't match what you asked for" : "Matches what you asked for"}
      footer={
        failed ? (
          <>
            <Button variant="ghost" size="xs" onClick={onClose} disabled={!!busy}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={!!busy}
              onClick={() => primary && onApproveRemoval(primary.symbol)}
              className="text-amber border-amber/40 hover:bg-state-hover"
            >
              Allow the removal
            </Button>
            <Button
              variant="accentSoft"
              size="xs"
              disabled={!!busy}
              onClick={() => primary && onRestore(primary.symbol)}
            >
              {busy ?? `Put ${primary?.symbol}() back`}
            </Button>
          </>
        ) : (
          <Button variant="accentSoft" size="xs" onClick={onClose}>
            Save
          </Button>
        )
      }
    >
      <div className="space-y-4 text-base leading-relaxed">
        <Field label="You asked for">
          <span className="text-text-1">{verdict.goal}</span>
        </Field>

        {failed ? (
          <>
            <Field label="What changed instead">
              <div className="text-text-1">
                {blocking.length === 1
                  ? "A function was deleted that you asked to keep:"
                  : "Functions were deleted that you asked to keep:"}
              </div>
              <div className="mt-1 space-y-0.5">
                {blocking.map((v) => (
                  <div key={v.symbol} className="font-mono text-sm text-amber">
                    {v.symbol}()
                    <span className="ml-2 text-text-3">{v.file}</span>
                  </div>
                ))}
              </div>
            </Field>

            {blocking.map((v) => {
              const chain = verdict.dependents[v.symbol]?.dependents ?? [];
              if (chain.length === 0) return null;
              const unsure = chain.filter((d) => !d.certain).length;
              return (
                <Field key={v.symbol} label="What stops working">
                  <div className="space-y-0.5 font-mono text-sm">
                    {chain.map((d) => (
                      <div
                        key={`${d.symbol}-${d.depth}`}
                        style={{ paddingLeft: (d.depth - 1) * 14 }}
                        className="text-text-2"
                      >
                        {d.symbol}()
                        <span className="ml-2 text-text-3">{d.file}</span>
                      </div>
                    ))}
                  </div>
                  {unsure > 0 && (
                    <div className="mt-1 text-sm text-text-3">
                      {unsure} of these matched on name alone. Worth checking by
                      hand.
                    </div>
                  )}
                </Field>
              );
            })}
          </>
        ) : (
          <Field label="What changed">
            <Count n={verdict.requested_changed.length} noun="function" verb="you asked to change" />
            <Count n={verdict.unexpected_changed.length} noun="function" verb="nobody asked to change" />
            <Count n={verdict.protected_removed.length} noun="function" verb="removed that you asked to keep" />
          </Field>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line-soft pt-3 text-sm text-text-3">
          <Meta label="Agent" value={verdict.agent} />
          {verdict.worktree && <Meta label="Worktree" value={verdict.worktree} />}
          {tests && <Meta label="Tests" value={tests} />}
        </div>

        {failed && (
          // Said plainly, because it is the whole argument. The tests passing
          // is not a rebuttal — it is the reason this screen has to exist.
          <p className="text-sm text-text-3">
            Git recorded the text change and the tests passed. Neither of them
            knows which behaviour the agent was allowed to change.
          </p>
        )}
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="section-label mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span className="text-text-2">{value}</span>
    </span>
  );
}

/** A count only reads as reassuring when the zero cases are visible next to
 *  the non-zero one, so every line is printed even when it is nothing. */
function Count({ n, noun, verb }: { n: number; noun: string; verb: string }) {
  return (
    <div className={n > 0 ? "text-text-1" : "text-text-3"}>
      {n} {n === 1 ? noun : `${noun}s`} {verb}
    </div>
  );
}

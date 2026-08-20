// CopyField — a value you are meant to send to someone else, with the one
// button that gets it out of the app. The link and the join code both wear it,
// so a person copying a code and a person copying a link are doing the same
// gesture rather than learning two.
//
// The value is selectable text in a readonly input rather than a styled <div>:
// people copy by triple-clicking as often as they press buttons, and a div
// takes that gesture and gives them a partial selection.

import { useState, type JSX, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "../../ui/button";
import { useCopyToClipboard } from "../../../lib/useCopyToClipboard";
import { cn } from "../../../lib/utils";

export type CopyFieldProps = {
  /** What this value is, in two or three words. */
  label: string;
  /** The value itself — copied verbatim. */
  value: string;
  /** A quieter line under the field. */
  hint?: ReactNode;
  /** Monospace + wide tracking, for a short code meant to be read aloud. */
  code?: boolean;
  /** Extra control on the right of the label row — e.g. "New code". */
  aside?: ReactNode;
};

export function CopyField({
  label,
  value,
  hint,
  code = false,
  aside,
}: CopyFieldProps): JSX.Element {
  const { copy, copied } = useCopyToClipboard();
  const [failed, setFailed] = useState(false);

  async function onCopy() {
    setFailed(false);
    try {
      await copy(value);
    } catch {
      // A clipboard that refuses is rare and completely silent otherwise —
      // the button would flash nothing and the person would paste the last
      // thing they copied into a colleague's chat.
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-4">{label}</span>
        {aside}
      </div>

      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={label}
          className={cn(
            "h-8 min-w-0 flex-1 rounded-md border border-line-soft bg-bg-1 px-2.5 text-text-2 outline-none",
            "focus:border-line",
            code
              ? "font-mono text-md tracking-[0.18em]"
              : "font-mono text-sm",
          )}
        />
        <Button
          variant="subtle"
          size="sm"
          className="shrink-0"
          onClick={() => void onCopy()}
        >
          {copied ? (
            <Check size={13} className="text-accent-green" />
          ) : (
            <Copy size={13} />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      {failed ? (
        <p role="alert" className="text-xs leading-snug text-red">
          Couldn&apos;t reach the clipboard. Select the text above and copy it
          by hand.
        </p>
      ) : hint ? (
        <p className="text-xs leading-snug text-text-4">{hint}</p>
      ) : null}
    </div>
  );
}

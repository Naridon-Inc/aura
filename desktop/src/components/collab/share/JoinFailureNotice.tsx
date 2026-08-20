// JoinFailureNotice — the four ways getting into someone's session can fail,
// each told as a cause rather than a status code.
//
// The load-bearing decision here is which failures offer a retry. A mistyped
// code is worth a second go; being outside the team that owns the session is
// not, and putting "Try again" under that message leaves someone retyping six
// characters that were never going to work. `joinFailureCopy` owns that verdict
// so the button can't disagree with the sentence above it.
//
// The glyph is amber, matching `ui/state`'s ErrorState: this is the one place a
// colour is spent, because a failure is the only state that needs the reader to
// do something. Red is kept for things that actually broke.

import type { JSX } from "react";
import { CircleAlert } from "lucide-react";

import { Button } from "../../ui/button";
import { joinFailureCopy, type JoinFailure } from "./shareTypes";

export type JoinFailureNoticeProps = {
  failure: JoinFailure;
  /** Clear it and go back to the code box, ready for another try. */
  onTryAnother: () => void;
  /** Clear it and go back, with nothing more to attempt. */
  onBack: () => void;
};

export function JoinFailureNotice({
  failure,
  onTryAnother,
  onBack,
}: JoinFailureNoticeProps): JSX.Element {
  const copy = joinFailureCopy(failure);
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 px-5 py-10 text-center"
    >
      <CircleAlert size={28} strokeWidth={1.25} className="text-amber" aria-hidden />
      <div className="flex flex-col gap-1.5">
        <p className="text-lg font-semibold text-text-1">{copy.title}</p>
        <p className="max-w-[420px] text-base leading-snug text-text-3">
          {copy.body}
        </p>
      </div>
      {copy.retryable ? (
        <Button variant="subtle" size="sm" onClick={onTryAnother}>
          Try another code
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
      )}
    </div>
  );
}

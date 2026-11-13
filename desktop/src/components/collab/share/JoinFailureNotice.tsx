// JoinFailureNotice — the four ways getting into someone's session can fail,
// each told as a cause rather than a status code.
//
// The load-bearing decision here is which failures offer a retry. A mistyped
// code is worth a second go; being outside the team that owns the session is
// not, and putting "Try again" under that message leaves someone retyping six
// characters that were never going to work. `joinFailureCopy` owns that verdict
// so the button can't disagree with the sentence above it.
//
// It is the library's ErrorState: the one place a colour is spent, because a
// failure is the only state that needs the reader to do something. The way
// out is its action — another code when one could work, back when none will.

import type { JSX } from "react";

import { ErrorState } from "../../ui/state";
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
    <ErrorState
      title={copy.title}
      message={copy.body}
      action={
        copy.retryable
          ? { label: "Try another code", onClick: onTryAnother }
          : { label: "Back", onClick: onBack }
      }
    />
  );
}

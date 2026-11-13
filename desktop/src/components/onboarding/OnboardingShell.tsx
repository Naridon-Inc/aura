// The frame first run sits in. It owns the whole window until setup is done,
// and inside it the walkthrough is the shared step flow: the steps down the
// left, one page beside them. A step not reached yet stays shut; one already
// passed wears a tick, and clicking it goes back.
//
// A screen that stands on its own (the one-time support ask, the sign-in
// surface opened from elsewhere) uses OnboardingPage: the same page, no steps.

import type { ReactNode } from "react";
import { SetupFlow } from "../ui/setup-flow";
import "../ui/cloud-onboarding.css";
import "../ui/onboarding.css";

/** The walkthrough's steps, in order. New repository is a page of Repository. */
export const ONBOARDING_STEPS = ["Sign in", "Agents", "Repository"];

export function OnboardingShell({
  step,
  furthest,
  onStep,
  children,
}: {
  /** The step showing now, or null for a page with no steps beside it. */
  step: number | null;
  furthest: number;
  onStep: (index: number) => void;
  children: ReactNode;
}) {
  return (
    // A modal surface: it owns the whole window until first run finishes, so
    // screen readers should treat everything behind it as inert.
    // no-escape-dismissal: there is nothing to fall back to until setup is
    // done, so there is nowhere for Escape to go.
    <div
      className="ui-onboarding"
      role="dialog"
      aria-modal="true"
      aria-label="Set up Aura"
      data-onboarding-v2
    >
      {step === null ? (
        <OnboardingPage>{children}</OnboardingPage>
      ) : (
        <SetupFlow
          label="Setup steps"
          steps={ONBOARDING_STEPS}
          step={step}
          furthest={furthest}
          onStep={onStep}
        >
          {children}
        </SetupFlow>
      )}
    </div>
  );
}

/** One setup page with no step list beside it. */
export function OnboardingPage({ children }: { children: ReactNode }) {
  return (
    <div className="ui-cloud-setup">
      <main className="ui-cloud-setup-page">{children}</main>
    </div>
  );
}

// First run. Three steps in the shared step flow:
//
//   Sign in  -> GitHub / GitLab / Google, or skip
//   Agents   -> connect a coding agent (optional)
//   Project  -> open one (drop a folder, choose one, a recent) or make a new
//               one (empty / clone / template) on the same step
//
// Plus one page that is not part of that walkthrough:
//
//   support  -> Aura is open source (star + community). Shown once, on a
//               genuinely new install, on its own — see below.
//
// It re-opens on the `aura:open-onboarding` event and stamps
// localStorage["aura.onboarding.complete"] on finish. Opening or creating a
// project dispatches `aura:open-repo-picker-path`, which App.tsx already
// turns into loadProjectAt().

import { useCallback, useEffect, useState } from "react";
import { OnboardingShell } from "./OnboardingShell";
import { SignInScreen } from "./SignInScreen";
import { ConnectAgentScreen } from "./ConnectAgentScreen";
import { OpenProjectScreen } from "./OpenProjectScreen";
import { NewProjectScreen } from "./NewProjectScreen";
import { SupportAuraScreen } from "./SupportAuraScreen";
import { markGreeted, noteAppOpened, shouldGreet } from "../../lib/community";

const COMPLETE_KEY = "aura.onboarding.complete";

type Step = "signin" | "agent" | "open" | "new" | "support";

/** Where each page sits in the step list; support stands alone. */
const STEP_INDEX: Record<Step, number | null> = {
  signin: 0,
  agent: 1,
  open: 2,
  new: 2,
  support: null,
};
const STEP_AT: Step[] = ["signin", "agent", "open"];

export function OnboardingFlow() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("signin");
  const [furthest, setFurthest] = useState(0);
  const [newBusy, setNewBusy] = useState(false);

  const go = useCallback((next: Step) => {
    setStep(next);
    const at = STEP_INDEX[next];
    if (at !== null) setFurthest((v) => Math.max(v, at));
  }, []);

  // The walkthrough doesn't open by itself on first launch. First run is the
  // pre-populated "Get Started" workspace (Recipe Box) the app boots onto —
  // a real project beats a walkthrough — so these steps are opt-in, opened
  // from Settings via the `aura:open-onboarding` event below. COMPLETE_KEY is
  // still stamped so anything keying off "onboarded" reads true from the
  // first launch.
  //
  // The one thing that does show on a new install is the support page: a
  // single ask, on its own, before the person has a project open and
  // anything to lose by reading it. It never returns — `markGreeted` is
  // stamped whether they act or skip.
  useEffect(() => {
    try {
      localStorage.setItem(COMPLETE_KEY, "1");
    } catch {
      /* private mode — ignore */
    }
    if (shouldGreet(noteAppOpened())) {
      setStep("support");
      setOpen(true);
    }
  }, []);

  // Re-openable from Settings.
  useEffect(() => {
    const onOpen = () => {
      try {
        localStorage.removeItem(COMPLETE_KEY);
      } catch {
        /* private mode */
      }
      setStep("signin");
      setFurthest(0);
      setNewBusy(false);
      setOpen(true);
    };
    window.addEventListener("aura:open-onboarding", onOpen);
    return () => window.removeEventListener("aura:open-onboarding", onOpen);
  }, []);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(COMPLETE_KEY, "1");
    } catch {
      /* private mode */
    }
    setOpen(false);
  }, []);

  // The support page stands alone: finishing it closes the surface and
  // spends the one ask this install gets.
  const finishSupport = useCallback(() => {
    markGreeted();
    setOpen(false);
  }, []);

  if (!open) return null;

  return (
    <OnboardingShell
      step={STEP_INDEX[step]}
      furthest={furthest}
      // While a create is in flight the steps hold still: leaving would
      // strand a half-made repository with nothing showing its progress.
      onStep={(i) => {
        if (!newBusy) go(STEP_AT[i]);
      }}
    >
      {step === "signin" && (
        <SignInScreen onAuthed={() => go("agent")} onSkip={() => go("open")} />
      )}
      {step === "agent" && <ConnectAgentScreen onDone={() => go("open")} />}
      {step === "open" && (
        <OpenProjectScreen onOpened={() => finish()} onNewProject={() => go("new")} />
      )}
      {step === "new" && (
        <NewProjectScreen onCreated={() => finish()} onBusyChange={setNewBusy} />
      )}
      {step === "support" && <SupportAuraScreen onDone={finishSupport} />}
    </OnboardingShell>
  );
}

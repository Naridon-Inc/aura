// First-run flow (v2). Four calm, full-bleed screens modeled on the
// reference editor's onboarding, rendered on Aura tokens:
//
//   signin  -> Sign in (GitHub / GitLab / Google) or Skip
//   agent   -> Connect a coding agent (optional)
//   open    -> Open Project (drop-zone + recents)
//   new     -> New Project (Empty / Clone / Template)
//
// Mount contract matches the legacy OnboardingDialog so exactly one
// first-run surface exists: it auto-opens when
// localStorage["aura.onboarding.complete"] !== "1", re-opens on the
// `aura:open-onboarding` event, and marks complete on finish. Opening or
// creating a project dispatches `aura:open-repo-picker-path`, which App.tsx
// already turns into loadProjectAt().

import { useCallback, useEffect, useState } from "react";
import { OnboardingShell } from "./OnboardingShell";
import { SignInScreen } from "./SignInScreen";
import { ConnectAgentScreen } from "./ConnectAgentScreen";
import { OpenProjectScreen } from "./OpenProjectScreen";
import { NewProjectScreen } from "./NewProjectScreen";

const COMPLETE_KEY = "aura.onboarding.complete";

type Step = "signin" | "agent" | "open" | "new";

export function OnboardingFlow() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("signin");
  const [newBusy, setNewBusy] = useState(false);

  // No longer auto-opens on first launch. First-run onboarding is now the
  // pre-populated "Get Started" workspace (Recipe Box) the app boots onto —
  // seeing a real project beats a four-screen walkthrough — so this flow is
  // opt-in only, re-opened from Settings via the `aura:open-onboarding` event
  // below. We still stamp COMPLETE_KEY so anything keying off "onboarded" reads
  // true from the first launch.
  useEffect(() => {
    try {
      localStorage.setItem(COMPLETE_KEY, "1");
    } catch {
      /* private mode — ignore */
    }
  }, []);

  // Re-openable from Settings (same event the legacy dialog used).
  useEffect(() => {
    const onOpen = () => {
      try {
        localStorage.removeItem(COMPLETE_KEY);
      } catch {
        /* private mode */
      }
      setStep("signin");
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

  if (!open) return null;

  // Back target per step (signin is the entry, so no Back there). While a
  // create is in flight on the New Project screen we drop Back.
  const back: (() => void) | null =
    step === "agent"
      ? () => setStep("signin")
      : step === "open"
        ? () => setStep("agent")
        : step === "new" && !newBusy
          ? () => setStep("open")
          : null;

  return (
    <OnboardingShell onBack={back}>
      {step === "signin" && (
        <SignInScreen
          onAuthed={() => setStep("agent")}
          onSkip={() => setStep("open")}
        />
      )}
      {step === "agent" && (
        <ConnectAgentScreen
          onDone={() => setStep("open")}
          onSkip={() => setStep("open")}
        />
      )}
      {step === "open" && (
        <OpenProjectScreen
          onOpened={() => finish()}
          onNewProject={() => setStep("new")}
        />
      )}
      {step === "new" && (
        <NewProjectScreen onCreated={() => finish()} onBusyChange={setNewBusy} />
      )}
    </OnboardingShell>
  );
}

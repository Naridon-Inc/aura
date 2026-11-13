// SignInWizard — the sign-in surface opened when someone clicks "Sign in"
// anywhere in the app (the titlebar avatar, the Settings row, a team-chat
// nudge).
//
// It reuses first run's SignInScreen (the real aura-cloud device-code flow
// via useDeviceSignIn) on the same setup page, inside the app's standard
// focus surface, so there's one set of auth logic and one sign-in design. No
// title — the page's own heading carries it, matching FullscreenOverlay's
// contract. Esc, the corner chip, or "Skip" closes; a successful sign-in
// closes and tells every auth-aware surface.

import { FullscreenOverlay } from "../FullscreenOverlay";
import { OnboardingPage } from "../onboarding/OnboardingShell";
import { SignInScreen } from "../onboarding/SignInScreen";

export function SignInWizard({ onClose }: { onClose: () => void }) {
  // On approval, broadcast so the avatar, team-chat banner, and every other
  // auth-aware surface refresh without an app restart, then dismiss.
  const done = () => {
    window.dispatchEvent(new CustomEvent("aura:cloud-auth-changed"));
    onClose();
  };

  return (
    <FullscreenOverlay onClose={onClose}>
      <OnboardingPage>
        <SignInScreen onAuthed={done} onSkip={onClose} />
      </OnboardingPage>
    </FullscreenOverlay>
  );
}

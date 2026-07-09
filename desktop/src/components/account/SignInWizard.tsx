// SignInWizard — the full-screen welcome surface, opened when someone clicks
// "Sign in" anywhere in the app (the titlebar avatar, the Settings row, a
// team-chat nudge). Modelled on the reference editor's calm welcome: the AURA
// wordmark, "Welcome to Aura", "Sign in to get started", and the provider
// buttons — far roomier and more inviting than a cramped popover.
//
// It reuses the exact onboarding SignInScreen (the real aura-cloud device-code
// flow via useDeviceSignIn) inside the app's standard focus surface, so there's
// one set of auth logic and one welcome design. No title — the wordmark carries
// the identity, matching FullscreenOverlay's contract. Esc, the corner chip, or
// "Skip" closes; a successful sign-in closes and tells every auth-aware surface.

import { FullscreenOverlay } from "../FullscreenOverlay";
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
      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center">
        <SignInScreen onAuthed={done} onSkip={onClose} />
      </div>
    </FullscreenOverlay>
  );
}

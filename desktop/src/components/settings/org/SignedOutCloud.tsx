import { Cloud } from "lucide-react";
import { EmptyState } from "../../ui/state";

/** The cloud pages' face before sign-in: what signing in opens, and the way to it. */
export function SignedOutCloud({ what, onSignIn }: { what: string; onSignIn: () => void }) {
  return (
    <EmptyState
      icon={Cloud}
      title="Sign in to Aura Cloud"
      body={`Sign in to ${what}.`}
      action={{ label: "Open Account", onClick: onSignIn }}
    />
  );
}

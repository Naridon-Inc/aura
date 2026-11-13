// First run, step one: sign in. Three providers wired to the aura-cloud
// device-code flow (GitHub and GitLab are live; Google goes live once the
// backend Google OAuth app is provisioned). Signing in is optional — Skip
// goes straight to opening a project.

import type { ReactNode } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { GitHubMark, GitLabMark, GoogleMark } from "./icons";
import { useDeviceSignIn, type SignInProvider } from "./useDeviceSignIn";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import "../ui/cloud-onboarding.css";
import "../ui/cloud-patterns.css";
import "../ui/onboarding.css";

const PROVIDERS: { id: SignInProvider; label: string; icon: ReactNode }[] = [
  { id: "github", label: "Continue with GitHub", icon: <GitHubMark /> },
  { id: "gitlab", label: "Continue with GitLab", icon: <GitLabMark /> },
  { id: "google", label: "Continue with Google", icon: <GoogleMark /> },
];

export function SignInScreen({
  onAuthed,
  onSkip,
}: {
  onAuthed: () => void;
  onSkip: () => void;
}) {
  const signIn = useDeviceSignIn(onAuthed);
  const busy = signIn.status === "starting" || signIn.status === "waiting";

  return (
    <>
      <header>
        <h1>Welcome to Aura</h1>
        <p>Sign in to get started.</p>
      </header>

      <div className="ui-cloud-agent-connections ui-onboarding-rows">
        {PROVIDERS.map((p) => {
          const active = signIn.activeProvider === p.id && busy;
          const blocked = busy && !active;
          return (
            <button
              key={p.id}
              type="button"
              disabled={blocked}
              data-blocked={blocked ? "" : undefined}
              onClick={() => (active ? signIn.cancel() : signIn.begin(p.id))}
            >
              {p.icon}
              <span>{p.label}</span>
              {active ? (
                <small>
                  <AsciiSpinner size={10} />
                  Waiting for browser…
                </small>
              ) : (
                <ArrowUpRight size={14} aria-hidden />
              )}
            </button>
          );
        })}
      </div>

      {signIn.status === "waiting" && signIn.userCode ? (
        <div className="ui-cloud-inline">
          <small>
            Approve in your browser. Code{" "}
            <span className="ui-onboarding-code">{signIn.userCode}</span>
          </small>
          <Button type="button" variant="ghost" size="xs" onClick={signIn.cancel}>
            Cancel
          </Button>
        </div>
      ) : null}

      {signIn.status === "approved" ? (
        <div className="ui-cloud-inline">
          <Check size={15} aria-hidden />
          <small>Signed in</small>
        </div>
      ) : null}

      {signIn.status === "error" && signIn.error ? (
        <Alert variant="destructive" className="ui-onboarding-alert">
          <AlertDescription>{signIn.error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="button" variant="outline" onClick={onSkip} disabled={busy}>
        Skip for now
      </Button>

      <small>By signing in, you agree to our Terms of Service and Privacy Policy.</small>
    </>
  );
}

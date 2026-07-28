// Screen 1 — Sign in. Three OAuth providers wired to the aura-cloud
// device-code flow (GitHub + GitLab are live today; Google goes live once
// the backend Google OAuth app is provisioned). Sign-in is optional: Skip
// drops straight to Open Project. Calm, centered, references-grade.

import { OnboardingCenter } from "./OnboardingShell";
import {
  GitHubMark,
  GitLabMark,
  GoogleMark,
  CheckIcon,
} from "./icons";
import {
  useDeviceSignIn,
  type SignInProvider,
} from "./useDeviceSignIn";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import type { ReactNode } from "react";

const PROVIDERS: {
  id: SignInProvider;
  label: string;
  icon: ReactNode;
}[] = [
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
    <OnboardingCenter>
      <div className="text-center">
        <div className="text-[15px] font-semibold text-text-1">
          Welcome to Aura
        </div>
        <div className="mt-1.5 text-[12.5px] text-text-3">
          Sign in to get started
        </div>
      </div>

      <div className="mt-7 w-full flex flex-col gap-2">
        {PROVIDERS.map((p) => {
          const active = signIn.activeProvider === p.id && busy;
          return (
            <button
              key={p.id}
              type="button"
              disabled={busy && !active}
              onClick={() => (active ? signIn.cancel() : signIn.begin(p.id))}
              className="group relative h-11 w-full inline-flex items-center justify-center gap-2.5 rounded-md border border-line-soft bg-bg-2 text-[13px] font-medium text-text-1 hover:bg-bg-3 hover:border-line-strong disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <span className="absolute left-3.5 inline-flex items-center">
                {active ? <AsciiSpinner className="text-[13px] leading-none" /> : p.icon}
              </span>
              {active ? "Waiting for browser…" : p.label}
            </button>
          );
        })}
      </div>

      {signIn.status === "waiting" && signIn.userCode ? (
        <div className="mt-4 text-center text-[11.5px] text-text-3">
          Approve in your browser. Code{" "}
          <span className="font-mono text-text-1 tracking-wider">
            {signIn.userCode}
          </span>
          {" · "}
          <button
            type="button"
            onClick={signIn.cancel}
            className="text-text-3 hover:text-text-1 underline underline-offset-2 transition-colors"
          >
            cancel
          </button>
        </div>
      ) : null}

      {signIn.status === "approved" ? (
        <div className="mt-4 inline-flex items-center gap-1.5 text-[11.5px] text-accent-green">
          <CheckIcon /> Signed in
        </div>
      ) : null}

      {signIn.status === "error" && signIn.error ? (
        <div className="mt-4 max-w-[320px] text-center text-[11.5px] text-red">
          {signIn.error}
        </div>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="lg"
        onClick={onSkip}
        disabled={busy}
        className="mt-7"
      >
        Skip for now
      </Button>

      <div className="mt-6 max-w-[320px] text-center text-[10.5px] leading-relaxed text-text-5">
        By signing in, you agree to our{" "}
        <span className="text-text-4 underline underline-offset-2">
          Terms of Service
        </span>{" "}
        and{" "}
        <span className="text-text-4 underline underline-offset-2">
          Privacy Policy
        </span>
        .
      </div>
    </OnboardingCenter>
  );
}

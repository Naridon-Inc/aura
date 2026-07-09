// Drives the aura-cloud device-code OAuth from the sign-in screen.
//
// Flow (matches cmd_cloud_auth.rs): start -> open the verify URL in the
// browser (with the chosen provider hint) -> poll until the server reports
// `approved`, then the token is already written to ~/.aura/credentials.json
// and we resolve. The provider buttons all share this one hook; only the
// `provider` hint differs.

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../lib/api";

export type SignInProvider = "github" | "gitlab" | "google";

export type SignInStatus =
  | "idle"
  | "starting"
  | "waiting"
  | "approved"
  | "error";

export type DeviceSignIn = {
  status: SignInStatus;
  /** Provider currently mid-flow (for the per-button spinner). */
  activeProvider: SignInProvider | null;
  /** Short code shown to the user to confirm against the browser. */
  userCode: string | null;
  error: string | null;
  begin: (provider: SignInProvider) => void;
  cancel: () => void;
};

export function useDeviceSignIn(onApproved: () => void): DeviceSignIn {
  const [status, setStatus] = useState<SignInStatus>("idle");
  const [activeProvider, setActiveProvider] = useState<SignInProvider | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Cancellation token: bumped on cancel/unmount so an in-flight poll loop
  // knows to stop touching state.
  const runRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onApprovedRef = useRef(onApproved);
  onApprovedRef.current = onApproved;

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const cancel = useCallback(() => {
    runRef.current += 1;
    clearTimer();
    setStatus("idle");
    setActiveProvider(null);
    setUserCode(null);
    setError(null);
  }, []);

  useEffect(() => () => {
    runRef.current += 1;
    clearTimer();
  }, []);

  const begin = useCallback((provider: SignInProvider) => {
    const run = ++runRef.current;
    clearTimer();
    setStatus("starting");
    setActiveProvider(provider);
    setUserCode(null);
    setError(null);

    api
      .cloudAuthStart(undefined, provider)
      .then(async (start) => {
        if (run !== runRef.current) return;
        setUserCode(start.user_code);
        setStatus("waiting");
        try {
          await openUrl(start.verify_url);
        } catch {
          /* browser failed to open — the code is still shown for manual use */
        }

        const intervalMs = Math.max(2, start.poll_interval) * 1000;
        const deadline = Date.now() + Math.max(60, start.expires_in) * 1000;

        const tick = () => {
          if (run !== runRef.current) return;
          if (Date.now() > deadline) {
            setStatus("error");
            setError("Sign-in timed out. Try again.");
            return;
          }
          api
            .cloudAuthPoll(start.device_code, start.cloud_url)
            .then((res) => {
              if (run !== runRef.current) return;
              if (res.status === "approved") {
                setStatus("approved");
                onApprovedRef.current();
                return;
              }
              if (res.status === "pending") {
                timerRef.current = setTimeout(tick, intervalMs);
                return;
              }
              // expired | invalid | used
              setStatus("error");
              setError(
                res.status === "expired"
                  ? "Sign-in expired. Try again."
                  : "Sign-in could not be completed. Try again.",
              );
            })
            .catch((e) => {
              if (run !== runRef.current) return;
              // Transient network hiccup — keep polling until the deadline.
              if (Date.now() <= deadline) {
                timerRef.current = setTimeout(tick, intervalMs);
              } else {
                setStatus("error");
                setError(String(e));
              }
            });
        };
        timerRef.current = setTimeout(tick, intervalMs);
      })
      .catch((e) => {
        if (run !== runRef.current) return;
        setStatus("error");
        setError(
          `Couldn't reach Aura Cloud. ${String(e).slice(0, 120)}`,
        );
      });
  }, []);

  return { status, activeProvider, userCode, error, begin, cancel };
}

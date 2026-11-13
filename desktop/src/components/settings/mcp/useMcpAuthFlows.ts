// The two browser sign-in flows the auth dialog can run for one server, and
// the log they share.
//
// Native OAuth 2.1 + PKCE is the primary path when the server has a remote
// URL. The mcp-remote piggyback covers servers whose config wraps a URL that
// was never promoted to `server_url`. Both write to the per-server
// `mcp:auth_log:<name>` topic, so one log view shows whichever flow ran.

import { useCallback, useState } from "react";
import { api } from "../../../lib/api";

export type AuthOutcome = { ok: boolean; text: string };

/** Keep the last 200 lines so a runaway proxy can't grow the tree forever. */
function appendLine(prev: string[], line: string): string[] {
  const next = [...prev, line];
  return next.length > 200 ? next.slice(-200) : next;
}

export function useMcpAuthFlows(
  name: string,
  onSaved: () => void | Promise<void>,
  setError: (error: string | null) => void,
) {
  const [authBusy, setAuthBusy] = useState(false);
  const [authLog, setAuthLog] = useState<string[]>([]);
  const [authResult, setAuthResult] = useState<AuthOutcome | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeResult, setNativeResult] = useState<AuthOutcome | null>(null);

  const runBrowserAuth = useCallback(async () => {
    setAuthBusy(true);
    setAuthLog([]);
    setAuthResult(null);
    setError(null);
    // Subscribe to per-server log + url topics. We unsubscribe in the
    // finally block so a second auth attempt doesn't double-fire.
    const { listen } = await import("@tauri-apps/api/event");
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    let urlOpened = false;
    const unlistenLog = await listen<string>(`mcp:auth_log:${name}`, (e) => {
      setAuthLog((prev) => appendLine(prev, e.payload));
    });
    const unlistenUrl = await listen<string>(`mcp:auth_url:${name}`, (e) => {
      if (urlOpened) return;
      urlOpened = true;
      void openUrl(e.payload).catch((err) => {
        console.warn("openUrl failed:", err);
      });
    });
    try {
      const res = await api.mcpServersAuthRun(name);
      if (res.timed_out) {
        setAuthResult({
          ok: false,
          text: "Timed out after 5 minutes. If you completed the browser flow, the token may still be cached. Try Save & retry. Otherwise re-run Authenticate.",
        });
      } else if (res.exit_code === 0) {
        setAuthResult({
          ok: true,
          text: "Auth succeeded. Token cached. Close this dialog and the server will probe green.",
        });
      } else {
        setAuthResult({
          ok: false,
          text: `Proxy exited with code ${res.exit_code ?? "unknown"}. Check the log for details.`,
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      unlistenLog();
      unlistenUrl();
      setAuthBusy(false);
    }
  }, [name, setError]);

  const runNativeOAuth = useCallback(async () => {
    setNativeBusy(true);
    setAuthLog([]);
    setNativeResult(null);
    setError(null);
    const { listen } = await import("@tauri-apps/api/event");
    // The backend opens the browser itself, but we still subscribe to
    // `mcp:auth_url` so the log shows the URL inline for anyone who doesn't
    // see the browser appear.
    const unlistenLog = await listen<string>(`mcp:auth_log:${name}`, (e) => {
      setAuthLog((prev) => appendLine(prev, e.payload));
    });
    const unlistenUrl = await listen<string>(`mcp:auth_url:${name}`, (e) => {
      setAuthLog((prev) => appendLine(prev, `[link] ${e.payload}`));
    });
    try {
      await api.mcpServersOauthStart(name);
      setNativeResult({
        ok: true,
        text: "Tokens stored. Aura now holds the OAuth credentials for this server.",
      });
      await onSaved();
    } catch (e) {
      setNativeResult({ ok: false, text: String(e) });
    } finally {
      unlistenLog();
      unlistenUrl();
      setNativeBusy(false);
    }
  }, [name, onSaved, setError]);

  const clearOAuthTokens = useCallback(async () => {
    setError(null);
    try {
      await api.mcpServersOauthClear(name);
      await onSaved();
    } catch (e) {
      setError(String(e));
    }
  }, [name, onSaved, setError]);

  return {
    authBusy,
    authLog,
    authResult,
    nativeBusy,
    nativeResult,
    runBrowserAuth,
    runNativeOAuth,
    clearOAuthTokens,
  };
}

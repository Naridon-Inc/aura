// First run, step two: connect a coding agent (optional). Signs into Claude
// or Codex through each CLI's own browser login, so an agent is ready the
// moment a project opens. Agents can also be set up later from Settings.
//
// Codex gets extra care: its npm package often half-installs (the wrapper
// lands but the native binary doesn't), so `codex` is on PATH yet won't run.
// That "broken" state, and "not installed", get a command to copy instead of
// a sign-in that would quietly do nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Copy, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";
import { AgentIcon } from "../ui/agent-icon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import "../ui/cloud-onboarding.css";
import "../ui/cloud-patterns.css";
import "../ui/onboarding.css";

type AgentId = "claude" | "codex";
type ConnState = "idle" | "connecting" | "connected";

// Health of the Codex CLI, so an unrunnable install is handled honestly.
type CodexHealth = {
  state: "logged_in" | "logged_out" | "broken" | "missing" | "unknown";
  detail?: string;
  fix?: string;
  hasCreds: boolean;
};

const AGENTS: { id: AgentId; label: string; provider: string }[] = [
  { id: "claude", label: "Claude Code", provider: "anthropic" },
  { id: "codex", label: "Codex", provider: "openai" },
];

export function ConnectAgentScreen({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<Record<AgentId, ConnState>>({
    claude: "idle",
    codex: "idle",
  });
  const [codex, setCodex] = useState<CodexHealth>({ state: "unknown", hasCreds: false });
  const [err, setErr] = useState<Record<AgentId, string | null>>({
    claude: null,
    codex: null,
  });
  const { copy, copied } = useCopyToClipboard();
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [c, x] = await Promise.all([api.claudeAuthStatus(), api.codexAuthStatus()]);
      if (!aliveRef.current) return;
      setState((s) => ({
        claude: c.logged_in ? "connected" : s.claude === "connecting" ? "connecting" : "idle",
        codex: x.logged_in ? "connected" : s.codex === "connecting" ? "connecting" : "idle",
      }));
      setCodex({
        state: (x.state as CodexHealth["state"]) || (x.logged_in ? "logged_in" : "logged_out"),
        detail: x.detail ?? undefined,
        fix: x.fix_command ?? undefined,
        hasCreds: !!x.has_credentials,
      });
    } catch {
      /* CLIs may be absent — leave as idle */
    }
  }, []);

  // Reflect already-signed-in CLIs on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A Codex CLI that's on PATH but won't run (or isn't installed) can't be
  // signed into — sign-in would spawn the same broken binary. Those states
  // get a reinstall command to copy rather than the browser login.
  const codexNeedsFix = codex.state === "broken" || codex.state === "missing";

  const connect = useCallback(
    async (id: AgentId) => {
      // Guard: never start a login against an unrunnable Codex.
      if (id === "codex" && codexNeedsFix) {
        if (codex.fix) void copy(codex.fix);
        return;
      }
      setErr((e) => ({ ...e, [id]: null }));
      setState((s) => ({ ...s, [id]: "connecting" }));
      try {
        if (id === "claude") await api.claudeAuthLogin("claudeai");
        else await api.codexAuthLogin();
      } catch (e) {
        if (aliveRef.current) {
          setState((s) => ({ ...s, [id]: "idle" }));
          setErr((prev) => ({ ...prev, [id]: cleanErr(e) }));
        }
        return;
      }
      // Poll status until the CLI's browser login completes (or give up).
      const deadline = Date.now() + 180_000;
      const poll = async () => {
        if (!aliveRef.current) return;
        try {
          const st = id === "claude" ? await api.claudeAuthStatus() : await api.codexAuthStatus();
          if (!aliveRef.current) return;
          if (st.logged_in) {
            setState((s) => ({ ...s, [id]: "connected" }));
            return;
          }
        } catch {
          /* keep polling */
        }
        if (Date.now() < deadline) setTimeout(poll, 2500);
        else if (aliveRef.current) setState((s) => ({ ...s, [id]: "idle" }));
      };
      setTimeout(poll, 2500);
    },
    [codexNeedsFix, codex.fix, copy],
  );

  const anyConnected = state.claude === "connected" || state.codex === "connected";

  return (
    <>
      <header>
        <h1>Agents</h1>
        <p>Connect a coding agent now, or set one up later in Settings.</p>
      </header>

      <div className="ui-cloud-agent-connections ui-onboarding-rows">
        {AGENTS.map((a) => {
          const st = state[a.id];
          const needsFix = a.id === "codex" && codexNeedsFix;
          return (
            <button
              key={a.id}
              type="button"
              disabled={st === "connecting" || st === "connected"}
              onClick={() => connect(a.id)}
            >
              <AgentIcon provider={a.provider} size={18} />
              <span>{a.label}</span>
              {st === "connected" ? (
                <>
                  <small>Connected</small>
                  <Check size={15} aria-hidden />
                </>
              ) : st === "connecting" ? (
                <small>
                  <AsciiSpinner size={10} />
                  Waiting…
                </small>
              ) : needsFix ? (
                <>
                  <small>{codex.state === "missing" ? "Not installed" : "Needs reinstall"}</small>
                  <TriangleAlert size={14} aria-hidden />
                </>
              ) : (
                <>
                  <small>Connect</small>
                  <ArrowUpRight size={14} aria-hidden />
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* Broken or missing Codex: say so, and hand over the fix to copy. */}
      {codexNeedsFix && (
        <div className="ui-cloud-setup-missing">
          <p>
            {codex.detail ||
              (codex.state === "missing"
                ? "The Codex CLI isn't installed."
                : "Codex is installed but won't run. It needs reinstalling.")}
            {codex.hasCreds &&
              " You're already signed in to Codex. This just repairs the command-line tool."}
          </p>
          {codex.fix && (
            <div className="ui-cloud-inline ui-onboarding-command">
              <code className="ui-cloud-setup-command">{codex.fix}</code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void copy(codex.fix!)}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
          <p className="ui-cloud-note">
            Run it in your terminal, then come back to this step. You can also set Codex up
            later.
          </p>
        </div>
      )}

      {/* Why a sign-in didn't finish, in the CLI's own words. */}
      {AGENTS.map((a) =>
        err[a.id] && !(a.id === "codex" && codexNeedsFix) ? (
          <Alert key={a.id} variant="destructive" className="ui-onboarding-alert">
            <AlertDescription>
              {a.label}: {err[a.id]}
            </AlertDescription>
          </Alert>
        ) : null,
      )}

      <Button type="button" onClick={onDone}>
        {anyConnected ? "Continue" : "Continue without an agent"} <ArrowRight />
      </Button>
    </>
  );
}

// Trim Tauri's `invoke` error envelope down to the CLI's own message.
function cleanErr(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  return s.replace(/^Error:\s*/i, "").trim() || "Sign-in didn't complete.";
}

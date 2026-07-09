// Screen 2 — Connect a coding agent (optional). One slim step that signs
// the user into Claude or Codex via each CLI's native OAuth (the same calls
// the old onboarding's provider panels made), so an agent is ready the
// moment a project opens. Fully skippable — agents can also be set up later
// from Settings.

import { useCallback, useEffect, useRef, useState } from "react";
import { OnboardingCenter } from "./OnboardingShell";
import { Spinner, CheckIcon } from "./icons";
import { Button } from "../ui/button";
import { api } from "../../lib/api";

type AgentId = "claude" | "codex";
type ConnState = "idle" | "connecting" | "connected";

const AGENTS: { id: AgentId; label: string; hint: string; glyph: string }[] = [
  { id: "claude", label: "Claude Code", hint: "Anthropic · Pro or API", glyph: "✳" },
  { id: "codex", label: "Codex", hint: "OpenAI · ChatGPT or API", glyph: "◇" },
];

export function ConnectAgentScreen({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const [state, setState] = useState<Record<AgentId, ConnState>>({
    claude: "idle",
    codex: "idle",
  });
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [c, x] = await Promise.all([
        api.claudeAuthStatus(),
        api.codexAuthStatus(),
      ]);
      if (!aliveRef.current) return;
      setState((s) => ({
        claude: c.logged_in ? "connected" : s.claude === "connecting" ? "connecting" : "idle",
        codex: x.logged_in ? "connected" : s.codex === "connecting" ? "connecting" : "idle",
      }));
    } catch {
      /* CLIs may be absent — leave as idle */
    }
  }, []);

  // Reflect already-signed-in CLIs on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (id: AgentId) => {
      setState((s) => ({ ...s, [id]: "connecting" }));
      try {
        if (id === "claude") await api.claudeAuthLogin("claudeai");
        else await api.codexAuthLogin();
      } catch {
        if (aliveRef.current) setState((s) => ({ ...s, [id]: "idle" }));
        return;
      }
      // Poll status until the CLI's browser login completes (or give up).
      const deadline = Date.now() + 180_000;
      const poll = async () => {
        if (!aliveRef.current) return;
        try {
          const st =
            id === "claude"
              ? await api.claudeAuthStatus()
              : await api.codexAuthStatus();
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
    [],
  );

  const anyConnected = state.claude === "connected" || state.codex === "connected";

  return (
    <OnboardingCenter width={380}>
      <div className="text-center">
        <div className="text-[15px] font-semibold text-text-1">
          Connect a coding agent
        </div>
        <div className="mt-1.5 text-[12.5px] text-text-3">
          Optional — sign in now, or set this up later in Settings.
        </div>
      </div>

      <div className="mt-7 w-full flex flex-col gap-2">
        {AGENTS.map((a) => {
          const st = state[a.id];
          return (
            <button
              key={a.id}
              type="button"
              disabled={st !== "idle"}
              onClick={() => connect(a.id)}
              className="group flex items-center gap-3 h-[52px] w-full px-3.5 rounded-md border border-line-soft bg-bg-2 hover:bg-bg-3 hover:border-line-strong disabled:hover:bg-bg-2 transition-colors text-left"
            >
              <span className="w-8 h-8 shrink-0 rounded-md bg-bg-1 border border-line-soft inline-flex items-center justify-center text-[15px] text-text-2">
                {a.glyph}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium text-text-1">
                  {a.label}
                </span>
                <span className="block text-[11px] text-text-4">{a.hint}</span>
              </span>
              <span className="shrink-0 inline-flex items-center text-[11.5px]">
                {st === "connected" ? (
                  <span className="inline-flex items-center gap-1 text-accent-green">
                    <CheckIcon /> Connected
                  </span>
                ) : st === "connecting" ? (
                  <span className="inline-flex items-center gap-1.5 text-text-3">
                    <Spinner size={13} /> Waiting…
                  </span>
                ) : (
                  <span className="text-text-3 group-hover:text-text-1 transition-colors">
                    Connect
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <Button
        type="button"
        variant="default"
        size="lg"
        onClick={onDone}
        className="mt-7"
      >
        {anyConnected ? "Continue" : "Continue without an agent"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        onClick={onSkip}
        className="mt-2"
      >
        Skip
      </Button>
    </OnboardingCenter>
  );
}

// Screen 2 — Connect a coding agent (optional). One slim step that signs
// the user into Claude or Codex via each CLI's native OAuth (the same calls
// the old onboarding's provider panels made), so an agent is ready the
// moment a project opens. Fully skippable — agents can also be set up later
// from Settings.
//
// Codex gets extra care: its npm package frequently half-installs (the
// wrapper lands but the native binary doesn't), so `codex` is on PATH yet
// won't run. We detect that "broken" state — and the "not installed" and
// "already signed in via the ChatGPT/Codex app" states — and offer a
// copyable fix instead of a sign-in button that silently does nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import { OnboardingCenter } from "./OnboardingShell";
import { CheckIcon } from "./icons";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";

type AgentId = "claude" | "codex";
type ConnState = "idle" | "connecting" | "connected";

// Health of the Codex CLI, so an unrunnable install is handled honestly.
type CodexHealth = {
  state: "logged_in" | "logged_out" | "broken" | "missing" | "unknown";
  detail?: string;
  fix?: string;
  hasCreds: boolean;
};

const AGENTS: { id: AgentId; label: string; hint: string; glyph: string }[] = [
  { id: "claude", label: "Claude Code", hint: "Anthropic · Pro or API", glyph: "✳" },
  { id: "codex", label: "Codex", hint: "OpenAI · ChatGPT or API", glyph: "◇" },
];

// Small inline glyphs so this screen keeps its light icon footprint.
function WarnIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function CopyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

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
      const [c, x] = await Promise.all([
        api.claudeAuthStatus(),
        api.codexAuthStatus(),
      ]);
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
  // signed into — sign-in would spawn the same broken binary. Route those
  // states to a copyable reinstall command rather than the OAuth flow.
  const codexNeedsFix = codex.state === "broken" || codex.state === "missing";

  const connect = useCallback(
    async (id: AgentId) => {
      // Guard: never fire OAuth against an unrunnable Codex.
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
    [codexNeedsFix, codex.fix, copy],
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
          const isCodexFix = a.id === "codex" && codexNeedsFix;
          const rowErr = err[a.id];
          return (
            <div key={a.id} className="flex flex-col gap-1.5">
              <button
                type="button"
                disabled={st === "connecting" || st === "connected"}
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
                      <AsciiSpinner /> Waiting…
                    </span>
                  ) : isCodexFix ? (
                    <span className="inline-flex items-center gap-1.5 text-amber">
                      <WarnIcon />
                      {codex.state === "missing" ? "Not installed" : "Needs reinstall"}
                    </span>
                  ) : (
                    <span className="text-text-3 group-hover:text-text-1 transition-colors">
                      Connect
                    </span>
                  )}
                </span>
              </button>

              {/* Broken / missing Codex → explain + hand over a copyable fix. */}
              {isCodexFix && (
                <div className="rounded-md border border-amber/20 bg-amber/[0.06] px-3 py-2.5">
                  <div className="flex items-start gap-2 text-[11.5px] text-text-2 leading-relaxed">
                    <span className="mt-[1px] text-amber shrink-0">
                      <WarnIcon />
                    </span>
                    <span>
                      {codex.detail ||
                        (codex.state === "missing"
                          ? "The Codex CLI isn't installed."
                          : "Codex is installed but won't run — it needs reinstalling.")}
                      {codex.hasCreds && (
                        <>
                          {" "}
                          You're already signed in to Codex — this just repairs
                          the command-line tool.
                        </>
                      )}
                    </span>
                  </div>
                  {codex.fix && (
                    <button
                      type="button"
                      onClick={() => void copy(codex.fix!)}
                      className="mt-2 flex w-full items-center gap-2 rounded border border-line-soft bg-bg-1 px-2.5 py-1.5 text-left font-mono text-[11px] text-text-2 hover:border-line-strong transition-colors"
                    >
                      <span className="text-text-4">$</span>
                      <span className="flex-1 min-w-0 truncate">{codex.fix}</span>
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-text-3 shrink-0">
                        {copied ? <CheckIcon /> : <CopyIcon />}
                        {copied ? "Copied" : "Copy"}
                      </span>
                    </button>
                  )}
                  <div className="mt-2 text-[10.5px] text-text-4 leading-relaxed">
                    Run it in your terminal, then reopen this step. You can also
                    skip and set Codex up later.
                  </div>
                </div>
              )}

              {/* Sign-in failure reason (real message from the CLI). */}
              {rowErr && !isCodexFix && (
                <div className="flex items-start gap-2 rounded-md border border-line-soft bg-bg-2 px-3 py-2 text-[11px] text-text-3 leading-relaxed">
                  <span className="mt-[1px] text-amber shrink-0">
                    <WarnIcon />
                  </span>
                  <span>{rowErr}</span>
                </div>
              )}
            </div>
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

// Trim Tauri's `invoke` error envelope down to the CLI's own message.
function cleanErr(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  return s.replace(/^Error:\s*/i, "").trim() || "Sign-in didn't complete.";
}

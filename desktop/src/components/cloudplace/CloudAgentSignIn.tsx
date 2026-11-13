// Connecting an agent's subscription with one click: this computer runs the
// agent's own sign-in, the member finishes it in their browser, and the
// sign-in is saved for their cloud workspaces. What shows here is only where
// that is — a spinner and one line, the sign-in link, a one-time code to
// enter, or a field for the code a sign-in page hands back.

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";

import {
  agentSignInApi,
  pastedCode,
  signInLine,
  signInRunning,
  type SignInAgent,
  type SignInStarted,
  type SignInStatus,
} from "../../lib/cloudAgentSignIn";
import { writeClipboardText } from "../../lib/clipboard";
import { cloudProblem } from "../../lib/cloudWorkspacesApi";
import { openExternal } from "../../lib/openExternal";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const POLL_MS = 700;

const empty: SignInStatus = {
  phase: "starting",
  url: null,
  code: null,
  codePrompt: null,
  account: null,
  error: null,
  missingCli: false,
};

export type AgentSignIn = {
  status: SignInStatus | null;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Hand the sign-in a pasted code. The answer is what went wrong, if
   *  anything, in words. */
  sendCode: (raw: string) => Promise<string | null>;
  reset: () => void;
};

/** One sign-in for `agent`, followed while it runs. It belongs to whoever
 *  holds it: unmounting, or moving to another agent, stops it. */
export function useAgentSignIn(agent: SignInAgent | null): AgentSignIn {
  const [flow, setFlow] = useState<SignInStarted | null>(null);
  const running = !!flow && signInRunning(flow.status.phase);
  const id = flow?.id || null;
  const live = useRef<string | null>(null);
  live.current = running ? id : null;
  // Bumped whenever the member moves on, so a start still on its way back
  // can't bring a stopped sign-in back to the screen.
  const turn = useRef(0);

  useEffect(() => {
    turn.current++;
    setFlow(null);
    return () => {
      turn.current++;
      const was = live.current;
      if (was) void agentSignInApi.cancel(was).catch(() => undefined);
    };
  }, [agent]);

  useEffect(() => {
    if (!id || !running) return;
    let alive = true,
      timer = 0;
    const tick = async () => {
      try {
        const status = await agentSignInApi.status(id);
        if (alive) setFlow((f) => (f?.id === id ? { id, status } : f));
      } catch (e) {
        if (alive) setFlow((f) => (f?.id === id ? { id, status: { ...empty, phase: "failed", error: cloudProblem(e).message } } : f));
        return;
      }
      if (alive) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [id, running]);

  return {
    status: flow?.status ?? null,
    start: async () => {
      if (!agent) return;
      const mine = ++turn.current;
      setFlow({ id: "", status: empty });
      try {
        const started = await agentSignInApi.start(agent);
        if (turn.current === mine) setFlow(started);
        else void agentSignInApi.cancel(started.id).catch(() => undefined);
      } catch (e) {
        if (turn.current === mine)
          setFlow({ id: "", status: { ...empty, phase: "failed", error: cloudProblem(e).message } });
      }
    },
    cancel: async () => {
      turn.current++;
      setFlow(null);
      if (id) await agentSignInApi.cancel(id).catch(() => undefined);
    },
    sendCode: async (raw) => {
      const code = pastedCode(raw);
      if (!code) return "Paste the code from the sign-in page.";
      if (!id) return "This sign-in has ended. Start it again.";
      try {
        await agentSignInApi.code(id, code);
        setFlow((f) => (f?.id === id ? { id, status: { ...f.status, codePrompt: null } } : f));
        return null;
      } catch (e) {
        return cloudProblem(e).message;
      }
    },
    reset: () => {
      turn.current++;
      setFlow(null);
    },
  };
}

/** A running sign-in: where it is, and the one thing the member may need to
 *  do for it. */
export function SignInProgress({
  status,
  onCancel,
  onCode,
}: {
  status: SignInStatus;
  onCancel: () => void;
  onCode: (raw: string) => Promise<string | null>;
}) {
  const running = signInRunning(status.phase);
  const device = status.phase === "device_code" && !!status.code;
  // Run on the org's computer: no browser opened here, so the page is the
  // first thing to do, and the code it shows is always needed back.
  const remote = !!status.computer;
  // In the app the page opens by itself, once per sign-in; a browser tab
  // would block a window opened without a click, so the web keeps the button.
  const opened = useRef<string | null>(null);
  const autoOpen = !device && running && remote && !!status.url && isTauri();
  useEffect(() => {
    if (!autoOpen || !status.url || opened.current === status.url) return;
    opened.current = status.url;
    void openExternal(status.url);
  }, [autoOpen, status.url]);
  return (
    <div className="ui-cloud-agent-signin" aria-live="polite">
      <div className="ui-cloud-agent-signin-line">
        {running && <AsciiSpinner />}
        <span className="ui-cloud-agent-signin-text">{signInLine(status)}</span>
        {running && status.phase !== "saving" && (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {device && <DeviceCode code={status.code!} url={status.url} />}
      {!device && running && remote && status.url && (
        <Button size="sm" className="ui-cloud-agent-device-open" onClick={() => void openExternal(status.url)}>
          {autoOpen ? "Open Claude sign-in again" : "Open Claude sign-in"} <ArrowUpRight />
        </Button>
      )}
      {!device && running && !remote && status.url && (
        <small>
          Browser didn{"’"}t open?
          <Button size="xs" variant="link" onClick={() => void openExternal(status.url)}>
            Open the sign-in page <ArrowUpRight />
          </Button>
        </small>
      )}
      {!device && running && status.codePrompt && (
        <CodeField
          required={status.codePrompt === "required"}
          label={remote ? "Paste the code Claude shows you" : undefined}
          onSend={onCode}
        />
      )}
    </div>
  );
}

/** Codex's device sign-in: the code to enter, and the page to enter it on. */
function DeviceCode({ code, url }: { code: string; url: string | null }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <>
      <div className="ui-cloud-agent-device">
        <code aria-label="One-time code">{code}</code>
        <Button size="xs" variant="outline" onClick={async () => setCopied(await writeClipboardText(code))}>
          {copied ? "Copied" : copied === false ? "Couldn’t copy" : "Copy code"}
        </Button>
      </div>
      {url && (
        <Button
          size="sm"
          className="ui-cloud-agent-device-open"
          onClick={async () => {
            // One click: the code is on the clipboard by the time the page asks.
            setCopied(await writeClipboardText(code));
            void openExternal(url);
          }}
        >
          Copy code and open sign-in <ArrowUpRight />
        </Button>
      )}
      <small>
        {copied ? "Code copied — paste it on the page. " : ""}The code works for 15 minutes.
      </small>
    </>
  );
}

/** The code a sign-in page shows when it can't hand it back by itself. */
function CodeField({
  required,
  label: said,
  onSend,
}: {
  required: boolean;
  label?: string;
  onSend: (raw: string) => Promise<string | null>;
}) {
  const [value, setValue] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const label =
    said ?? (required ? "Paste the code the sign-in page shows you" : "Did the sign-in page show a code? Paste it here.");
  return (
    <form
      className="ui-cloud-agent-key ui-cloud-agent-code"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        const problem = await onSend(value);
        setBusy(false);
        setError(problem ?? "");
        if (!problem) setValue("");
      }}
    >
      <label htmlFor="ui-cloud-agent-code-input">
        <span>{label}</span>
      </label>
      <div className="ui-cloud-agent-code-row">
        <Input
          id="ui-cloud-agent-code-input"
          autoComplete="off"
          spellCheck={false}
          autoFocus={required}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" size="sm" variant={required ? "default" : "outline"} disabled={!value.trim() || busy}>
          {busy ? "Sending…" : "Continue"}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

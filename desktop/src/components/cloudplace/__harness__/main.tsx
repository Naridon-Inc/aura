// The agent dialog at each step of connecting an agent, rendered on its own.
//
// Dev-server only — reached at /cloud-agent-harness.html?scene=<name>, never
// bundled. The dialog is the real one; only the desktop's commands are
// stood in for, answering with a fixed sign-in for the scene. No sign-in
// runs and nothing is saved anywhere.
//
// Add `&theme=light` for the light palette.

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import type { Harness, SavedCredential, SavedSelection } from "../../../lib/cloudAgentCredentials";
import type { SignInStatus } from "../../../lib/cloudAgentSignIn";
import { CloudAgentDialog } from "../CloudAgentDialog";
import "../../../styles.css";
// The app loads the cloud surfaces' shared rows and segments globally.
import "../../ui/cloud-patterns.css";

type Scene = {
  harness: Harness;
  credentials?: SavedCredential[];
  selections?: SavedSelection[];
  /** What the sign-in says once it starts. */
  signIn?: Partial<SignInStatus>;
  /** The button the scene presses once the dialog is up. */
  press?: string;
};

const at = "2026-11-10T00:00:00Z";
const saved = (name: string, hint: string | null = null): SavedCredential => ({ name, workspace_id: null, updated_at: at, hint });

const SCENES: Record<string, Scene> = {
  "claude-connect": { harness: "claude" },
  "claude-browser": {
    harness: "claude",
    press: "Connect Claude subscription",
    signIn: { phase: "browser", url: "https://claude.ai/oauth/authorize?code=true", codePrompt: "optional" },
  },
  "claude-code": {
    harness: "claude",
    press: "Connect Claude subscription",
    signIn: { phase: "browser", url: "https://claude.ai/oauth/authorize?code=true", codePrompt: "required" },
  },
  "claude-connected": { harness: "claude", credentials: [saved("claude_code_oauth_token", "Ab3x")] },
  "claude-missing": {
    harness: "claude",
    press: "Connect Claude subscription",
    signIn: {
      phase: "failed",
      missingCli: true,
      error: "Claude Code isn’t installed on this computer, so it can’t sign in from here.",
    },
  },
  "codex-connect": { harness: "codex" },
  "codex-browser": {
    harness: "codex",
    press: "Connect ChatGPT plan",
    signIn: { phase: "browser", url: "https://auth.openai.com/oauth/authorize?client_id=app" },
  },
  "codex-device": {
    harness: "codex",
    press: "Connect ChatGPT plan",
    signIn: { phase: "device_code", code: "ABCD-12EFG", url: "https://auth.openai.com/codex/device" },
  },
  "codex-connected": { harness: "codex", credentials: [saved("codex_chatgpt_auth", "sam@example.com · Plus")] },
  "codex-keys": {
    harness: "codex",
    credentials: [saved("codex_chatgpt_auth", "sam@example.com · Plus"), saved("codex_api_key", "9fQe")],
    selections: [{ harness: "codex", selection: "subscription" }],
    press: "Use an API key instead",
  },
  cursor: { harness: "cursor" },
};

const params = new URLSearchParams(location.search);
const scene = SCENES[params.get("scene") ?? "claude-connect"] ?? SCENES["claude-connect"];
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const status: SignInStatus = {
  phase: "starting",
  url: null,
  code: null,
  codePrompt: null,
  account: null,
  error: null,
  missingCli: false,
  ...scene.signIn,
};

const answers: Record<string, () => unknown> = {
  cloud_agent_credentials_list: () => ({ credentials: scene.credentials ?? [], selections: scene.selections ?? [] }),
  cloud_agent_signin_start: () => ({ id: "harness", status }),
  cloud_agent_signin_status: () => status,
  cloud_agent_signin_code: () => null,
  cloud_agent_signin_cancel: () => null,
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    const answer = answers[cmd];
    if (!answer) throw new Error(`command ${cmd} not found`);
    return answer();
  },
  transformCallback: () => 0,
};

ReactDOM.createRoot(document.getElementById("cloud-agent-harness")!).render(
  <StrictMode>
    <CloudAgentDialog harness={scene.harness} onClose={() => undefined} />
  </StrictMode>,
);

if (scene.press) {
  const press = () => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === scene.press);
    if (button) {
      button.click();
      document.body.dataset.pressed = "yes";
    } else window.setTimeout(press, 50);
  };
  window.setTimeout(press, 50);
} else document.body.dataset.pressed = "yes";

// Aura Cloud authentication.
//
// V1 ships a minimal token-based flow: the user pastes their Aura Cloud
// API token (generated via auravcs.com → Settings → Tokens) and we stash
// it in vscode.SecretStorage. Future versions can replace this with a
// proper vscode.AuthenticationProvider once the cloud OAuth flow is
// wired (see aura-shell/src-tauri/src/cmd_aura.rs hosted-auth flow).

import * as vscode from "vscode";

const SECRET_KEY = "aura.cloud.token";

export async function getCloudToken(ctx: vscode.ExtensionContext): Promise<string | null> {
  const t = await ctx.secrets.get(SECRET_KEY);
  return t ?? null;
}

export async function setCloudToken(ctx: vscode.ExtensionContext, token: string): Promise<void> {
  await ctx.secrets.store(SECRET_KEY, token);
}

export async function clearCloudToken(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(SECRET_KEY);
}

/** Prompt the user for a token. Returns the new token or null if cancelled. */
export async function promptForCloudToken(ctx: vscode.ExtensionContext): Promise<string | null> {
  const token = await vscode.window.showInputBox({
    title: "Aura Cloud — paste your API token",
    prompt: "Generate a token at auravcs.com → Settings → Tokens",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "aura_pat_…",
  });
  if (!token || !token.trim()) return null;
  await setCloudToken(ctx, token.trim());
  return token.trim();
}

export function cloudBaseUrl(): string {
  const v = vscode.workspace.getConfiguration("aura").get<string>("cloudBaseUrl");
  return v && v.trim().length > 0 ? v.replace(/\/+$/, "") : "https://auravcs.com";
}

// The connections the MCP servers page offers ready-made, and the small
// readers the page and its dialogs share: which template a configured server
// came from, whether it is reached over the network, and the KEY=value block
// its environment is typed as.

import type { DiscoveredMcp, McpServerEntry } from "../../../lib/api";

export type McpTemplate = {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
  /** Per-key hint shown next to the field in the auth modal. */
  envHints?: Record<string, string>;
  /** Per-key sensitivity flag — true means render as password input. */
  envSecret?: Record<string, boolean>;
  /** Provider's token-issue page. The auth modal renders this as an
   *  "Open token page" button that uses the system browser, so users
   *  don't have to hunt for the right Settings panel. */
  tokenPageUrl?: string;
  /** Remote MCP endpoint. When set, Aura uses its native Streamable
   *  HTTP transport + OAuth 2.1 PKCE flow rather than spawning a
   *  stdio child. Mutually informative with `command`/`args` (a
   *  template can be remote-only with empty command, or hybrid). */
  serverUrl?: string;
};

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "atlassian-remote",
    label: "Atlassian (remote · native OAuth)",
    description:
      "Atlassian's hosted remote MCP. Aura authenticates via native OAuth 2.1 and calls it over Streamable HTTP.",
    command: "",
    args: [],
    envKeys: [],
    serverUrl: "https://mcp.atlassian.com/v1/sse",
  },
  {
    id: "atlassian",
    label: "Atlassian (Jira + Confluence)",
    description:
      "Atlassian's official MCP server. Needs ATLASSIAN_API_TOKEN + ATLASSIAN_EMAIL + ATLASSIAN_DOMAIN.",
    command: "npx",
    args: ["-y", "@atlassian/mcp-server"],
    envKeys: ["ATLASSIAN_API_TOKEN", "ATLASSIAN_EMAIL", "ATLASSIAN_DOMAIN"],
    envHints: {
      ATLASSIAN_API_TOKEN: "Create at id.atlassian.com → Security → API tokens",
      ATLASSIAN_EMAIL: "Your Atlassian account email",
      ATLASSIAN_DOMAIN: "e.g. yourco.atlassian.net (no https://)",
    },
    envSecret: { ATLASSIAN_API_TOKEN: true },
    tokenPageUrl:
      "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  {
    id: "linear",
    label: "Linear",
    description:
      "Linear's MCP bridge. Needs a personal API key with read/write scopes (LINEAR_API_KEY).",
    command: "npx",
    args: ["-y", "@linear/mcp-server"],
    envKeys: ["LINEAR_API_KEY"],
    envHints: {
      LINEAR_API_KEY: "Create at linear.app/settings/api",
    },
    envSecret: { LINEAR_API_KEY: true },
    tokenPageUrl: "https://linear.app/settings/api",
  },
  {
    id: "github",
    label: "GitHub",
    description:
      "GitHub's MCP server. Needs a fine-grained personal access token (GITHUB_PERSONAL_ACCESS_TOKEN).",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    envHints: {
      GITHUB_PERSONAL_ACCESS_TOKEN:
        "Use a fine-grained PAT with repo + issues scopes",
    },
    envSecret: { GITHUB_PERSONAL_ACCESS_TOKEN: true },
    tokenPageUrl: "https://github.com/settings/tokens?type=beta",
  },
  {
    id: "sentry",
    label: "Sentry",
    description:
      "Sentry issue + event search. Needs SENTRY_AUTH_TOKEN and the org slug.",
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    envKeys: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"],
    envHints: {
      SENTRY_AUTH_TOKEN: "Create at sentry.io → Settings → Auth Tokens",
      SENTRY_ORG: "Your org slug (visible in any Sentry URL)",
    },
    envSecret: { SENTRY_AUTH_TOKEN: true },
    tokenPageUrl: "https://sentry.io/settings/account/api/auth-tokens/",
  },
];

// Best-effort match from a configured server back to its template. Used
// by the AuthSetupModal to know which env keys to prompt for. We match
// on `id === name` first (the import flow keeps the template slug as
// the server name); fall back to scanning args for the npm package
// hint so renamed-but-otherwise-identical configs still snap into the
// right template.
export function matchTemplate(
  name: string,
  args: string[] | undefined,
): McpTemplate | null {
  const byName = MCP_TEMPLATES.find((t) => t.id === name.toLowerCase());
  if (byName) return byName;
  const argBlob = (args ?? []).join(" ").toLowerCase();
  for (const t of MCP_TEMPLATES) {
    const pkgArg = t.args[t.args.length - 1] ?? "";
    if (pkgArg && argBlob.includes(pkgArg.toLowerCase())) return t;
  }
  return null;
}

export type AddFormState = {
  name: string;
  command: string;
  args: string;
  envText: string;
  description: string;
  /** Remote MCP endpoint. When non-empty the backend wires the native
   *  Streamable HTTP transport and OAuth 2.1 PKCE flow; the stdio
   *  command/args become optional (empty = pure-remote). */
  serverUrl: string;
  /** Where the server is used: the repository the form was opened in, or
   *  every repository. Outside a repository it is always every one. */
  scope: "repository" | "everywhere";
};

export const EMPTY_FORM: AddFormState = {
  name: "",
  command: "",
  args: "",
  envText: "",
  description: "",
  serverUrl: "",
  scope: "repository",
};

// Identity key for a discovered row. Used as the picker checkbox key so
// the same server surfaced from multiple agents (Claude+Cursor+Windsurf
// pointed at the same binary) collapses to one row, but configs that
// diverge stay distinct.
export function discoveredKey(d: DiscoveredMcp): string {
  return `${d.name}::${d.command}::${d.args.join(" ")}`;
}

// Wave B helper — classifies an MCP server as a remote-OAuth flavour
// based on command shape. `mcp-remote` is the canonical npm proxy
// shipped by Anthropic for browser-OAuth-gated remote MCPs (Atlassian
// remote, Notion remote, etc); plain `https://` first-arg matches the
// MCP-spec native remote transport. `none` means stdio with env vars
// only — the env-paste path is the right one.
export function detectRemote(
  server: McpServerEntry,
): { kind: "none" | "mcp-remote" | "remote-url"; url?: string } {
  const allArgs = server.args.join(" ").toLowerCase();
  if (allArgs.includes("mcp-remote")) {
    const httpsArg = server.args.find((a) => a.startsWith("https://"));
    return { kind: "mcp-remote", url: httpsArg };
  }
  const remoteArg = server.args.find((a) => a.startsWith("https://"));
  if (remoteArg) return { kind: "remote-url", url: remoteArg };
  return { kind: "none" };
}

/** Parse "KEY=value" lines from the textarea into a string-string map.
 *  Blank lines + lines without `=` are skipped; values keep their literal
 *  text (no shell expansion). */
export function parseEnvBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key) out[key] = value;
  }
  return out;
}

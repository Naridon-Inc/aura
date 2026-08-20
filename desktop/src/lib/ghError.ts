// ghError — classify a raw `gh` / GitHub GraphQL error string into a clean,
// actionable failure mode. `gh` leaks raw API noise straight up the Tauri
// command boundary — e.g. "GraphQL: API rate limit already exceeded for user
// ID …" or "HTTP 401: Bad credentials" — and the UI must never show that
// verbatim. Map the raw string to one known mode and give the next action.
//
// Used by both PR surfaces (PrRailPanel list, PRDetailPane center) via the
// shared GhErrorNotice so the banner reads the same everywhere.

export type GhErrorKind =
  | "rate_limit"
  | "auth"
  | "not_installed"
  | "network"
  | "unknown";

export type GhErrorInfo = {
  kind: GhErrorKind;
  /** Short headline. */
  title: string;
  /** One-line plain-language next step; may contain `code` spans in backticks. */
  detail: string;
  /** A Refresh shortly might fix it (rate limit / transient network). */
  retryable: boolean;
};

export function classifyGhError(raw: unknown): GhErrorInfo {
  const msg = (raw instanceof Error ? raw.message : String(raw ?? "")).toLowerCase();

  // Rate limit — primary or secondary ("abuse detection", "too quickly").
  // The user's sign-in is fine; it's purely a throttle.
  if (
    msg.includes("rate limit") ||
    msg.includes("ratelimit") ||
    msg.includes("submitted too quickly") ||
    msg.includes("abuse detection")
  ) {
    return {
      kind: "rate_limit",
      title: "GitHub API rate limit hit",
      detail:
        "Too many requests in a short window. Your sign-in is fine. Wait a minute, then Refresh.",
      retryable: true,
    };
  }

  // Not signed in / bad or missing credentials.
  if (
    msg.includes("gh auth login") ||
    msg.includes("not logged in") ||
    msg.includes("bad credentials") ||
    msg.includes("http 401") ||
    msg.includes("requires authentication") ||
    msg.includes("authentication required") ||
    msg.includes("no github hosts found") ||
    msg.includes("no hosts found")
  ) {
    return {
      kind: "auth",
      title: "Not signed in to GitHub",
      detail: "Run `gh auth login` in this repo, then Refresh.",
      retryable: false,
    };
  }

  // gh binary missing from PATH.
  if (
    msg.includes("command not found") ||
    msg.includes("gh: not found") ||
    msg.includes("program not found") ||
    (msg.includes("no such file") && msg.includes("gh")) ||
    (msg.includes("executable") && msg.includes("not found"))
  ) {
    return {
      kind: "not_installed",
      title: "GitHub CLI not found",
      detail:
        "Install `gh` from cli.github.com, run `gh auth login`, then Refresh.",
      retryable: false,
    };
  }

  // Transient network.
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("dial tcp") ||
    msg.includes("connection refused") ||
    msg.includes("could not resolve host") ||
    msg.includes("network is unreachable") ||
    msg.includes("no such host")
  ) {
    return {
      kind: "network",
      title: "Couldn't reach GitHub",
      detail: "Network looks down. Check your connection, then Refresh.",
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    title: "Couldn't load from GitHub",
    detail:
      "Run `gh auth login` and Refresh. If it persists, try `gh pr list` in a terminal to see the raw error.",
    retryable: false,
  };
}

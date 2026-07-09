// Boot script piped into the PTY when the user opens the Aura Manager
// terminal. Lands the user on Manager context (recent sessions + usage
// hints) instead of a blank shell prompt. Each line is one shell
// command; `2>/dev/null || true` swallows the "no active session"
// stderr so the banner stays clean on cold repos.

export function managerBootCommand(objective?: string): string {
  const cleanObjective = objective?.trim();
  return [
    "clear",
    "echo",
    "echo '  Aura Manager CLI'",
    "echo '  ────────────────'",
    "echo",
    "echo '  status   aura status'",
    "echo '  ask      aura ask \"<question>\"'",
    "echo '  plan     aura plan \"<objective>\"'",
    "echo '  next     aura execute'",
    "echo '  run      aura orchestrate run \"<objective>\"'",
    "echo '  agents   aura subagent list'",
    ...(cleanObjective
      ? ["echo", `echo '  objective ${shellSingleQuote(cleanObjective)}'`]
      : []),
    "echo",
    "aura status 2>/dev/null || true",
  ].join(" && ");
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

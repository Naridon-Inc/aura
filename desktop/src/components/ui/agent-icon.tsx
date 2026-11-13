import { Terminal, Box } from "lucide-react";
import { useId } from "react";
export function AgentIcon({ provider, size = 16 }: { provider: string; size?: number }) {
  const gradient = useId();
  const kind = provider.toLowerCase();
  if (kind.includes("claude") || kind.includes("anthropic"))
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="ui-agent-icon"
      >
        <path fill="#d88769" d="M5 5h14v3h3v7h-3v4h-2v-4h-3v4h-2v-4H9v4H7v-4H4v-3H1V9h4z" />
        <path fill="#2c2826" d="M8 8h2v4H8zm7 0h2v4h-2z" />
      </svg>
    );
  if (kind.includes("openai") || kind.includes("codex"))
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="ui-agent-icon"
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2=".7" y2="1">
            <stop stopColor="#b7acff" />
            <stop offset="1" stopColor="#5544ef" />
          </linearGradient>
        </defs>
        <path
          fill={`url(#${gradient})`}
          d="M8 1.8c2.3-1.5 4.8-.7 6.5.9 3.1-.3 5.9 1.8 6 5 2.7 2.2 2.6 5.6.4 8.1.1 3.4-2.9 5.5-6 5-2.3 2.5-5.9 2.4-8-.3-3.2.1-5.7-2.3-5.3-5.6-2.1-2.5-1.7-5.8 1-7.6C2.8 4 5 1.7 8 1.8z"
        />
        <path
          d="m7 8 2.5 3L7 14m6 0h4"
          fill="none"
          stroke="white"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return kind.includes("cursor") ? (
    <Box size={size} className="ui-agent-icon" />
  ) : (
    <Terminal size={size} className="ui-agent-icon" />
  );
}

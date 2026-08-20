// TunnelChip — `aura://localhost:3000` as something you can click.
//
// A shared port is written the same way everywhere in this product, so the
// moment one appears in a message it should stop being text and become the
// door. `TunnelText` does the swap over a whole message body; `TunnelChip` is
// the single chip, for the composer's own preview of what you just typed.
//
// The chip is honest about three different things, because a link that quietly
// does nothing is worse than no link:
//   • open   — clickable, and says which port it goes to.
//   • closed — the host stopped sharing it. Rendered struck through and
//              unclickable, with the reason in the title, rather than looking
//              live and failing on click.
//   • unknown — we haven't been told either way yet (a message from before we
//              connected). It stays clickable; the click is what finds out.

import type { JSX, ReactNode } from "react";
import { Cable } from "lucide-react";

import { cn } from "../../../lib/utils";
import { auraDisplayUrl, findAuraUrls } from "./shareTypes";

export type TunnelChipStatus = "open" | "closed" | "unknown";

export type TunnelChipProps = {
  port: number;
  /** Always `localhost` in practice — the host only ever proxies to
   *  `127.0.0.1:<port>`. Carried so a chip can render exactly what was typed. */
  host?: string;
  /** What it is, in the sharer's words. Shown beside the address when known. */
  label?: string;
  status?: TunnelChipStatus;
  /** Open it. The caller resolves the display form to the relay URL and opens
   *  it — the chip never knows the relay URL, so it can't leak one. */
  onOpen?: (port: number) => void;
};

export function TunnelChip({
  port,
  host = "localhost",
  label,
  status = "unknown",
  onOpen,
}: TunnelChipProps): JSX.Element {
  const display = host === "localhost" ? auraDisplayUrl(port) : `aura://${host}:${port}`;
  const closed = status === "closed";
  const clickable = !closed && !!onOpen;

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => onOpen?.(port)}
      title={
        closed
          ? `${display}. Whoever shared this has stopped sharing it.`
          : `Open ${display}${label ? ` · ${label}` : ""}`
      }
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 align-baseline",
        "font-mono text-sm leading-5 transition-colors",
        closed
          ? "cursor-default border-line-soft bg-bg-1 text-text-5 line-through"
          : clickable
            ? "border-line-soft bg-bg-2 text-text-1 hover:border-accent hover:bg-state-hover"
            : "cursor-default border-line-soft bg-bg-2 text-text-2",
      )}
    >
      <Cable
        size={11}
        className={cn("shrink-0", closed ? "text-text-5" : "text-accent-green")}
        aria-hidden
      />
      <span className="truncate">{display}</span>
      {label && !closed && (
        <span className="truncate font-sans text-xs text-text-4">{label}</span>
      )}
    </button>
  );
}

export type TunnelTextProps = {
  /** A message body that may contain one or more `aura://host:port`. */
  text: string;
  /** Status per port, as far as the caller knows. Ports not in the map render
   *  as `unknown` — never as `open`, because claiming a dead port is live is
   *  the one mistake this component exists to avoid. */
  statusByPort?: Record<number, TunnelChipStatus>;
  /** Label per port, when the session knows what's running there. */
  labelByPort?: Record<number, string>;
  onOpen?: (port: number) => void;
  className?: string;
};

/**
 * A message body with every `aura://…` turned into a chip and everything else
 * left exactly as it was.
 *
 * Text in, nodes out — no HTML parsing, no `dangerouslySetInnerHTML`. Whatever
 * a teammate typed stays inert text; only the substrings that match the
 * `aura://host:port` shape become elements.
 */
export function TunnelText({
  text,
  statusByPort,
  labelByPort,
  onOpen,
  className,
}: TunnelTextProps): JSX.Element {
  const hits = findAuraUrls(text);
  if (hits.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, i) => {
    if (hit.start > cursor) {
      nodes.push(
        <span key={`t${i}`}>{text.slice(cursor, hit.start)}</span>,
      );
    }
    nodes.push(
      <TunnelChip
        key={`c${i}`}
        port={hit.port}
        host={hit.host}
        label={labelByPort?.[hit.port]}
        status={statusByPort?.[hit.port] ?? "unknown"}
        onOpen={onOpen}
      />,
    );
    cursor = hit.end;
  });
  if (cursor < text.length) {
    nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  }

  return <span className={className}>{nodes}</span>;
}

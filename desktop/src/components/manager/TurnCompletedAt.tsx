// The wall-clock moment a reply settled, beside its duration chip.
//
// Rendered in the same muted ink as `.dur`, and re-read each minute so a
// reply that finished "today" doesn't keep saying so after midnight. The
// full timestamp is in the tooltip for anyone who wants seconds.

import { useEffect, useState } from "react";

import { formatCompletedAt } from "../../lib/completedAt";

export function TurnCompletedAt({ atSec }: { atSec: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!Number.isFinite(atSec) || atSec <= 0) return null;
  return (
    <span
      className="dur cursor-default"
      title={new Date(atSec * 1000).toLocaleString()}
    >
      {formatCompletedAt(atSec, now)}
    </span>
  );
}

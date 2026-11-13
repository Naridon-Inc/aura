// The sizes the team's computer can run at, as rows to pick from: each one's
// cores and memory, what it costs on top of the plan, and about how many
// people it fits working at once. Every sentence is the server's
// (managed_computer/offer.rs), so a size that is full or Teams-only says why
// in the same words everywhere.

import type { AuraComputerSize } from "../../../lib/auraComputer";
import "../../ui/aura-computer.css";

export function ComputerSizes({
  sizes,
  value,
  onChange,
  larger,
  disabled = false,
}: {
  sizes: readonly AuraComputerSize[];
  /** The picked instance type. */
  value: string;
  /** Omitted: the list only shows what there is. */
  onChange?: (size: string) => void;
  /** The line for anything bigger than the biggest size. */
  larger?: string;
  disabled?: boolean;
}) {
  return (
    <div className="ui-aura-computer-sizes">
      <div role="radiogroup" aria-label="Computer size">
        {sizes.map((s) => {
          const picked = s.instance_type === value;
          const off = disabled || !onChange || (!s.available && !picked);
          return (
            <label key={s.instance_type} data-picked={picked || undefined} data-off={off || undefined}>
              <input
                type="radio"
                name="aura-computer-size"
                value={s.instance_type}
                checked={picked}
                disabled={off}
                onChange={() => onChange?.(s.instance_type)}
              />
              <span>
                <strong>{s.label}</strong>
                <small>{!s.available && s.reason ? s.reason : s.fits_line}</small>
              </span>
              <em>{s.price_line}</em>
            </label>
          );
        })}
      </div>
      {larger && <small>{larger}</small>}
    </div>
  );
}

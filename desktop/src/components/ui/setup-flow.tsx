// A multi-step flow drawn the way the cloud setup draws it: the numbered steps
// down the left, one page at a time beside them. A step you have not reached
// yet stays shut; one you have passed wears a tick. The look is the cloud
// setup's own rules — this only lets another flow stand in them.

import { type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";
import "./cloud-onboarding.css";

export function SetupFlow({
  label,
  steps,
  step,
  furthest,
  onStep,
  className,
  children,
}: {
  /** Names the step list for assistive tech, e.g. "Plan steps". */
  label: string;
  steps: string[];
  /** The page showing now. */
  step: number;
  /** The furthest page reached; nothing past it can be opened yet. */
  furthest: number;
  onStep: (index: number) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("ui-cloud-setup", className)}>
      <nav aria-label={label}>
        {steps.map((name, i) => (
          <button
            key={name}
            type="button"
            aria-current={i === step ? "step" : undefined}
            disabled={i > furthest}
            onClick={() => onStep(i)}
          >
            <span>{i < furthest ? <Check size={12} /> : i + 1}</span>
            {name}
          </button>
        ))}
      </nav>
      <main key={step} className="ui-cloud-setup-page">
        {children}
      </main>
    </div>
  );
}

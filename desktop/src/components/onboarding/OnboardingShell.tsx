// Shared chrome for the first-run flow. Every screen sits on the same
// full-bleed near-black surface (Aura's darkest chrome token) with the
// Aura wordmark centered above the screen's own content. A single optional
// Back affordance lives top-left; nothing else competes. Modeled on the
// reference editor's calm sign-in / open-project panes, rendered entirely
// on Aura tokens.

import type { ReactNode } from "react";
import { BackArrow } from "./icons";
import { AuraMark } from "../AuraMark";
import { Button } from "../ui/button";

export function AuraWordmark() {
  // The brand lockup: the blossom mark beside the "Aura" wordmark — the one
  // piece of brand identity on the surface. The mark is the single-source
  // AuraMark (tints via currentColor → text-text-1), the word is the system
  // display face in title case so it reads as the product name, not a shout.
  return (
    <div className="select-none text-text-1 inline-flex items-center gap-3">
      <AuraMark size={34} title="Aura" />
      <span
        style={{
          fontFamily:
            '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          fontWeight: 700,
          fontSize: "34px",
          letterSpacing: "-0.01em",
          lineHeight: 1,
        }}
      >
        Aura
      </span>
    </div>
  );
}

export function OnboardingShell({
  onBack,
  children,
}: {
  /** When set, a quiet Back arrow shows top-left. */
  onBack?: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-bg-1 flex flex-col" data-onboarding-v2>
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={onBack}
          className="absolute top-5 left-5"
        >
          <BackArrow />
          Back
        </Button>
      ) : null}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

/** Wordmark + the wide central column every screen shares. */
export function OnboardingCenter({
  children,
  width = 360,
}: {
  children: ReactNode;
  width?: number;
}) {
  return (
    <div className="w-full flex flex-col items-center py-12">
      <AuraWordmark />
      <div className="mt-10 w-full flex flex-col items-center" style={{ maxWidth: width }}>
        {children}
      </div>
    </div>
  );
}

// ShipReadyPill — the ambient ship-readiness signal at the commit moment.
//
// Lives in the branch row of CommitInput, right where you commit/push. It used
// to be a dedicated "Ready to ship" row in the Trace rail; it's now a live
// status, not a place you navigate to. A green dot means the fast safety gates
// pass (no leaked secrets, no half-finished code); amber/red means something
// wants a look before you ship. Click opens the full detail (the ChecksPane,
// with "Run full check" + the cloud export) via the same `aura:open-checks`
// event the old rail row fired.
//
// Stays SILENT when readiness is unknown (old bundled CLI, not a git repo) — an
// honest blank beats a grey "unknown" badge cluttering every commit.

import { useShipReadiness } from "../../lib/useShipReadiness";

type Tone = {
  dot: string;
  text: string;
};

const PASS: Tone = { dot: "var(--color-accent-green)", text: "text-text-3" };
const ATTENTION: Tone = { dot: "var(--color-red)", text: "text-text-2" };
const CHECKING: Tone = { dot: "var(--color-text-4)", text: "text-text-4" };

export function ShipReadyPill({ repoRoot }: { repoRoot: string }) {
  const readiness = useShipReadiness(repoRoot);

  if (readiness.state === "unknown") return null;

  const tone =
    readiness.state === "attention"
      ? ATTENTION
      : readiness.state === "checking"
        ? CHECKING
        : PASS;

  const label =
    readiness.state === "attention"
      ? readiness.needsLook === 1
        ? "1 thing to look at"
        : `${readiness.needsLook} things to look at`
      : readiness.state === "checking"
        ? "Checking…"
        : "Ready to ship";

  const title =
    readiness.state === "attention"
      ? "Something to look at before you ship — open for the detail and a full check."
      : "No leaked secrets, no half-finished code. Click for the detail + a full check (build included).";

  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(new CustomEvent("aura:open-checks"))
      }
      className={`flex items-center gap-1.5 text-[10.5px] transition-colors hover:text-text-1 ${tone.text}`}
      title={title}
    >
      <span
        className="h-[6px] w-[6px] shrink-0 rounded-full"
        style={{ background: tone.dot }}
        aria-hidden
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

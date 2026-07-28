//! Shared primitives for the usage popover's two sections (Context +
//! Provider usage). Kept in one small sibling module so `UsagePopover`, the
//! Context section and the Provider section all speak the same label/value/bar
//! vocabulary without any one file growing into a monolith.
//!
//! House style, encoded here so every row obeys it:
//!   • labels are muted (text-2), values are brighter (text-4) or full ink
//!     + semibold when `strong` (the one figure the row is about);
//!   • values are right-aligned and tabular so columns line up;
//!   • sections are separated by a hairline `Rule`, never a heavy border;
//!   • the primary/context bar fills in calm arctic-blue and only warms to
//!     amber/red as it nears the wall — never a loud full-ink fill.

/** Prettify a raw vendor-family id to its display casing WITHOUT translating it
 *  to a different word — we surface the real family value, only fixed up, so a
 *  "Provider" row never asserts something the snapshot didn't say. */
export function providerLabel(family: string): string {
  const map: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    gemini: "Gemini",
    kimi: "Kimi",
  };
  return map[family] ?? family.charAt(0).toUpperCase() + family.slice(1);
}

/** The consumer brand for a family, used in the "<Provider> usage" title. */
export function providerBrand(family: string): string {
  const map: Record<string, string> = {
    anthropic: "Claude",
    openai: "GPT",
    gemini: "Gemini",
    kimi: "Kimi",
  };
  return map[family] ?? providerLabel(family);
}

/** Format a token count compactly: 1234 → "1.2k", 412000 → "412k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Fill color for a context/window bar: calm arctic-blue at rest, warming to
 *  amber past ~80% and red past ~92% so the near-the-wall cue reads without
 *  expanding. Arctic-blue (not the emerald accent, which we reserve for
 *  status) is the primary/context tone the app uses for a neutral gauge. */
export function contextFill(frac: number): string {
  if (frac >= 0.92) return "var(--color-red)";
  if (frac >= 0.8) return "var(--color-amber)";
  return "var(--color-blue)";
}

/** Fill color for a subscription-budget bar. This is a STATUS signal (how much
 *  of a rolling limit is spent), so it stays a muted status tone until it warms
 *  amber/red near the limit — never the arctic primary. `usedPct` is 0–100. */
export function budgetFill(usedPct: number): string {
  if (usedPct >= 90) return "var(--color-red)";
  if (usedPct >= 75) return "var(--color-amber)";
  return "var(--color-text-3)";
}

/** One label → value line in a breakdown. `strong` bumps the value to full ink
 *  + semibold for the row's headline figure (Window used, N% left). */
export function StatRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 leading-tight">
      <span className="text-[13px] text-text-2">{label}</span>
      <span
        className={
          strong
            ? "text-[13px] font-semibold text-text-1 tabular-nums"
            : "text-[13px] text-text-4 tabular-nums"
        }
      >
        {value}
      </span>
    </div>
  );
}

/** A section header ("Context", "Claude usage") — bold ink, optional trailing
 *  meta on the right (e.g. the raw used/window token pair). */
export function SectionHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[15px] font-semibold text-text-1">{title}</span>
      {meta && <span className="text-[13px] text-text-3 tabular-nums">{meta}</span>}
    </div>
  );
}

/** Full-width fill bar. `frac` is 0–1; a tiny floor keeps a non-zero value
 *  visible as a sliver rather than nothing. `fill` is a CSS color string. */
export function Bar({ frac, fill }: { frac: number; fill: string }) {
  const clamped = Math.max(0, Math.min(1, frac));
  return (
    <span
      className="relative block w-full overflow-hidden rounded-full"
      style={{ height: 6, background: "var(--color-bg-1)" }}
      aria-hidden
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${Math.max(clamped * 100, clamped > 0 ? 4 : 0)}%`,
          background: fill,
          transition: "width var(--motion-fast), background var(--motion-fast)",
        }}
      />
    </span>
  );
}

/** A hairline divider between sections, matching the card's soft lines. */
export function Rule() {
  return <div className="my-3 h-px w-full" style={{ background: "var(--color-line-soft)" }} />;
}

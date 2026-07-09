// ExtensionRailPanel — a right-rail summary of one installed extension.
//
// What it answers, in plain language a non-engineer can read at a glance:
//   • what this extension contributes (themes, language files, snippets, …),
//   • which of those Aura applies right now (✓), and
//   • which kinds are detected but Aura can't run yet ("coming soon" /
//     "not yet") — so nobody wonders why an installed extension "did nothing".
//
// It reuses the same honest per-kind labels as the Extensions surface
// (`vscodeExt/supportLabels`), so the wording can never drift between the
// wizard list and this rail. Arctic-blue accent marks the kinds Aura actually
// runs; coming-soon reads muted and not-yet reads amber. Teal/green is reserved
// for status only and is not used here.
//
// MOUNT POINT (intended, wired on merge-back): RightRail.tsx renders one panel
// per active rail tab. Add an "extensions" tab there and render
// <ExtensionRailPanel ext={selectedExtension} onOpenManager={…} /> when an
// installed extension is selected (e.g. from the Extensions wizard's
// "Show in rail" affordance, or a future right-click). This component is
// self-contained and importable as-is; it does not touch the global rail
// layout itself.

import {
  bandTextClass,
  kindLabels,
  overallBand,
  type KindLabel,
  type SupportBand,
} from "../../lib/vscodeExt/supportLabels";
import type { InstalledExtension } from "../../lib/vscodeExt/vsixTypes";

type Props = {
  /** The installed extension to summarise. */
  ext: InstalledExtension;
  /** Optional — open the full Extensions surface (e.g. to remove/disable). */
  onOpenManager?: () => void;
};

/** Plain one-word band caption for the section a kind sits under. */
function bandCaption(band: SupportBand): string {
  switch (band) {
    case "active":
      return "Working now";
    case "coming-soon":
      return "Coming soon";
    case "not-yet":
      return "Not yet";
  }
}

const BAND_ORDER: SupportBand[] = ["active", "coming-soon", "not-yet"];

export function ExtensionRailPanel({ ext, onOpenManager }: Props) {
  const labels = kindLabels(ext.contributes);
  const band = overallBand(ext.contributes);

  // Group the kinds by band so the rail reads as three calm sections.
  const groups = BAND_ORDER.map((b) => ({
    band: b,
    items: labels.filter((l) => l.band === b),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1">
      <header className="flex-shrink-0 flex items-center gap-2 px-3 h-9 border-b border-line-soft">
        <span className="text-text-2 text-[11.5px] font-medium uppercase tracking-wider truncate">
          Extension
        </span>
        {onOpenManager && (
          <button
            type="button"
            onClick={onOpenManager}
            title="Open Extensions"
            aria-label="Open Extensions"
            className="ml-auto flex items-center justify-center w-7 h-7 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-3 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 3h6v6M21 3l-9 9M9 21H3v-6M3 21l9-9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {/* Identity + one honest overall verdict. */}
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-text-1 text-[13px] font-medium truncate">
              {ext.displayName || ext.name}
            </span>
            <span className="text-text-4 text-[11px] tabular-nums flex-shrink-0">
              v{ext.version}
            </span>
            {!ext.enabled && (
              <span className="text-[10px] text-text-4 bg-bg-2 border border-line-soft rounded px-1.5 py-0.5">
                off
              </span>
            )}
          </div>
          <span className="text-text-4 text-[10.5px] font-mono truncate">
            {ext.namespace}
          </span>
          {ext.description && (
            <p className="text-text-3 text-[11.5px] leading-snug mt-0.5">
              {ext.description}
            </p>
          )}
          <OverallVerdict band={band} />
        </div>

        {/* Per-kind breakdown, grouped by band. */}
        {groups.length === 0 ? (
          <p className="text-text-4 text-[11.5px] leading-snug">
            This extension doesn’t contribute anything Aura can read.
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.band} className="flex flex-col gap-1.5">
              <h3
                className={`text-[10px] font-medium uppercase tracking-wider ${bandTextClass(
                  g.band,
                )}`}
              >
                {bandCaption(g.band)}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {g.items.map((l) => (
                  <KindRow key={l.key} label={l} />
                ))}
              </ul>
            </section>
          ))
        )}

        <p className="text-text-4 text-[10.5px] leading-relaxed border-t border-line-soft pt-2.5 mt-1">
          Themes, language files, and snippets apply automatically. Kinds marked
          “coming soon” or “not yet” are recognised but Aura can’t run them here
          today. Everything comes from the open Open&nbsp;VSX gallery.
        </p>
      </div>
    </div>
  );
}

/** A single calm headline verdict for the whole extension. */
function OverallVerdict({ band }: { band: SupportBand | "none" }) {
  const text =
    band === "active"
      ? "Working in Aura now"
      : band === "coming-soon"
        ? "Recognised — support coming soon"
        : band === "not-yet"
          ? "Recognised — Aura can’t run this kind yet"
          : "Nothing Aura can use";
  return (
    <div className={`text-[11px] leading-snug mt-1 ${bandTextClass(band)}`}>
      {text}
    </div>
  );
}

/** One contribution kind: a band-coloured marker, its plain title, and a
 *  plain-language detail line. The technical term rides along as a tooltip so
 *  the surface never assumes the reader knows "LSP" or "webview". */
function KindRow({ label }: { label: KindLabel }) {
  return (
    <li
      className="flex items-start gap-2 rounded-md border border-line-soft bg-bg-2/40 px-2.5 py-2"
      title={label.tech}
    >
      <span className={`flex-shrink-0 text-[12px] leading-5 ${bandTextClass(label.band)}`}>
        {label.band === "active" ? "✓" : "•"}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[12px] font-medium leading-snug ${bandTextClass(label.band)}`}>
          {label.title}
        </div>
        <div className="text-text-3 text-[11px] leading-snug mt-0.5">
          {label.detail}
        </div>
      </div>
    </li>
  );
}

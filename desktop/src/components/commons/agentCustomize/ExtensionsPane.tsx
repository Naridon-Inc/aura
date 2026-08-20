// ExtensionsPane — editor add-ons from the VS Code world, living *inside* the
// "Agents & extensions" surface rather than on its own rail row. VS Code is a
// compatibility source: things it supports (themes, languages, snippets, smart
// code help) show here; add-ons built for Aura itself are the ADE-native track
// and live under Plugins in this same surface. See
// ".aura/notes/team/ade-native-extensions.md".
//
// Thin wrapper: a plain-language intro + a Discover/Installed toggle above the
// stateful ExtensionsManager (mounted once so search results and in-flight
// installs survive flipping the toggle, matching its "state survives switch"
// contract).

import { useState } from "react";

import {
  ExtensionsManager,
  type ExtensionsView,
} from "../ExtensionsManager";

const TABS: { id: ExtensionsView; label: string }[] = [
  { id: "discover", label: "Discover" },
  { id: "installed", label: "Installed" },
];

export function ExtensionsPane() {
  const [view, setView] = useState<ExtensionsView>("discover");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Pane header — intro + the Discover/Installed toggle. Kept compact so
          the gallery below gets the room; the ADE-first framing lives here so
          a reader understands VS Code is the compatibility source, not the
          system. */}
      <div className="shrink-0 border-b border-line-soft px-8 pt-7 pb-4">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-lg font-semibold text-text-1">Extensions</h2>
          <p className="mt-1 text-base leading-relaxed text-text-3">
            Editor add-ons from the VS Code world. Themes, languages, snippets
            and smart code help. Add-ons built for Aura itself live under
            Plugins; this is the compatibility track for what VS Code supports.
          </p>
          <div className="mt-4 inline-flex rounded-md border border-line-soft bg-bg-1/40 p-0.5">
            {TABS.map((t) => {
              const active = view === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setView(t.id)}
                  className={`rounded px-3 py-1 text-sm transition-colors ${
                    active
                      ? "bg-bg-2 text-text-1"
                      : "text-text-3 hover:text-text-1"
                  }`}
                  style={
                    active ? { color: "var(--color-accent)" } : undefined
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* The stateful gallery — self-scrolls, fills the rest. */}
      <div className="min-h-0 flex-1">
        <ExtensionsManager view={view} />
      </div>
    </div>
  );
}

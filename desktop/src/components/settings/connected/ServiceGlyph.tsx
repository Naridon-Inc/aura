// One mark per service, so the list and the store agree.
//
// Vendor marks come from the brand SVGs already bundled under
// `public/app-icons` — the same files the radar reads. Never hand-drawn: a
// redrawn logo is a wrong logo, and these are other people's trademarks.
// Jira, Linear and Beads keep the marks drawn in trackerParts because no
// bundled asset exists for them. Anything with neither falls back to its own
// initial, which is honestly a placeholder rather than a guess at somebody's
// brand.

import { Badge } from "../../ui/badge";
import { SettingsServiceMark, SettingsServiceTitle } from "../../ui/settings-services-row";
import { BeadsGlyph, JiraGlyph, LinearGlyph } from "./trackerParts";
import type { CatalogEntry, ServiceId } from "./catalog";

/** Brand SVGs bundled same-origin. A service missing here has no mark we are
 *  entitled to draw. */
const BRAND: Partial<Record<ServiceId, string>> = {
  anthropic: "/app-icons/claude.svg",
  openai: "/app-icons/codex-white.svg",
  gemini: "/app-icons/gemini.svg",
};

export function ServiceGlyph({ id, label }: { id: ServiceId; label: string }) {
  if (id === "jira") return <JiraGlyph />;
  if (id === "linear") return <LinearGlyph />;
  if (id === "beads") return <BeadsGlyph />;

  const src = BRAND[id];
  return (
    <SettingsServiceMark>
      {src ? <img src={src} alt="" width={16} height={16} draggable={false} /> : label.slice(0, 1)}
    </SettingsServiceMark>
  );
}

/** A service's row title: its mark and its name, and "In use" on the model
 *  provider the app is asking right now. */
export function ServiceName({ entry, active }: { entry: CatalogEntry; active?: boolean }) {
  return (
    <SettingsServiceTitle
      mark={<ServiceGlyph id={entry.id} label={entry.label} />}
      badge={active ? <Badge variant="highlight">In use</Badge> : undefined}
    >
      {entry.label}
    </SettingsServiceTitle>
  );
}

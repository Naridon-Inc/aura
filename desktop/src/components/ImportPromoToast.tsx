import { useEffect, useState } from "react";

import {
  dismissPromo,
  importSourcesDetect,
  openImportFor,
  promoCopy,
  promoSource,
  type ImportSource,
} from "../lib/importSources";
import { LiveToast } from "./LiveToast";

// One card in the toast stack for someone who just came from another agent
// app: "Coming from <app>? Bring your workspaces and chats into Aura", with
// Import opening Settings → Import on that app. Shown only when that app's
// data is on this Mac and nothing was imported from it yet; closing it is
// remembered for that app. Desktop only — the web console has no disk to read.

/** Let the window settle (projects, sessions, the update check) before a
 *  card that is not urgent joins the stack. */
const SETTLE_MS = 6000;

export function ImportPromoToast() {
  const [offer, setOffer] = useState<ImportSource | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let gone = false;
    const timer = window.setTimeout(() => {
      importSourcesDetect()
        .then((sources) => {
          if (!gone) setOffer(promoSource(sources));
        })
        .catch(() => {
          /* no importer in this build, or the scan failed: no card */
        });
    }, SETTLE_MS);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (!offer) return null;
  const copy = promoCopy(offer);
  const notNow = () => {
    dismissPromo(offer.id);
    setOffer(null);
  };
  return (
    <LiveToast
      id={`import-promo-${offer.id}`}
      tone="accent"
      title={copy.title}
      message={copy.message}
      durationMs={null}
      dismissLabel={`Don't offer to import from ${offer.name} again`}
      actions={[
        {
          label: "Import",
          variant: "primary",
          onClick: () => {
            setOffer(null);
            openImportFor(offer.id);
          },
        },
        { label: "No thanks", onClick: notNow },
      ]}
      onDismiss={notNow}
    />
  );
}

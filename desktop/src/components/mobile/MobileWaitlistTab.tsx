// Settings → Connections → "Aura on your phone".
//
// The permanent home for the waitlist. The What's New note offers it once
// after an update; this is where it lives afterwards, so someone who waved
// the note away — or who joined on a different machine — can still find it.

import { PaneHeader } from "../settings/kit";
import { MobileWaitlistPane } from "./MobileWaitlistPane";

export function MobileWaitlistTab() {
  return (
    <>
      <PaneHeader
        title="Aura on your phone"
        subtitle="The iPhone and Android apps are in the works. Join the waitlist and we'll email you an invite when they're ready to try."
      />
      <div className="max-w-[460px]">
        <MobileWaitlistPane />
      </div>
    </>
  );
}

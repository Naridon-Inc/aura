// Settings › Cloud computer › Who can use it.
//
// The seats on the team's machines, right under the computer they open. This
// used to live only behind a "Who can use" button on the Machines page, which
// nothing in Settings led to — so somebody looking at their machine here had
// no way to let a teammate onto it. The list is the Machines dialog's own
// (`MachineAccessList`); this only gives it a heading, says that a seat is for
// every machine the team has rather than this one, and offers the way to the
// full machine list.

import { accessIntro, seatReach } from "../../lib/cloudAccess";
import { Button } from "../ui/button";
import { SettingsSection } from "../ui/settings-row";
import { MachineAccessList, useMachineAccess } from "../workspaces/MachineAccessList";
import { Fold } from "./Fold";
import { foldLabel } from "./nav";

/** Open the Machines page, where every machine the team has is listed. */
export function openMachines(onClose: () => void) {
  window.dispatchEvent(new CustomEvent("aura:open-machines"));
  onClose();
}

export function CloudAccessSection({ onClose }: { onClose: () => void }) {
  const access = useMachineAccess(true);
  // Signed out of the cloud there is no team to hand seats out in, and the
  // computer above already says how to sign in.
  if (access.loaded && !access.loaded.connected) return null;
  const org = access.loaded?.orgName;
  return (
    <Fold id="access" bare>
      <SettingsSection
        title={foldLabel("access")}
        description={
          <>
            {accessIntro(access)}{" "}
            {/* An owner's sentence already says a seat opens every machine;
                a member's only says whom to ask. */}
            {!access.alone && !access.manage && <>{seatReach(org)} </>}
            <Button variant="link" size="sm" onClick={() => openMachines(onClose)}>
              See all machines
            </Button>
          </>
        }
      >
        <MachineAccessList access={access} />
      </SettingsSection>
    </Fold>
  );
}

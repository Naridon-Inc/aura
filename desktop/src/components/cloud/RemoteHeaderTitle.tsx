// The work header's title while a machine is in front: its name, and behind
// it the machine's details. See `remoteHeader` for how it gets here.

import { CloudOrganizationGlyph, CloudStatus } from "../ui/cloud-workspace";
import { MachineDetails } from "./MachineDetails";
import { useRemoteHeader } from "./remoteHeader";
import "../ui/remote-workspace.css";

export function RemoteHeaderTitle() {
  const header = useRemoteHeader();
  // The overlay publishes on its first effect, a frame after the header has
  // drawn. Holding the glyph's place keeps the title from jumping in.
  if (!header)
    return (
      <span className="ui-cloud-title ui-remote-machine-trigger" aria-hidden>
        <CloudOrganizationGlyph size={18} />
      </span>
    );
  // Keyed on the box, because the details hold a draft OF that box: the folder
  // its conversation reads, half-typed. Switching machines must not carry one
  // box's path onto the next.
  //
  // Beside the name, the machine's health whenever it is anything but up: a
  // box that is asleep, starting or not answering says so where you look
  // first, not only inside the details.
  return (
    <>
      <MachineDetails key={header.machine?.id ?? "no-machine"} {...header} />
      {header.machine && header.state !== "running" && <CloudStatus state={header.state} />}
    </>
  );
}

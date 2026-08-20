// ShareSurface — the one full-screen home for "someone else is coming into
// this session", carrying the three things that question actually means:
//
//   Share  — open your session up, and say who can do what once they're in.
//   Join   — go into somebody else's.
//   Ports  — share what you're running so they can open it, not just read it.
//
// There is deliberately NO title. The tabs carry the context — that is the
// house rule for every full-screen surface in this app, and a "Share session"
// heading three pixels above a tab that already says Share is the exact noise
// the rule exists to stop.
//
// Sibling of ConnectMachineWizard and PairPhoneDialog by construction: same
// FullscreenOverlay, same WizardStepTabs strip, same Esc chip, same measure-
// capped column. Somebody who has connected a machine already knows how this
// works before they open it.

import { useMemo, useState, type JSX } from "react";
import { Cable, Link2, LogIn } from "lucide-react";

import { FullscreenOverlay } from "../../FullscreenOverlay";
import { WizardStepTabs, type WizardStepMeta } from "../../ui/wizard";
import {
  ShareSessionPanel,
  type ShareSessionPanelProps,
} from "./ShareSessionPanel";
import {
  JoinSessionPanel,
  type JoinSessionPanelProps,
} from "./JoinSessionPanel";
import { TunnelManager, type TunnelManagerProps } from "./TunnelManager";

export type ShareSurfaceTab = "share" | "join" | "ports";

const TABS: WizardStepMeta[] = [
  { id: "share", label: "Share", icon: <Link2 size={14} /> },
  { id: "join", label: "Join", icon: <LogIn size={14} /> },
  { id: "ports", label: "Ports", icon: <Cable size={14} /> },
];

const ORDER: ShareSurfaceTab[] = ["share", "join", "ports"];

export type ShareSurfaceProps = {
  onClose: () => void;
  /** Which tab opens. "join" when the person arrived from a link, "share" from
   *  their own session, "ports" from a tunnel row. */
  initialTab?: ShareSurfaceTab;
  share: ShareSessionPanelProps;
  join: JoinSessionPanelProps;
  tunnels: TunnelManagerProps;
};

export function ShareSurface({
  onClose,
  initialTab = "share",
  share,
  join,
  tunnels,
}: ShareSurfaceProps): JSX.Element {
  const [tab, setTab] = useState<ShareSurfaceTab>(initialTab);
  const index = ORDER.indexOf(tab);

  // A tab that has something live under it earns the completed glyph, so the
  // strip reads as state rather than as three identical doors: a shared
  // session, and a port you left open, are both things you want to notice from
  // the header without opening the tab.
  const complete = useMemo(() => {
    const open = (tunnels.tunnels ?? []).length > 0;
    return (i: number) =>
      (i === 0 && share.session !== null) || (i === 2 && open);
  }, [share.session, tunnels.tunnels]);

  return (
    <FullscreenOverlay
      onClose={onClose}
      contentClassName="overflow-y-auto"
      tabs={
        <WizardStepTabs
          steps={TABS}
          index={index < 0 ? 0 : index}
          onJump={(i) => setTab(ORDER[i] ?? "share")}
          isComplete={complete}
          variant="tabs"
        />
      }
    >
      <div className="mx-auto w-full max-w-2xl px-8 py-7">
        {tab === "share" && <ShareSessionPanel {...share} />}
        {tab === "join" && <JoinSessionPanel {...join} />}
        {tab === "ports" && <TunnelManager {...tunnels} />}
      </div>
    </FullscreenOverlay>
  );
}

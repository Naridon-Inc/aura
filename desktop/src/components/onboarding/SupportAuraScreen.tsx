// First run — the one time Aura asks for something back.
//
// One page, two rows and a way out. No counter, no badge, no "please": Aura
// is open source, stars are how people find it, and the community is where
// the workflows live. Say that once, plainly, and let the person move on.
//
// Both rows open in the browser and mark themselves done, so returning to
// this page shows what was already handled instead of asking twice.

import { useState, type ReactNode } from "react";
import { ArrowUpRight, Check, MessageCircle } from "lucide-react";
import { GitHubMark } from "./icons";
import { Button } from "../ui/button";
import {
  chatLink,
  openCommunityLink,
  readLedger,
  starLink,
  type CommunityLink,
} from "../../lib/community";
import "../ui/cloud-onboarding.css";
import "../ui/cloud-patterns.css";
import "../ui/onboarding.css";

export function SupportAuraScreen({ onDone }: { onDone: () => void }) {
  const ledger = readLedger();
  const [done, setDone] = useState({
    star: ledger.starred,
    chat: ledger.joined,
  });

  const rows: Array<{ link: CommunityLink; glyph: ReactNode }> = [
    { link: starLink(), glyph: <GitHubMark size={17} /> },
    { link: chatLink(), glyph: <MessageCircle size={17} aria-hidden /> },
  ];

  async function open(link: CommunityLink) {
    setDone((d) => ({ ...d, [link.kind]: true }));
    await openCommunityLink(link);
  }

  return (
    <>
      <header>
        <h1>Aura is open source</h1>
        <p>Two clicks help more than you'd think. Both are optional.</p>
      </header>

      <div className="ui-cloud-agent-connections ui-onboarding-rows">
        {rows.map(({ link, glyph }) => {
          const finished = done[link.kind];
          return (
            <button key={link.kind} type="button" title={link.hint} onClick={() => void open(link)}>
              {glyph}
              <span>{link.label}</span>
              {finished ? (
                <>
                  <small>Opened</small>
                  <Check size={15} aria-hidden />
                </>
              ) : (
                <>
                  <small>Open</small>
                  <ArrowUpRight size={14} aria-hidden />
                </>
              )}
            </button>
          );
        })}
      </div>

      <div className="ui-cloud-inline">
        <Button type="button" onClick={onDone}>
          {done.star || done.chat ? "Start using Aura" : "Maybe later"}
        </Button>
        <small>
          Aura never asks for this again — you'll find both links in Settings under Help.
        </small>
      </div>
    </>
  );
}

// First-run — the one time Aura asks for something back.
//
// It sits on the same shell as the rest of the flow and holds two rows and a
// way out. No counter, no badge, no "please": Aura is open source, stars are
// how people find it, and the community is where the workflows live. Say that
// once, plainly, and let the person move on.
//
// Both rows open in the browser and mark themselves done, so returning to this
// screen shows what was already handled instead of asking twice.

import { useState } from "react";
import { OnboardingCenter } from "./OnboardingShell";
import { CheckIcon, GitHubMark } from "./icons";
import { Button } from "../ui/button";
import {
  chatLink,
  openCommunityLink,
  readLedger,
  starLink,
  type CommunityLink,
} from "../../lib/community";

function ChatGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  );
}

export function SupportAuraScreen({ onDone }: { onDone: () => void }) {
  const ledger = readLedger();
  const [done, setDone] = useState({
    star: ledger.starred,
    chat: ledger.joined,
  });

  const rows: Array<{ link: CommunityLink; glyph: React.ReactNode }> = [
    { link: starLink(), glyph: <GitHubMark size={17} /> },
    { link: chatLink(), glyph: <ChatGlyph /> },
  ];

  async function open(link: CommunityLink) {
    setDone((d) => ({ ...d, [link.kind]: true }));
    await openCommunityLink(link);
  }

  return (
    <OnboardingCenter width={380}>
      <div className="text-center">
        <div className="text-lg font-semibold text-text-1">
          Aura is open source
        </div>
        <div className="mt-1.5 text-base text-text-3">
          Two clicks help more than you'd think. Both are optional.
        </div>
      </div>

      <div className="mt-7 w-full flex flex-col gap-2">
        {rows.map(({ link, glyph }) => {
          const finished = done[link.kind];
          return (
            <button
              key={link.kind}
              type="button"
              onClick={() => void open(link)}
              className="group flex items-center gap-3 h-[52px] w-full px-3.5 rounded-md border border-line-soft bg-bg-2 hover:bg-bg-3 hover:border-line-strong transition-colors text-left"
            >
              <span className="w-8 h-8 shrink-0 rounded-md bg-bg-1 border border-line-soft inline-flex items-center justify-center text-text-2">
                {glyph}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-base font-medium text-text-1">
                  {link.label}
                </span>
                <span className="block text-xs text-text-4">{link.hint}</span>
              </span>
              <span className="shrink-0 inline-flex items-center text-sm">
                {finished ? (
                  <span className="inline-flex items-center gap-1 text-accent-green">
                    <CheckIcon /> Opened
                  </span>
                ) : (
                  <span className="text-text-3 group-hover:text-text-1 transition-colors">
                    Open
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <Button
        type="button"
        variant="default"
        size="lg"
        onClick={onDone}
        className="mt-7"
      >
        {done.star || done.chat ? "Start using Aura" : "Maybe later"}
      </Button>
      <div className="mt-3 text-xs text-text-4 text-center leading-relaxed">
        Aura never asks for this again — you'll find both links in Settings
        under Help.
      </div>
    </OnboardingCenter>
  );
}

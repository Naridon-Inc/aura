// Tiny lock glyph mounted on every assistant turn header. Tells the
// user "the commits this conversation produces land on a signed,
// auditable manifest chain" — the auravcs differentiator made visible
// where AI work happens (the chat) instead of buried in a Studio pane.
//
// Hover  → signer + intent hash + ast hash for HEAD's manifest.
// Click  → opens Audit Trail so the user can inspect the signed evidence.
// Hidden → when the repo has no signed manifest at HEAD (don't lie).

import { useHeadProvenance } from "../lib/useHeadProvenance";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

type Props = {
  repoRoot: string | undefined;
};

export function ProvenanceLockBadge({ repoRoot }: Props) {
  const head = useHeadProvenance(repoRoot);
  if (!head || !head.signed) return null;

  function open() {
    window.dispatchEvent(new CustomEvent("aura:open-replay", { detail: { sha: head?.sha } }));
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={open}
          aria-label="Open the proof trail"
          className="opacity-60 hover:opacity-100 text-text-3 hover:text-text-1 transition-opacity"
        >
          <LockGlyph />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px]">
        <div className="text-[10px] uppercase tracking-wider text-text-4 mb-0.5">
          signed evidence · latest commit
        </div>
        <div className="font-mono text-[10.5px] text-text-2 mb-1">
          {head.sha.slice(0, 12)}
        </div>
        {head.identity && (
          <Row label="signer" value={head.identity} mono />
        )}
        {head.intent_hash && <Row label="task" value={head.intent_hash.slice(0, 16)} mono />}
        {head.ast_hash && <Row label="code" value={head.ast_hash.slice(0, 16)} mono />}
        <div className="text-[10px] text-text-5 mt-1.5">
          click to open the proof trail
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-[10.5px] leading-tight">
      <span className="text-text-5 uppercase tracking-wider text-[9.5px] w-10 shrink-0">
        {label}
      </span>
      <span className={`text-text-1 truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// SecurityNotes — every promise this feature makes about who can get at what,
// in one file, in plain words.
//
// They live together on purpose. Each sentence below is a claim about what the
// transport enforces, taken from `docs/collab/SESSION_LIVE_PROTOCOL.md`; the
// day one of those rules changes, the copy that has to change with it should be
// findable in one place rather than scattered across three panels. Copy that
// overstates what a transport does is worse than no copy at all, and the way
// that happens is a promise written next to the button and forgotten.
//
// Deliberately no jargon. The audience includes people who will never read the
// protocol doc, and "org-scoped" or "no anonymous mode" tells them nothing —
// what they need to know is whether pasting this link into a group chat is
// safe, and the answer is a sentence, not a term of art.

import type { JSX } from "react";
import { ShieldCheck } from "lucide-react";

/** Why a link is not a key.
 *
 *  The live socket refuses anonymous connections outright, and checks the
 *  caller's team against the session's owning team before a frame moves. So
 *  possession of the link genuinely is not enough — and this is the sentence
 *  that stops someone treating it as a secret they must protect, or worse,
 *  as a secret they've already leaked. */
export function WhoCanJoin({ repoName }: { repoName: string }): JSX.Element {
  return (
    <div className="flex items-start gap-2.5 rounded-[8px] border border-line-soft bg-bg-1 px-3.5 py-3">
      <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent-green" />
      <div className="min-w-0 text-sm leading-snug text-text-3">
        <span className="font-medium text-text-2">
          Only people who work on {repoName} can join.
        </span>{" "}
        Aura checks who someone is when they open the link. Having the link
        isn&apos;t enough on its own, so a link that leaks doesn&apos;t let a
        stranger in. Whoever joins is working on this machine, on these files.
      </div>
    </div>
  );
}

/** The three rules a shared port actually obeys.
 *
 *  Each maps to one line of the protocol that is not optional:
 *    • `/t/{code}` requires the same session membership as the session that
 *      opened it — checked per request, not once;
 *    • the host only ever proxies to `127.0.0.1:<port>`, for a port it
 *      explicitly opened;
 *    • tunnels die with the socket that opened them.
 *
 *  No padlock standing in for a claim nobody wrote down. */
export function TunnelSecurityNotes(): JSX.Element {
  return (
    <div className="flex items-start gap-2.5 rounded-[8px] border border-line-soft bg-bg-1 px-3.5 py-3">
      <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent-green" />
      <ul className="flex min-w-0 flex-col gap-1.5 text-sm leading-snug text-text-3">
        <li>
          <span className="font-medium text-text-2">
            This is not a public web address.
          </span>{" "}
          Only the people already in this session can open it, and Aura checks
          that on every single request, not once at the start.
        </li>
        <li>
          <span className="font-medium text-text-2">
            It reaches one port, on this machine.
          </span>{" "}
          Nothing else here and nothing else on your network is exposed, even to
          the people who can reach it.
        </li>
        <li>
          <span className="font-medium text-text-2">
            It dies when you disconnect.
          </span>{" "}
          Close the app, lose your connection, or press Stop, and the address
          stops working immediately. Nothing is left running behind you.
        </li>
      </ul>
    </div>
  );
}

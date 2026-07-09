// PageShareDialog — the real Share surface for a Page (plan 20 W2/W3).
//
// The Pages access model is the anon-by-origin room: anyone with this repo
// clone is already in the room and can open + edit any page. So "sharing" is
// not an ACL grant — it's (1) the copyable deep link, (2) the Publish toggle
// (private draft ↔ shared with the team's Public list), and (3) a live view
// of who is in the doc right now, read from the collab awareness. No fake
// invite-by-email — per-page permissions need the hybrid-room-auth layer
// (plan 19) and are out of scope until then.

import { useEffect, useState } from "react";
import { Link2, Check, Globe, Lock as LockIcon, Users } from "lucide-react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import type { PagesProvider } from "../../lib/pages_collab";

type Collaborator = {
  id: number;
  name: string;
  color: string;
  self: boolean;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** `scope|bucket|id` — drives the deep link + is the page identity. */
  pageKey: string;
  pageTitle: string;
  /** Human scope label, e.g. "Team note", "#design", "@owner". */
  scopeLabel: string;
  /** True when frontmatter.visibility === "shared" (Published). */
  published: boolean;
  onTogglePublish: () => void;
  /** Live collab provider for the open page; null when collab isn't up
   *  (e.g. no identity yet). Awareness drives the "who's here" list. */
  provider: PagesProvider | null;
};

// Subscribe to the collab awareness and surface the current participants.
// Each client publishes `{ user: { name, color } }` (see PagesProvider +
// TiptapEditor's CollaborationCaret); we read those states live.
function useCollaborators(
  open: boolean,
  provider: PagesProvider | null,
): Collaborator[] {
  const [list, setList] = useState<Collaborator[]>([]);
  useEffect(() => {
    if (!open || !provider) {
      setList([]);
      return;
    }
    const aw = provider.awareness;
    const read = () => {
      const selfId = aw.clientID;
      const next: Collaborator[] = [];
      aw.getStates().forEach((st, id) => {
        const u = (st as { user?: { name?: string; color?: string } }).user;
        if (!u?.name) return;
        next.push({
          id,
          name: u.name,
          color: u.color ?? "#7c8a82",
          self: id === selfId,
        });
      });
      next.sort((a, b) =>
        a.self === b.self ? a.name.localeCompare(b.name) : a.self ? -1 : 1,
      );
      setList(next);
    };
    read();
    aw.on("change", read);
    return () => aw.off("change", read);
  }, [open, provider]);
  return list;
}

export function PageShareDialog({
  open,
  onClose,
  pageKey,
  pageTitle,
  scopeLabel,
  published,
  onTogglePublish,
  provider,
}: Props) {
  const [copied, setCopied] = useState(false);
  const collaborators = useCollaborators(open, provider);
  const deepLink = `aura://page/${pageKey}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(deepLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard denied — silent */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Share “${pageTitle || "Untitled"}”`}
      width={460}
      footer={
        <Button variant="ghost" onClick={onClose} className="text-text-2">
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Access model — the honest anon-room truth, not a fake ACL. */}
        <div className="flex items-start gap-2.5 rounded-md bg-bg-2 px-3 py-2.5">
          <Users
            className="w-4 h-4 text-text-3 mt-px flex-shrink-0"
            strokeWidth={1.75}
            aria-hidden
          />
          <div className="text-[12px] text-text-3 leading-snug">
            Everyone with this repository can open and edit this page. Access
            follows the clone — there are no per-person invites yet.
            <span className="block mt-0.5 text-text-4">
              Lives in <span className="text-text-2">{scopeLabel}</span>.
            </span>
          </div>
        </div>

        {/* Deep link + copy. */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-5 mb-1.5">
            Page link
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md bg-bg-content border border-line-soft px-2.5 py-1.5 text-[12px] font-mono text-text-2">
              {deepLink}
            </code>
            <button
              type="button"
              onClick={copyLink}
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium transition-colors flex-shrink-0",
                copied
                  ? "bg-accent-green/15 text-accent-green"
                  : "bg-bg-2 text-text-2 hover:bg-bg-3 hover:text-text-1",
              )}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
              ) : (
                <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        {/* Publish toggle — flips frontmatter.visibility, moving the page
         *  between the Private (draft) and Public (shared) list tabs. */}
        <button
          type="button"
          onClick={onTogglePublish}
          className="w-full flex items-center gap-2.5 rounded-md border border-line-soft px-3 py-2.5 text-left hover:bg-bg-2 transition-colors"
        >
          <span
            className={cn(
              "grid place-items-center w-7 h-7 rounded-md flex-shrink-0",
              published ? "bg-accent/15 text-accent" : "bg-bg-2 text-text-4",
            )}
          >
            {published ? (
              <Globe className="w-4 h-4" strokeWidth={1.75} aria-hidden />
            ) : (
              <LockIcon className="w-4 h-4" strokeWidth={1.75} aria-hidden />
            )}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[12.5px] text-text-1 font-medium">
              {published ? "Published to the team" : "Private draft"}
            </span>
            <span className="block text-[11.5px] text-text-4 leading-snug">
              {published
                ? "Shown in the team's Public pages. Tap to make it a private draft."
                : "Only you see it in your drafts. Tap to publish to the team."}
            </span>
          </span>
          <span
            className={cn(
              "text-[11px] font-medium px-2 py-0.5 rounded flex-shrink-0",
              published
                ? "bg-accent/15 text-accent"
                : "bg-bg-2 text-text-3",
            )}
          >
            {published ? "Published" : "Publish"}
          </span>
        </button>

        {/* Live collaborators from awareness. */}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-5 mb-1.5">
            In this page now
          </div>
          {collaborators.length === 0 ? (
            <div className="text-[12px] text-text-4 px-0.5">
              {provider
                ? "Just you. Others appear here when they open this page."
                : "Live presence starts once you're signed in to the repo room."}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {collaborators.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-bg-2 pl-1.5 pr-2.5 py-1 text-[12px] text-text-2"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: c.color }}
                    aria-hidden
                  />
                  {c.name}
                  {c.self && (
                    <span className="text-text-5 text-[10.5px]">you</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

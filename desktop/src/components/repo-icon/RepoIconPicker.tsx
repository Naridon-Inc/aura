// The control that changes what a repository wears in the sidebar: a square
// button showing the current picture, opening four ways to pick another.
// Every pick is kept at once (no Save), the way the sidebar shows it.

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ProjectAvatar } from "../ProjectAvatar";
import { RepoAvatar } from "../ui/repo-avatar";
import { EmojiTab } from "./EmojiTab";
import { FaviconTab } from "./FaviconTab";
import { IconsTab } from "./IconsTab";
import { UploadTab } from "./UploadTab";
import { useRepoIcons } from "./loadRepoIcons";
import { useRepoLook, type RepoIconTabProps } from "./repoIconChoice";
import "./repo-icon-picker.css";

type Tab = "icons" | "emoji" | "favicon" | "upload";

const TABS: { id: Tab; label: string }[] = [
  { id: "icons", label: "Icons" },
  { id: "emoji", label: "Emoji" },
  { id: "favicon", label: "Favicon" },
  { id: "upload", label: "Upload" },
];

export function RepoIconPicker({ repoRoot, name }: { repoRoot: string; name: string }) {
  const [open, setOpen] = useState(false);
  const look = useRepoLook(repoRoot);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="ui-repo-icon-trigger" aria-label="Change repository icon">
          <TriggerFace root={repoRoot} name={name} emoji={look.emoji} chosen={look.chosen} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={4} className="ui-repo-icon-popover">
        <RepoIconTabs root={repoRoot} name={name} look={look} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The current pick at 20px; with nothing picked, the sidebar's picture. */
function TriggerFace({
  root,
  name,
  emoji,
  chosen,
}: {
  root: string;
  name: string;
  emoji: string | null;
  chosen: string | null;
}) {
  const named = chosen && !chosen.startsWith("data:") ? chosen : null;
  const icons = useRepoIcons(!!named);
  const Glyph = named && icons ? icons.REPO_ICONS[named] : undefined;
  if (emoji) return <span className="ui-repo-icon-trigger-emoji">{emoji}</span>;
  if (Glyph || (chosen && !named)) {
    return (
      <RepoAvatar
        name={name}
        glyph={Glyph ? <Glyph size={20} /> : undefined}
        picked={named ? null : chosen}
        size={20}
      />
    );
  }
  return <ProjectAvatar root={root} name={name} emoji={null} />;
}

function RepoIconTabs(props: RepoIconTabProps) {
  const [tab, setTab] = useState<Tab>("icons");
  return (
    <div className="ui-repo-icon-panel">
      <div className="ui-repo-icon-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-active={tab === t.id || undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ui-repo-icon-body" role="tabpanel">
        {tab === "icons" && <IconsTab {...props} />}
        {tab === "emoji" && <EmojiTab {...props} />}
        {tab === "favicon" && <FaviconTab {...props} />}
        {tab === "upload" && <UploadTab {...props} />}
      </div>
    </div>
  );
}

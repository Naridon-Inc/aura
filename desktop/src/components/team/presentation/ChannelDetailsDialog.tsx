import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  UserPlus,
  Workflow,
  X,
} from "lucide-react";

import type { TeamMember } from "../../../lib/api";
import { prettyName, type Conversation } from "../domain";
import { Avatar } from "./Avatar";

export type ChannelDialogTab =
  | "about"
  | "members"
  | "apps"
  | "automations"
  | "tabs"
  | "settings";

export function ChannelDetailsDialog({
  conv,
  members,
  initialTab,
  onTabChange,
  onClose,
}: {
  conv: Conversation;
  members: TeamMember[];
  initialTab: ChannelDialogTab;
  onTabChange: (tab: ChannelDialogTab) => void;
  onClose: () => void;
}) {
  const [memberQuery, setMemberQuery] = useState("");
  const channelName = prettyName(conv).replace(/^#/, "");
  const filteredMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) =>
      `${member.name} ${member.handle} ${member.email}`.toLowerCase().includes(query),
    );
  }, [memberQuery, members]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tabs: Array<{ value: ChannelDialogTab; label: string }> = [
    { value: "about", label: "About" },
    { value: "members", label: `Members ${members.length}` },
    { value: "apps", label: "Agents & apps" },
    { value: "automations", label: "Automations" },
    { value: "tabs", label: "Tabs" },
    { value: "settings", label: "Settings" },
  ];

  return (
    <div className="slack-channel-dialog-layer" role="presentation">
      <button className="slack-channel-dialog-backdrop" onClick={onClose} aria-label="Close channel details" />
      <section
        className="slack-channel-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${channelName} channel details`}
      >
        <header className="slack-channel-dialog-header">
          <div className="slack-channel-dialog-title">
            <span>{conv.private ? "▣" : "#"}</span>
            <strong>{channelName}</strong>
          </div>
          <button type="button" className="slack-channel-dialog-close" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>

        <div className="slack-channel-dialog-content">
          <nav className="slack-channel-dialog-tabs" aria-label="Channel details sections">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={initialTab === tab.value ? "is-active" : ""}
                onClick={() => onTabChange(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="slack-channel-dialog-body">
          {initialTab === "about" && (
            <div className="slack-channel-about-card">
              <section>
                <strong>Channel name</strong>
                <span>{conv.private ? "▣" : "#"}{channelName}</span>
                <button type="button" aria-label="Edit channel name"><Pencil size={13} /></button>
              </section>
              <section>
                <strong>Topic</strong>
                <span>{conv.hint || "Add a topic"}</span>
                <button type="button" aria-label="Edit topic"><Pencil size={13} /></button>
              </section>
              <section>
                <strong>Description</strong>
                <span>{conv.hint || `A place for the team to coordinate work in #${channelName}.`}</span>
                <button type="button" aria-label="Edit description"><Pencil size={13} /></button>
              </section>
              <section>
                <strong>Created for this workspace</strong>
                <span>This channel keeps decisions and team-wide conversations together.</span>
              </section>
              <p className="slack-channel-id">Channel ID: {conv.id}</p>
            </div>
          )}

          {initialTab === "members" && (
            <div className="slack-channel-members-view">
              <div className="slack-channel-members-toolbar">
                <label className="slack-channel-dialog-search">
                  <Search size={15} />
                  <input
                    autoFocus
                    value={memberQuery}
                    onChange={(event) => setMemberQuery(event.target.value)}
                    placeholder="Find members"
                  />
                </label>
                <button type="button" className="slack-channel-add-member" aria-label="Add people">
                  <UserPlus size={15} /> Add
                </button>
              </div>
              <div className="slack-channel-member-card">
                {filteredMembers.map((member) => (
                  <div key={member.handle || member.email} className="slack-channel-member-row">
                    <Avatar
                      name={member.name || member.handle}
                      size={30}
                      presence={memberOnline(member) ? "online" : null}
                      src={member.github_login ? `https://github.com/${encodeURIComponent(member.github_login)}.png?size=80` : null}
                    />
                    <div>
                      <strong>{member.name || member.handle}</strong>
                      <span>@{member.handle}{member.admin ? " · Admin" : ""}</span>
                    </div>
                    <button type="button" className="slack-channel-member-more" aria-label={`More actions for ${member.name || member.handle}`}>
                      <MoreHorizontal size={15} />
                    </button>
                  </div>
                ))}
                {filteredMembers.length === 0 && <p className="slack-channel-dialog-no-results">No members match that search.</p>}
              </div>
            </div>
          )}

          {initialTab === "apps" && (
            <DialogEmpty icon={<Bot size={28} />} title="Agents & apps" copy="Agents and connected apps added to this channel will appear here." action="Add an agent or app" />
          )}
          {initialTab === "automations" && (
            <DialogEmpty icon={<Workflow size={28} />} title="Automations" copy="Create channel workflows for routine updates, reviews, and follow-ups." action="Create automation" />
          )}
          {initialTab === "tabs" && (
            <div className="slack-channel-tab-settings">
              <h3>Channel tabs</h3>
              <p>Tabs are shared with everyone in this channel.</p>
              {["Messages", "Canvas", "Files & links", "Bookmarks", ...(conv.tabs ?? []).map((tab) => tab.label)].map((label) => (
                <div key={label}><span>{label}</span><button type="button" aria-label={`More options for ${label}`}><MoreHorizontal size={15} /></button></div>
              ))}
              <button type="button" className="slack-dialog-primary"><Plus size={15} /> Add tab</button>
            </div>
          )}
          {initialTab === "settings" && (
            <div className="slack-channel-settings">
              <section><strong>Channel visibility</strong><span>{conv.private ? "Private — invitation required" : "Public — everyone in this workspace can view and join"}</span></section>
              <section><strong>Posting permissions</strong><span>Everyone can post and reply</span></section>
              <section><strong>Retention</strong><span>Keep all messages and files</span></section>
            </div>
          )}
          </div>
        </div>
      </section>
    </div>
  );
}

function DialogEmpty({ icon, title, copy, action }: { icon: ReactNode; title: string; copy: string; action: string }) {
  return (
    <div className="slack-channel-dialog-empty">
      {icon}
      <h3>{title}</h3>
      <p>{copy}</p>
      <button type="button" className="slack-dialog-primary">{action}</button>
    </div>
  );
}

function memberOnline(member: TeamMember) {
  const explicit = !!(member as TeamMember & { online?: boolean }).online;
  const recent = member.last_seen > 0 && Date.now() / 1000 - member.last_seen < 90;
  return explicit || recent;
}

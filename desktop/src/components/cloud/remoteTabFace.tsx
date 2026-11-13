// What a remote workspace tab is called, says on hover and is drawn with —
// one spelling for the strip, the split menu and a pane's own toolbar, because
// a tab that reads one way on the strip and another in a menu is two things as
// far as the person reading is concerned.

import { Eye, FileText, GitCompare, Terminal as TerminalIcon } from "lucide-react";

import { diffTabLabel, type RemoteTab } from "../../lib/remoteWorkspaceSnapshot";
import { AgentIcon } from "../agent/AgentIcon";
import { CloudGlyph } from "../ui/cloud-glyph";
import { sessionLabel } from "./useBox";

function baseName(path: string): string {
  const at = path.replace(/\/+$/, "").lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

export function remoteTabLabel(tab: RemoteTab): string {
  switch (tab.kind) {
    case "cloud":
      return tab.label;
    case "file":
      return baseName(tab.path);
    case "diff":
      return diffTabLabel(tab.sha);
    case "session":
      return sessionLabel(tab.session);
  }
}

export function remoteTabHint(tab: RemoteTab): string | undefined {
  switch (tab.kind) {
    case "cloud":
      return undefined;
    case "file":
      return undefined;
    case "diff":
      return tab.path ? `${diffTabLabel(tab.sha)} — ${tab.path}` : undefined;
    case "session":
      return `${sessionLabel(tab.session)} — running in ${
        tab.session.project || "the home directory"
      } on the machine${tab.readOnly ? ". You are watching: this tab can't type into it." : ""}`;
  }
}

export function RemoteTabMark({ tab }: { tab: RemoteTab }) {
  switch (tab.kind) {
    case "cloud":
      return <CloudGlyph size={12} />;
    case "file":
      return <FileText size={12} />;
    case "diff":
      return <GitCompare size={12} />;
    case "session":
      // Which way you joined changes what the keyboard does, so it is on the
      // tab and not only in the panel you came from.
      if (tab.readOnly) return <Eye size={12} />;
      if (tab.session.agent)
        return <AgentIcon agentId={tab.session.agent} label={tab.session.agent} size={13} />;
      return <TerminalIcon size={12} />;
  }
}

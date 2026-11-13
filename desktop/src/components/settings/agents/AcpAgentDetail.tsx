// One registry agent, opened: how it signs in, and its own earlier chats
// in this project, each of which picks back up in a chat tab.

import { History, LogOut, Play } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsActions, SettingsEmpty, SettingsError, SettingsStatusLine } from "../../ui/settings-blocks";
import { AgentAuthSection, type AgentAuthMethod } from "../../ui/settings-agent-providers";
import { SettingsRow } from "../../ui/settings-row";
import {
  methodLabel,
  sessionLine,
  sessionTitle,
  signInLine,
  type AcpAgentRow,
  type AcpListedSession,
} from "../../../lib/acpAgents";
import { useAcpSessions, type AcpAction } from "./useAcpAgents";

/** Registry agents sign in inside the chat, through the protocol, so the
 *  card has one method: the one Aura remembered, or the chat's own. */
function signInMethod(row: AcpAgentRow): AgentAuthMethod {
  return row.signed_in_with
    ? { id: row.signed_in_with, label: methodLabel(row.signed_in_with), icon: "key" }
    : { id: "chat", label: "When you first chat", icon: "cli", recommended: true };
}

export function AcpAgentDetail({
  row,
  repoRoot,
  busy,
  onForgetSignIn,
  onResume,
}: {
  row: AcpAgentRow;
  repoRoot: string;
  busy?: AcpAction;
  onForgetSignIn: () => void;
  onResume: (session: AcpListedSession) => void;
}) {
  const chats = useAcpSessions(row.id, repoRoot);
  const method = signInMethod(row);
  const looked = chats.sessions !== null;

  return (
    <div className="ui-acp-agent-detail">
      <AgentAuthSection
        name={row.name}
        methods={[method]}
        method={method.id}
        onMethodChange={() => undefined}
        status={<SettingsStatusLine text={signInLine(row)} />}
      >
        {row.signed_in_with && (
          <SettingsActions>
            <Button variant="outline" size="sm" disabled={busy === "forget"} onClick={onForgetSignIn}>
              {busy === "forget" ? <AsciiSpinner /> : <LogOut />}
              Forget sign-in
            </Button>
          </SettingsActions>
        )}
      </AgentAuthSection>
      <SettingsRow
        title="Earlier chats"
        description={
          repoRoot
            ? `${row.name}’s own saved chats in this project. Resume one to pick it up in a chat tab.`
            : `Open a project to see ${row.name}’s earlier chats in it.`
        }
        control={
          <Button variant="outline" size="sm" disabled={!repoRoot || chats.loading} onClick={() => void chats.look()}>
            {chats.loading ? <AsciiSpinner /> : <History />}
            {looked ? "Look again" : "Show earlier chats"}
          </Button>
        }
      />
      {chats.error && <SettingsError>{`${row.name} couldn’t list its chats: ${chats.error}`}</SettingsError>}
      {chats.sessions?.length === 0 && (
        <SettingsEmpty>{`${row.name} has no saved chats in this project, or keeps none Aura can read.`}</SettingsEmpty>
      )}
      {chats.sessions?.map((s) => (
        <SettingsRow
          key={s.session_id}
          title={sessionTitle(s)}
          description={sessionLine(s)}
          control={
            <Button variant="outline" size="sm" onClick={() => onResume(s)}>
              <Play />
              Resume
            </Button>
          }
        />
      ))}
    </div>
  );
}

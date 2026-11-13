// What came back from the cloud machine: the notes the last sync returned and
// the jobs this page sent, drawn as settings rows so they sit in the same
// column as the machines above them.

import { CircleAlert } from "lucide-react";
import { AgentIcon } from "../../ui/agent-icon";
import { CloudGlyph } from "../../ui/cloud-glyph";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { AgentBit, relativeTime } from "./crewShared";
import { TERMINAL, statusLabel, type CloudAgent, type SentJob } from "./cloudRunnerLabels";

/** The library draws Claude and Codex; Gemini keeps the product's own mark
 *  rather than falling back to a generic terminal. */
export function CloudAgentMark({ agent, size = 16 }: { agent: CloudAgent; size?: number }) {
  return agent === "gemini" ? (
    <AgentBit agentKind={agent} size={size} />
  ) : (
    <AgentIcon provider={agent} size={size} />
  );
}

/** The plain notes the engine returned on the last sync, shown only when
 *  there's something to say. */
export function CloudLastSync({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <SettingsSection title="Last sync">
      <ul className="ui-cloud-runner-notes">
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </SettingsSection>
  );
}

/** Jobs sent this session, newest first. */
export function CloudSentJobs({ jobs }: { jobs: SentJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <SettingsSection
      title="Sent to the cloud"
      description="Press Bring results back to pull finished work into your queue."
    >
      {jobs.map((job) => (
        <SettingsRow
          key={job.id}
          title={
            <span className="ui-cloud-inline">
              {/* A cloud agent is the same agent, somewhere else — so it
                  keeps its own mark, and the cloud mark sits in the control
                  slot. */}
              <CloudAgentMark agent={job.agent} />
              <span className="ui-cloud-runner-job">{job.text}</span>
            </span>
          }
          description={`${statusLabel(job.status)} · sent ${relativeTime(job.at)}`}
          // The reason it failed, in the runner's words. This is usually one
          // command away from fixed ("Not logged in · Please run /login"
          // means the box never signed the agent in) — and before this it
          // never left the box's journal.
          help={
            job.reason ? (
              <span className="ui-cloud-runner-reason">
                <CircleAlert size={12} />
                {job.reason}
              </span>
            ) : undefined
          }
          control={
            // It breathes while the job is still in flight and settles once
            // it lands.
            <CloudGlyph
              size={16}
              pulse={!TERMINAL.has(job.status)}
              label="Running in the cloud"
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

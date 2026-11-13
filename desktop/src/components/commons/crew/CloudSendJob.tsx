// Send a job to the cloud: who works on it, what to do, and how you'll know
// it's done — the same title, line, box and button a cloud setting is drawn
// with. Sending rides `loopCloudSend`, which mints a job on the shared cloud
// board a runner drains, scoped to this repo.

import { useCallback, useState } from "react";
import { Send } from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { Textarea } from "../../ui/textarea";
import "../../ui/cloud-patterns.css";
import "../../ui/cloud-runner.css";

import { api } from "../../../lib/api";
import { trackFeature } from "../../../lib/track";
import { CloudAgentMark } from "./CloudRunnerResults";
import { AGENT_OPTIONS, type CloudAgent, type SentJob } from "./cloudRunnerLabels";

export function CloudSendJob({
  repoRoot,
  connected,
  runsOn,
  onFeedback,
  onSent,
}: {
  repoRoot: string;
  connected: boolean;
  /** The machine that will pick it up, when one is online. */
  runsOn: string | null;
  /** The page's one feedback line: cleared on send, then a note or an error. */
  onFeedback: (note: string | null, error: string | null) => void;
  onSent: (job: SentJob) => void;
}) {
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<CloudAgent>("claude");
  const [acceptance, setAcceptance] = useState("");
  const [sending, setSending] = useState(false);
  const hasMachine = runsOn !== null;

  const onSend = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    onFeedback(null, null);
    try {
      const res = await api.loopCloudSend(repoRoot, body, agent, acceptance.trim() || undefined);
      onSent({ id: res.id, status: res.status, text: body, agent, at: Date.now() });
      setText("");
      setAcceptance("");
      onFeedback(
        hasMachine
          ? "Sent. Your always-on machine will pick it up shortly."
          : "Queued. Nothing is online to run it yet. It starts the moment a machine comes back.",
        null,
      );
      trackFeature("cloud_send");
    } catch (e) {
      onFeedback(null, String(e));
    } finally {
      setSending(false);
    }
  }, [text, agent, acceptance, repoRoot, sending, hasMachine, onFeedback, onSent]);

  return (
    <SettingsSection
      title="Send a job to the cloud"
      description={
        runsOn
          ? `Runs on ${runsOn} and lands back in your queue.`
          : "It waits on the board until a machine picks it up."
      }
    >
      <SettingsRow
        title="Agent"
        description="Which agent should work on it."
        control={
          <Select
            aria-label="Which agent should work on it"
            value={agent}
            onChange={(v) => setAgent(v as CloudAgent)}
            disabled={!connected || sending}
            options={AGENT_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
              icon: <CloudAgentMark agent={o.value} size={14} />,
            }))}
          />
        }
      />
      <div className="ui-cloud-runner-compose">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!connected || sending}
          aria-label="What should it work on?"
          placeholder="What should it work on?"
        />
        {/* The example used to ride in the placeholder. WebKit — which is
            what this app renders in — draws a textarea placeholder on one
            line and clips it, so the half that said what a good brief looks
            like was cut off mid-word and could never be read. It only fits
            as real text. Hidden once you start typing: by then it has done
            its job and it's just noise under your own words. */}
        {!text && (
          <p className="ui-cloud-note">
            e.g. “Add rate-limit retries to the billing client and cover it with a test.”
          </p>
        )}
        <Input
          value={acceptance}
          onChange={(e) => setAcceptance(e.target.value)}
          disabled={!connected || sending}
          aria-label="How you'll know it's done"
          placeholder="How you'll know it's done. Optional (e.g. “tests pass, retries capped at 5”)"
        />
        <SettingsActions>
          <Button
            size="sm"
            onClick={() => void onSend()}
            disabled={!connected || sending || !text.trim()}
          >
            {sending ? <AsciiSpinner size={10} /> : <Send />}
            Send to cloud
          </Button>
        </SettingsActions>
      </div>
    </SettingsSection>
  );
}

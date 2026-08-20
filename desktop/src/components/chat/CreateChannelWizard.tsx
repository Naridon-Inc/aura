// CreateChannelWizard — the full-screen replacement for the old rail
// `window.prompt` + `window.confirm` channel-create flow. Built on the shared
// overlay foundation (FullscreenOverlay + WizardStepTabs), mirroring
// CreateTaskWizard: a single "Channel" step rendered in the focus surface,
// driven by the form primitives (Field / Input / Textarea / SegmentedControl),
// with a sticky [Cancel] … [Create channel] footer.
//
// The create payload maps onto exactly what the existing create call accepts:
// a slugified handle + open/private visibility (the additive `channel_meta`).
// Topic is optional and applied via the same teamChannelUpdate the Settings →
// Team → Channels editor uses, so there's still one create path — sourced from
// the form instead of native browser popups. Quick-create parity holds: the
// "Create channel" button lights up the moment Name is non-empty and
// ⌘/Ctrl-Enter submits from anywhere in the body.

import { useMemo, useState, type KeyboardEvent } from "react";

import { FullscreenOverlay } from "../FullscreenOverlay";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SegmentedControl } from "../ui/segmented";
import { WizardStepTabs, useWizard, type WizardStepMeta } from "../ui/wizard";

export type CreateChannelInput = {
  /** Display name as typed — the submit handler slugifies to the handle. */
  name: string;
  /** Maps onto the additive channel_meta visibility. */
  visibility: "open" | "private";
  /** Optional channel topic; applied after create when non-empty. */
  topic?: string;
};

type Props = {
  onCancel: () => void;
  onSubmit: (input: CreateChannelInput) => Promise<void>;
};

const STEPS: WizardStepMeta[] = [{ id: "channel", label: "Channel" }];

const VISIBILITY_OPTS = [
  { value: "open" as const, label: "Public" },
  { value: "private" as const, label: "Private" },
];

// Mirror the handle slug the existing createChannel callback builds, so the
// "#preview" the user sees matches the channel that actually gets created.
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

export function CreateChannelWizard({ onCancel, onSubmit }: Props) {
  const wizard = useWizard(STEPS.length);

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"open" | "private">("open");
  const [submitting, setSubmitting] = useState(false);

  const slug = useMemo(() => slugify(name), [name]);
  const nameValid = slug.length > 0;

  async function submit() {
    if (!nameValid || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        visibility,
        topic: topic.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function onBodyKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <FullscreenOverlay
      onClose={onCancel}
      tabs={
        <WizardStepTabs
          steps={STEPS}
          index={wizard.index}
          onJump={wizard.goTo}
        />
      }
      contentClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="accentSoft"
            size="sm"
            disabled={!nameValid || submitting}
            onClick={() => void submit()}
          >
            {submitting ? "Creating…" : "Create channel"}
          </Button>
        </>
      }
    >
      <div
        className="flex w-full flex-col items-center px-6 py-12 sm:py-16"
        onKeyDown={onBodyKeyDown}
      >
        <div className="flex w-full max-w-[720px] flex-col gap-8">
          <h1 className="text-xl font-medium leading-7 text-text-1">
            New channel
          </h1>

          <div className="flex flex-col gap-6">
            <Field
              label="Name"
              htmlFor="ccw-name"
              description={
                nameValid
                  ? `Created as #${slug}`
                  : "Lowercase letters, numbers and dashes."
              }
            >
              <Input
                id="ccw-name"
                autoFocus
                prefix="#"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="design-reviews"
              />
            </Field>

            <Field
              label="Topic"
              htmlFor="ccw-topic"
              optional
              description="What this channel is for. Shown in the channel header."
            >
              <Textarea
                id="ccw-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                rows={3}
                placeholder="Async design crits, screenshots, and decisions."
              />
            </Field>

            <Field
              label="Visibility"
              description={
                visibility === "private"
                  ? "Only invited members and team admins see it. Add members in Settings → Team → Channels."
                  : "Everyone on the team can see and join it."
              }
            >
              <SegmentedControl
                value={visibility}
                onChange={setVisibility}
                options={VISIBILITY_OPTS}
                ariaLabel="Channel visibility"
              />
            </Field>
          </div>
        </div>
      </div>
    </FullscreenOverlay>
  );
}

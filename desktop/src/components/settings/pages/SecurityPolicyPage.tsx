import { Button } from "../../ui/button";
import { api, type SettingsView } from "../../../lib/api";
import { Row, Section, StatusPill } from "../kit";
import { askConfirm, askNotice } from "../../ui/ask";
import { SettingsActions } from "../../ui/settings-blocks";
import { GrantsSection, TemplatesSection } from "./PolicySections";


export function SecurityPolicyPage({
  view,
  repoRoot,
  onChanged,
}: {
  view: SettingsView;
  repoRoot: string;
  onChanged: () => void;
}) {
  const strict = view.strict_gatekeeper_mode;
  const locked = view.strict_mode_locked;
  const disable = async () => {
    if (locked) return;
    if (
      !(await askConfirm({
        title: "Turn strict mode off?",
        body: "The pre-commit guard stops blocking risky changes. An agent could then delete code without accounting for it.",
        confirmLabel: "Turn it off",
        tone: "danger",
      }))
    ) {
      return;
    }
    try {
      await api.settingsDisableStrictUnlocked();
      onChanged();
    } catch (e) {
      await askNotice({ title: "Couldn't change strict mode", body: String(e) });
    }
  };
  // The one direction this pane couldn't go. Turning the guard off was a
  // click; turning it on was `aura config set strict-mode true` in a
  // terminal — which also refuses outside an interactive TTY and demands a
  // passcode, so the sentence's "(with a passcode, recommended)" was not
  // optional either. Easy to remove the protection, hard to add it, on the
  // setting the whole product is about. No confirm: switching a guard on is
  // never the dangerous direction, and it's one click back.
  const enable = async () => {
    try {
      await api.settingsEnableStrictUnlocked();
      onChanged();
    } catch (e) {
      await askNotice({ title: "Couldn't change strict mode", body: String(e) });
    }
  };
  return (
    <>
      <Section title="Strict mode">
        <Row
          label="Status"
          // What strict mode is doing right now, said in the row it belongs to
          // rather than in a loose paragraph hung underneath the section. Out
          // there it sat outside the divided list, so it read as a footnote
          // about the section instead of the description of this setting, and
          // it took the row's own bottom hairline with it.
          description={
            <>
              {locked ? (
                <>
                  Strict mode is passcode-locked. Only a human at a real
                  terminal can turn it off. Run{" "}
                  <code>aura config reset-passcode</code>{" "}
                  from a real terminal.
                </>
              ) : strict ? (
                <>
                  Strict mode is on. Before every commit, Aura checks the AI
                  didn't quietly delete working code or do something different
                  from what it said, and stops the commit if it did. Anything on
                  this machine can still switch it back off — to lock it behind
                  a passcode, run{" "}
                  <code>
                    aura config set strict-mode true
                  </code>{" "}
                  from a real terminal.
                </>
              ) : (
                <>
                  Strict mode is off. Turn it on and Aura stops any commit where
                  the AI deleted working code without accounting for it, or did
                  something different from what it promised. To also lock it, so
                  nothing on this machine — an agent included — can switch it
                  back off, run{" "}
                  <code>
                    aura config set strict-mode true
                  </code>{" "}
                  from a real terminal and set a passcode.
                </>
              )}
            </>
          }
        >
          <SettingsActions>
            {/* Colour tracks how protected the repo is, not how loud the
                state sounds. On-and-locked is the safest this can be, so it
                is green; red is the colour everything else in the app uses
                for failure. On-but-unlocked is amber — the protection is real
                but a machine can still switch it off. Off is the actual risk. */}
            <StatusPill
              tone={strict ? (locked ? "green" : "amber") : "red"}
              text={locked ? "On · locked" : strict ? "On" : "Off"}
            />
            {!strict && !locked && (
              <Button size="sm" onClick={enable}>
                Turn on
              </Button>
            )}
            {strict && !locked && (
              <Button variant="outlineDestructive" size="sm" onClick={disable}>
                Turn off
              </Button>
            )}
          </SettingsActions>
        </Row>
        {/* The other half of the guard, and the half nothing in the app
            mentioned. Everything above happens at commit time, after the
            work is done; these three happen the moment an agent asks, and
            they are the only ones a written-down reason can never buy —
            the agent writes that reason itself. A person reading this pane
            should not have to find that out from a refusal. */}
        <Row
          label="Three things an agent cannot decide alone"
          description={
            locked ? (
              <>
                Deleting a file, throwing away work you have not committed, and
                overwriting the shared history on the server. An agent asking
                for one of these is refused outright — writing down a reason
                first changes nothing, because the agent writes the reason. A
                person at a terminal allows one, once, with{" "}
                <code>aura grant issue</code>.
              </>
            ) : (
              <>
                Deleting a file, throwing away work you have not committed, and
                overwriting the shared history on the server. Today Aura asks
                you before each one. Lock strict mode with a passcode and the
                question becomes a refusal, unless a person has allowed that
                exact action ahead of time with{" "}
                <code>aura grant issue</code>.
              </>
            )
          }
        >
          {null}
        </Row>
      </Section>
      <GrantsSection repoRoot={repoRoot} />
      {/* There used to be a second telemetry switch here — "Anonymous
          telemetry", hinted "Per-command usage counts." It was the SAME
          boolean as Telemetry → Usage analytics: `settings_set_telemetry`
          and `telemetry_set_consent` both write `telemetry_enabled` into
          ~/.aura/credentials.json. Two rows, two names, two descriptions,
          one value — and neither read the other, so flipping this one left
          the other still reading ON until its own fetch reran. On a privacy
          control that is the worst possible failure: you turn it off, you
          see something that looks like it's still on, and you can't tell
          which is true. telemetry.rs already knew, in a comment: "the
          Settings → Privacy toggle, which wrote `telemetry_enabled` alone".
          It self-healed the consent marker and left the second switch.

          One switch now, in the Telemetry tab, beside the crash-report
          switch it shares a decision with and above the counts view that
          shows what's been recorded. */}
      <TemplatesSection repoRoot={repoRoot} />
    </>
  );
}

/// A grant is one person, at a terminal, allowing one delete / discard /
/// force-push, once, for about fifteen minutes. Until now the only place
/// it existed was `aura grant list` in a shell: the app could not tell
/// you that a standing permission was sitting in the repository, and
/// could not take it back. That is the residual risk the grant design
/// names out loud — a forgotten grant is a hole that closes on a timer.
///
/// "Standing" here means only that it has not run out yet. Whether it
/// still matches this repository, this copy and the file it was issued
/// against is decided by the guard at the moment the action is tried, so
/// a row can show a permission that would in fact be refused. That way
/// round is the safe one: it makes a reader look, never relax.

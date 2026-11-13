import { useEffect, useState } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import { Button } from "../../ui/button";
import { SettingsRow } from "../../ui/settings-row";
import { chatLink, noteHelpLinkOpened, starLink } from "../../../lib/community";
import { KeyValueTable, Section } from "../kit";
import { KbdCombo } from "./ShortcutsPage";

// ── Help & Support ─────────────────────────────────────────────────────
//
// One calm place for the things people hunt for when they're stuck: the
// tour, the keyboard map, the docs/repo/issue links, and which build
// they're running.

const HELP_LINKS: Array<{
  label: string;
  hint: string;
  url: string;
}> = [
  {
    label: "Documentation",
    hint: "Guides, concepts, and the semantic-engine reference",
    url: "https://auravcs.com/learn/",
  },
  {
    // The repo page and the star are the same destination, so this is one row,
    // not two. Label, hint and URL come from lib/community so the Settings row,
    // the first-run screen and the earned nudge can never disagree.
    label: starLink().label,
    hint: starLink().hint,
    url: starLink().url,
  },
  {
    label: "Report an issue",
    hint: "File a bug or request a feature",
    url: "https://github.com/Naridon-Inc/aura/issues/new",
  },
  {
    label: chatLink().label,
    hint: chatLink().hint,
    url: chatLink().url,
  },
];

async function openHelpUrl(url: string) {
  // Opening the repo or the community from here counts the same as doing it
  // from the first-run screen, so someone who already starred never gets the
  // earned nudge asking them to.
  noteHelpLinkOpened(url);
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (e) {
    console.warn("openUrl failed:", e);
  }
}

export function HelpPage({
  onClose,
  onShortcuts,
}: {
  onClose: () => void;
  /** Opens the Keyboard shortcuts page. */
  onShortcuts: () => void;
}) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (alive) setVersion(v);
      } catch {
        // dev/browser fallback — leave version unknown rather than guess
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <SettingsRow
        title="Take the tour"
        description="A 60-second walkthrough of what Aura does and where things live."
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onClose();
              window.dispatchEvent(new Event("aura:start-tour"));
            }}
          >
            <Sparkles />
            Start
          </Button>
        }
      />
      <SettingsRow
        title="Keyboard shortcuts"
        description={
          <>
            Press <KbdCombo combo="⌘K" /> any time to search every command, file, and agent action.
          </>
        }
        control={
          <Button size="sm" variant="outline" onClick={onShortcuts}>
            Show all
          </Button>
        }
      />
      {HELP_LINKS.map((link) => (
        <SettingsRow
          key={link.label}
          title={link.label}
          description={link.hint}
          control={
            <Button size="sm" variant="outline" onClick={() => void openHelpUrl(link.url)}>
              Open
              <ExternalLink />
            </Button>
          }
        />
      ))}
      <Section
        title="About"
        description="Aura watches every change the way a careful teammate would. It sees what each edit means, checks it still matches what you asked for, and lets you bring back a single piece if something breaks."
      >
        <KeyValueTable
          rows={[
            { key: "version", label: "Version", value: version ? `v${version}` : "—", mono: true },
            { key: "surfaces", label: "Runs on", value: "CLI · Desktop · Cloud" },
            { key: "licence", label: "Licence", value: "Open source, under the Naridon umbrella" },
          ]}
        />
      </Section>
    </>
  );
}

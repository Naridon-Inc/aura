// Settings → Advanced: the switches that trade a default for something only
// some people want, and where parallel copies of a repository are made. They
// used to sit at the bottom of the repository's security page, but none of
// them is about one repository — each one is about this machine.
import { type ReactNode } from "react";

import { api, type SettingsView } from "../../../lib/api";
import { Section, Toggle } from "../kit";
import { WorktreesSection } from "./PolicySections";

export function AdvancedPage({
  view,
  onChanged,
  children,
}: {
  view: SettingsView;
  onChanged: () => void;
  /** Parts folded into the page, drawn after its own rows. */
  children?: ReactNode;
}) {
  return (
    <>
      <WorktreesSection view={view} onChanged={onChanged} />
      {/* Both of these described themselves in terms of the machinery rather
          than the consequence, and both descriptions were wrong about the
          consequence — see each hint. Checked against the code that reads the
          flags: aura-cli/src/embeddings.rs and, for dev mode,
          security.rs + main.rs (secret guard, taste gate) + ci.rs. */}
      <Section>
        <Toggle
          label="Keep search on this machine"
          /* Was: "Force 100% offline embeddings (slower; requires sovereign
             embedding daemon)." Both parenthetical claims were false. The
             local path is `embed_local` — a trigram feature hash running
             in-process, so there is no daemon to require, and it is not
             slower than an HTTPS round trip with an 8-second timeout. It
             tells you a privacy control costs speed and needs infrastructure
             you don't have, which are two reasons not to turn on the private
             option. What it actually trades is precision. */
          hint="To search by meaning, Aura sends your text to OpenAI or Gemini to read. Turn this on and it never leaves this machine. Aura matches with its own built-in method instead, which is less precise but sends nothing anywhere."
          value={view.use_local_embeddings}
          onChange={async (v) => {
            await api.settingsSetLocalEmbeddings(v);
            onChanged();
          }}
        />
        <Toggle
          label="Dev mode"
          /* Was: "Bypass heavy infrastructure for local development. Off in
             production." There is no production — this is an app on your
             desk — and "heavy infrastructure" is three specific guards, one
             of which is the thing that stops you committing an API key.
             A switch that turns off a secret guard has to say so. The name
             stays "Dev mode" because that's what the CLI calls it, and one
             more name for one thing is what the last two commits were for. */
          hint="Trades Aura's checks for speed on a machine only you use. Aura stops blocking commits that look like they contain a secret, skips the house-style check, and sets up one local key instead of the full recovery-key set."
          value={view.dev_mode}
          onChange={async (v) => {
            await api.settingsSetDevMode(v);
            onChanged();
          }}
        />
      </Section>
      {children}
    </>
  );
}

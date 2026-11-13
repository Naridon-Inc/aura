import { useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { type GitProfile } from "../../../lib/api";
import { IdentityPanel } from "../../identity/IdentityPanel";

// Who you are in each project, and the editor for a named git identity.
//
// Surfaces the per-repo identity override map + the alias-augmented
// roster for the current repo. Two concerns intentionally co-located so
// a user fixing "messages don't appear under @mck" doesn't have to
// bounce between two panes:
//   1. Per-repo override map — list every repo on this device that has
//      a stored override, with a "Set as default for this repo" button
//      pinned to `repoRoot`.
//   2. Roster identities — every claimed team member in the current
//      repo's manifest, plus their `also_emails`. Admins (or the
//      handle's owner) can add / remove aliases inline; non-admins see
//      the list read-only with a tooltip explaining the gate.
//
// The current implementation keeps both surfaces flat — no nested
// dialogs — because the typical interaction is "I have one or two
// repos with an override, and I want to verify the alias on my own
// handle". Anything heavier would be over-engineered for the volume.

export function IdentitySection({ repoRoots }: { repoRoots: string[] }) {
  // "This is me" — the multi-repo, confusion-aware identity surface.
  // Each open git project gets one calm row; the user confirms who they
  // are per repo (a different git email per project is common). Never a
  // silent merge, always one click. Replaces the old single-repo form.
  return (
    <SettingsSection
      title="You in each repository"
      description="Each repository can use a different git email. Confirm who you are in each."
    >
      <IdentityPanel repoRoots={repoRoots} />
    </SettingsSection>
  );
}

export function GitProfileEditor({
  initial,
  existingIds,
  onCancel,
  onSave,
  busy,
}: {
  initial: GitProfile;
  existingIds: Set<string>;
  onCancel: () => void;
  onSave: (p: GitProfile) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<GitProfile>(initial);
  const isNew = !existingIds.has(initial.id);
  const idCollision = isNew && draft.id.trim().length > 0 && existingIds.has(draft.id.trim());
  const field = (
    id: string,
    title: string,
    value: string,
    onChange: (v: string) => void,
    extra: { placeholder?: string; disabled?: boolean; invalid?: boolean; help?: string } = {},
  ) => (
    <SettingsRow
      title={title}
      htmlFor={`git-profile-${id}`}
      help={extra.help}
      control={
        <Input
          id={`git-profile-${id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={extra.placeholder}
          disabled={extra.disabled}
          invalid={extra.invalid}
        />
      }
    />
  );

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Cancelling the profile edit ends here; Settings stays open.
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {field("id", "Profile id", draft.id, (v) => setDraft({ ...draft, id: v.replace(/\s+/g, "-") }), {
        placeholder: "work, personal, client-acme",
        disabled: !isNew,
        invalid: idCollision,
        help: idCollision ? "That id is already in use." : undefined,
      })}
      {field("label", "Label", draft.label, (v) => setDraft({ ...draft, label: v }), {
        placeholder: "Work. TouchStage",
      })}
      {field("name", "Git author name", draft.user_name, (v) => setDraft({ ...draft, user_name: v }))}
      {field("email", "Git author email", draft.user_email, (v) => setDraft({ ...draft, user_email: v }))}
      {field("key", "Signing key", draft.signing_key ?? "", (v) => setDraft({ ...draft, signing_key: v || null }), {
        placeholder: "GPG key id or SSH pubkey path",
      })}
      <SettingsRow
        title={isNew ? "Save this identity" : "Save changes"}
        control={
          <SettingsActions>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => onSave(draft)}
              disabled={
                busy || !draft.id.trim() || !draft.user_name.trim() || !draft.user_email.trim() || idCollision
              }
            >
              Save
            </Button>
          </SettingsActions>
        }
      />
    </div>
  );
}

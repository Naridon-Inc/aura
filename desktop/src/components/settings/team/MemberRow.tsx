import { Fragment } from "react";
import { MoreHorizontal } from "lucide-react";

import { type TeamMember } from "../../../lib/api";
import { avatarSrcForMember } from "../../../lib/memberAvatar";
import { memberIdentityLine } from "../../../lib/memberIdentity";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { askConfirm } from "../../ui/ask";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Select } from "../../ui/select";
import { SettingsMemberRow } from "../../ui/settings-team-members";
import { Avatar } from "../../team/presentation/Avatar";
import { type TeamRoster } from "./useTeamRoster";

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

/** One person on the project roster: face, name, how they sign work, and the
 *  controls you hold over their row. An admin sets anyone else's role; you
 *  manage your own photo and the addresses folded into you. */
export function MemberRow({
  member: m,
  members,
  roster,
  isMe,
  iAmAdmin,
}: {
  member: TeamMember;
  members: TeamMember[];
  roster: TeamRoster;
  isMe: boolean;
  iAmAdmin: boolean;
}) {
  const name = m.name || m.handle;
  const busy =
    roster.busyEmail === m.email ||
    (m.also_emails ?? []).some((alias) => roster.busyEmail === alias);
  const photo = roster.avatars[m.email.toLowerCase()];
  const canSetRole = iAmAdmin && !isMe;
  // Folded-in addresses can be pulled back out on your own row or by an
  // admin (the backend enforces the same); otherwise they are shown
  // read-only so people can still see who is grouped together.
  const canSeparate = isMe || iAmAdmin;
  const aliases = m.also_emails ?? [];
  const others = members.filter((o) => o.email.toLowerCase() !== m.email.toLowerCase());
  const canMerge = (iAmAdmin || isMe) && others.length > 0;
  const canTransfer = canSetRole && !m.admin;

  const detail = [
    isMe ? "You" : null,
    memberIdentityLine(m.email) || null,
    `${m.commits} commit${m.commits === 1 ? "" : "s"}`,
    relativeAgeFromSecs(m.last_seen, { empty: "" }) || null,
    m.activity_text || null,
  ]
    .filter(Boolean)
    .join(" · ");

  const transfer = async () => {
    if (
      await askConfirm({
        title: `Transfer admin to ${name}?`,
        body: "You step down to a regular member. Only they can hand it back.",
        confirmLabel: "Transfer admin",
      })
    ) {
      void roster.transferAdmin(m.email);
    }
  };

  // Who this row is, then their role, then your own photo — each group only
  // when it has something to offer, with a rule between the ones that do.
  const identityItems = [
    canMerge && (
      // Manual "these two are the same person": folds the picked member into
      // this row durably.
      <DropdownMenuSub key="merge">
        <DropdownMenuSubTrigger>Same person as…</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {others.map((o) => {
            const line = memberIdentityLine(o.email);
            return (
              <DropdownMenuItem
                key={o.email}
                disabled={roster.busyEmail !== null}
                onSelect={() => void roster.mergeWith(m.email, o.email)}
              >
                {o.name || o.handle}
                {line ? ` · ${line}` : ""}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    ),
    ...(canSeparate ? aliases : []).map((alias) => (
      <DropdownMenuItem key={alias} onSelect={() => void roster.separateAlias(m.handle, alias)}>
        Not the same person as {alias}
      </DropdownMenuItem>
    )),
  ].filter(Boolean);
  const roleItems = canTransfer
    ? [
        <DropdownMenuItem key="transfer" onSelect={() => void transfer()}>
          Transfer admin and step down
        </DropdownMenuItem>,
      ]
    : [];
  // Your own row gets the photo control: pick a picture, or drop back to your
  // GitHub avatar / animal monogram.
  const photoItems = isMe
    ? [
        <DropdownMenuItem key="photo" onSelect={() => void roster.pickPhoto(m.email)}>
          {photo ? "Change photo" : "Set photo"}
        </DropdownMenuItem>,
        photo && (
          <DropdownMenuItem key="clear" onSelect={() => void roster.clearPhoto(m.email)}>
            Remove photo
          </DropdownMenuItem>
        ),
      ].filter(Boolean)
    : [];
  const menuGroups = [identityItems, roleItems, photoItems].filter((g) => g.length > 0);

  return (
    <SettingsMemberRow
      avatar={
        <Avatar
          name={m.name || m.handle || m.email}
          identity={m.email}
          size={26}
          src={avatarSrcForMember(m, roster.avatars)}
          title={name}
        />
      }
      name={
        <>
          {name}
          {m.status_emoji ? ` ${m.status_emoji}` : ""}
        </>
      }
      detail={detail}
      extra={aliases.length > 0 ? <small>Also signs as {aliases.join(", ")}</small> : undefined}
      control={
        <>
          {busy && <AsciiSpinner />}
          <Select
            aria-label={`Role for ${name}`}
            value={m.admin ? "admin" : "member"}
            disabled={!canSetRole || busy}
            onChange={(role) => {
              if ((role === "admin") !== m.admin) void roster.setAdmin(m.email, role === "admin");
            }}
            options={ROLE_OPTIONS}
          />
          {menuGroups.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="iconSm"
                  disabled={busy}
                  aria-label={`More for ${name}`}
                  title={`More for ${name}`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {menuGroups.map((group, i) => (
                  <Fragment key={i}>
                    {i > 0 && <DropdownMenuSeparator />}
                    {group}
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
    />
  );
}

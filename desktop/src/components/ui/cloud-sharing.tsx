import { useEffect, useState } from "react";
import { Link, Lock, Users, Plus, X } from "lucide-react";
import { Kbd } from "./kbd";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Select } from "./select";
import { type CloudMember, MemberAvatar } from "./cloud-workspace";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog";
export interface WorkspaceAccess {
  general: "organization" | "restricted";
  grants: { memberId: string; level: "Read" | "Write" }[];
}
export function WorkspaceShare({
  value,
  members,
  onSave,
  onCopyLink,
  orgName,
  readOnly = false,
  error,
  errorAction,
  saving = false,
  copyShortcut,
}: {
  value: WorkspaceAccess;
  /** The people who could be added. */
  members: CloudMember[];
  onSave: (value: WorkspaceAccess) => void;
  onCopyLink?: () => void;
  /** The organization, named where "everyone" is offered. */
  orgName?: string;
  /** You may see who has access but not change it. */
  readOnly?: boolean;
  /** Why the last save didn't take, in the server's words. */
  error?: string | null;
  /** The one step that clears that error, offered under it. */
  errorAction?: { label: string; onClick: () => void };
  saving?: boolean;
  /** The keys that copy the link, when something binds them. */
  copyShortcut?: string;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(value),
    [discard, setDiscard] = useState(false),
    [person, setPerson] = useState("");
  // A saved value comes back as the server holds it; start again from that.
  useEffect(() => setDraft(value), [value]);
  const dirty = !readOnly && JSON.stringify(value) !== JSON.stringify(draft);
  const org = orgName?.trim() || "your organization";
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next && dirty) {
            setDiscard(true);
            return;
          }
          setDraft(value);
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="ghost" size="iconSm" aria-label="Manage access">
            {value.general === "restricted" ? <Lock /> : <Users />}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="ui-cloud-share">
          <header>
            <strong>Share</strong>
            {dirty && (
              <Button size="sm" disabled={saving} onClick={() => onSave(draft)}>
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </header>
          {readOnly && (
            <p>Only the person who opened this workspace or an admin of {org} can change who has access.</p>
          )}
          {error && (
            <p className="ui-cloud-share-error" role="alert">
              {error}
            </p>
          )}
          {error && errorAction && !readOnly && (
            <Button
              size="sm"
              className="ui-cloud-share-fix"
              disabled={saving}
              onClick={errorAction.onClick}
            >
              {saving ? "Adding…" : errorAction.label}
            </Button>
          )}
          {!readOnly && (
          <div className="ui-cloud-inline">
            <Select
              aria-label="Add people"
              value={person}
              onChange={setPerson}
              placeholder="Add people…"
              options={members
                .filter((m) => !draft.grants.some((g) => g.memberId === m.id))
                .map((m) => ({ value: m.id, label: m.name }))}
            />
            <Button
              size="iconSm"
              variant="secondary"
              aria-label="Add selected person"
              disabled={!person}
              onClick={() => {
                setDraft((d) => ({
                  ...d,
                  grants: [...d.grants, { memberId: person, level: "Write" }],
                }));
                setPerson("");
              }}
            >
              <Plus />
            </Button>
          </div>
          )}
          <h3>People with access</h3>
          {!draft.grants.length && <p>No one has been added</p>}
          {draft.grants.map((g) => {
            const m = members.find((m) => m.id === g.memberId);
            return (
              m && (
                <div className="ui-cloud-share-member" key={m.id}>
                  <MemberAvatar member={m} />
                  <span>{m.name}</span>
                  <Select
                    aria-label={`Access for ${m.name}`}
                    disabled={readOnly}
                    value={g.level}
                    onChange={(level) =>
                      setDraft((d) => ({
                        ...d,
                        grants: d.grants.map((x) =>
                          x.memberId === m.id
                            ? { ...x, level: level as "Read" | "Write" }
                            : x,
                        ),
                      }))
                    }
                    options={[
                      { value: "Read", label: "Read" },
                      { value: "Write", label: "Write" },
                    ]}
                  />
                  {!readOnly && (
                  <Button
                    size="iconXs"
                    variant="ghost"
                    aria-label={`Remove access for ${m.name}`}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        grants: d.grants.filter((x) => x.memberId !== m.id),
                      }))
                    }
                  >
                    <X />
                  </Button>
                  )}
                </div>
              )
            );
          })}
          <h3>General access</h3>
          <Select
            aria-label="General workspace access"
            disabled={readOnly}
            value={draft.general}
            onChange={(general) =>
              setDraft((d) => ({
                ...d,
                general: general as WorkspaceAccess["general"],
              }))
            }
            options={[
              {
                value: "organization",
                label: `Everyone in ${org}`,
                icon: <Users size={13} />,
              },
              {
                value: "restricted",
                label: "Only people invited",
                icon: <Lock size={13} />,
              },
            ]}
          />
          <p>
            {draft.general === "restricted"
              ? `Only the people added here, the person who opened it and ${org}’s admins can open it.`
              : `Anyone in ${org} who can open this project can open it.`}
          </p>
          {onCopyLink && (
            <Button variant="ghost" size="sm" onClick={onCopyLink}>
              <Link />
              Copy link {copyShortcut && <Kbd>{copyShortcut}</Kbd>}
            </Button>
          )}
        </PopoverContent>
      </Popover>
      <AlertDialog open={discard} onOpenChange={setDiscard}>
        <AlertDialogContent>
          <AlertDialogTitle>Discard access changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes to workspace access.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDraft(value);
                setOpen(false);
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

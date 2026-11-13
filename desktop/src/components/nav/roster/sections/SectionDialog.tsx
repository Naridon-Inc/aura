// "New section" / "Edit section": an emoji button and a name, then Cancel or
// Create (Save when editing). The emoji button opens the same emoji choices a
// repository's icon picker has: a short list, any emoji typed or pasted, and
// the system picker.
//
// Create always makes a section. With the name left empty it is called what
// the field's placeholder says, "New section"; a greyed-out Create on an empty
// field read as a button that did nothing, and no section ever came up.

import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../ui/dialog";
import { Input } from "../../../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/popover";
import { EmojiTab } from "../../../repo-icon/EmojiTab";
import type { RepoLook } from "../../../repo-icon/repoIconChoice";
import { setWorkspacePinned } from "../../../../lib/workspaceCustomization";
import {
  NEW_SECTION_NAME,
  nameForNewSection,
  sectionName,
  type RosterSectionDef,
} from "./sectionModel";
import { createSection, editSection, putInSection, putRepoInSection } from "./sectionStore";
import { closeSectionDialog, useSectionDialogRequest } from "./sectionDialogState";
import "../../../repo-icon/repo-icon-picker.css";
import "./sections.css";

export function SectionDialog({ sections }: { sections: readonly RosterSectionDef[] }) {
  const request = useSectionDialogRequest();
  const editing = request?.mode === "edit" ? sections.find((s) => s.id === request.id) : undefined;
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState<string | undefined>();
  const [choosing, setChoosing] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(editing?.name ?? "");
    setEmoji(editing?.emoji);
    setChoosing(false);
  }, [request, editing?.name, editing?.emoji]);

  const open = request !== null && (request.mode === "new" || !!editing);
  // A new section can always be made (an empty name falls back to the
  // placeholder's); an edit still needs a name to rename it to.
  const usable = !editing || sectionName(name).length > 0;

  const submit = () => {
    if (!request || !usable) return;
    if (request.mode === "edit") {
      editSection(request.id, { name, emoji });
    } else {
      const id = createSection({ name: nameForNewSection(name, sections), emoji }, request.before);
      if (request.movePath) {
        // A workspace is in one place: moving it into a section takes it out
        // of "Pinned".
        setWorkspacePinned(request.movePath, false);
        putInSection(request.movePath, id);
      }
      if (request.moveRepo) {
        // So is a repository filed whole.
        setWorkspacePinned(request.moveRepo, false);
        putRepoInSection(request.moveRepo, id);
      }
      revealSection(id);
    }
    closeSectionDialog();
  };

  const look: RepoLook = {
    emoji: emoji ?? null,
    chosen: null,
    custom: !!emoji,
    setAutomatic: () => setEmoji(undefined),
    setEmoji: (next) => setEmoji(next),
    setIcon: () => false,
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeSectionDialog()}>
      <DialogContent
        className="ui-section-dialog"
        // The name is what this dialog is for: the caret goes there, with any
        // name being edited selected so it can be typed over.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          field.current?.focus();
          field.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? "Edit section" : "New section"}</DialogTitle>
          <DialogDescription className="sr-only">
            {editing ? "Edit the section name" : "Choose a name for the new navigation section"}
          </DialogDescription>
        </DialogHeader>
        <div className="ui-section-dialog-row">
          <Popover open={choosing} onOpenChange={setChoosing}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="ui-section-dialog-emoji"
                aria-label={emoji ? "Change section emoji" : "Choose section emoji"}
              >
                {emoji ? <span aria-hidden>{emoji}</span> : <Smile />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="ui-section-emoji-picker">
              <EmojiTab root="" name={name} look={look} onClose={() => setChoosing(false)} />
            </PopoverContent>
          </Popover>
          <Input
            ref={field}
            aria-label="Section name"
            placeholder={editing ? "Section name" : NEW_SECTION_NAME}
            value={name}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={closeSectionDialog}>
            Cancel
          </Button>
          <Button disabled={!usable} onClick={submit}>
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Bring a section just made into view. It lands under "Pinned", and one
 *  made from a workspace's menu far down the list is otherwise out of sight
 *  of the row that asked for it. */
function revealSection(id: string): void {
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-section-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

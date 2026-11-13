import { useRef, type FormEvent } from "react";
import { Smile, X } from "lucide-react";
import { api } from "../../lib/api";
import { EMOJI_PRESETS } from "../../lib/workspaceCustomization";
import { firstGrapheme } from "../../lib/graphemes";
import type { RepoIconTabProps } from "./repoIconChoice";

const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** A short list of emoji, any other one typed or pasted, or the system's own
 *  emoji picker. */
export function EmojiTab({ look, onClose }: RepoIconTabProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const take = (raw: string) => {
    const glyph = firstGrapheme(raw);
    if (!glyph || !PICTOGRAPH.test(glyph)) return false;
    look.setEmoji(glyph);
    onClose();
    return true;
  };
  const onInput = (e: FormEvent<HTMLInputElement>) => {
    if (take(e.currentTarget.value)) e.currentTarget.value = "";
  };
  return (
    <div className="ui-repo-icon-tab">
      <div className="ui-repo-icon-search">
        <Smile size={14} aria-hidden />
        <input
          ref={input}
          placeholder="Type or paste an emoji"
          aria-label="Type or paste an emoji"
          onInput={onInput}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="ui-repo-icon-more"
          title="Open the system emoji picker"
          onClick={() => {
            input.current?.focus();
            void api.openSystemEmojiPicker().catch(() => {
              /* no system picker: the field stays focused for the OS shortcut */
            });
          }}
        >
          More emoji
        </button>
        {look.custom && (
          <button
            type="button"
            className="ui-repo-icon-clear"
            aria-label="Remove emoji"
            title="Remove emoji"
            onClick={() => {
              look.setAutomatic();
              onClose();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="ui-repo-icon-grid" data-cols="8">
        {EMOJI_PRESETS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="ui-repo-icon-emoji"
            data-selected={look.emoji === emoji || undefined}
            onClick={() => {
              look.setEmoji(emoji);
              onClose();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

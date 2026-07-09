// 12-glyph icon set users can pick for any tab. Brand glyphs (claude/
// gemini/codex/cursor) are simplified shapes — same family as
// AgentIcon.tsx. Decorative glyphs (flame/bolt/flask/anchor/book/star/
// leaf) are abstract enough to assign to any kind of tab.
//
// `default` falls through to the caller-supplied fallback (file glyph,
// agent monogram, or terminal prompt) so users can clear an icon back
// to the auto-rendered one.

import type { TabIcon } from "../../lib/useTabCustomization";

type Props = {
  icon: TabIcon;
  size?: number;
  className?: string;
};

export function TabIconGlyph({ icon, size = 14, className }: Props) {
  const s = size;
  switch (icon) {
    case "claude":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M8 1.5C5.6 4 5.6 5.5 8 8c2.4 2.5 2.4 4 0 6.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M1.5 8c2.5-2.4 4-2.4 6.5 0 2.5 2.4 4 2.4 6.5 0"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "gemini":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" className={className}>
          <path d="M8 1l1.6 5.4L15 8l-5.4 1.6L8 15l-1.6-5.4L1 8l5.4-1.6L8 1z" />
        </svg>
      );
    case "codex":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M8 1.8 13.4 5v6L8 14.2 2.6 11V5L8 1.8z"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      );
    case "cursor":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" className={className}>
          <path d="M3 2l10 5.5-4.4 1.4L7.2 13 3 2z" />
        </svg>
      );
    case "flame":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" className={className}>
          <path d="M8 1.5c.4 1.6.2 2.7-.6 3.5-1.6 1.6-3 3-3 5.5a3.6 3.6 0 0 0 7.2 0c0-1.4-.7-2.5-1.5-3.3.3 1.4-.5 2-1.1 1.4-.7-.7.5-2.6-1-7.1z" />
        </svg>
      );
    case "bolt":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" className={className}>
          <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" />
        </svg>
      );
    case "flask":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M6 1.5h4M6.5 2v4L3 13a1.5 1.5 0 0 0 1.3 2.2h7.4A1.5 1.5 0 0 0 13 13L9.5 6V2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "anchor":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" className={className}>
          <circle cx="8" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8 5v9M5 8h6M3 11.5c1.5 2 3 2.5 5 2.5s3.5-.5 5-2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case "book":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M2 3a1 1 0 0 1 1-1h3a3 3 0 0 1 2 .8A3 3 0 0 1 10 2h3a1 1 0 0 1 1 1v9.5a.5.5 0 0 1-.7.5A4.7 4.7 0 0 0 11 12.5c-1 0-2 .3-2.7.9a.5.5 0 0 1-.6 0A4.4 4.4 0 0 0 5 12.5c-1 0-2 .3-2.3.5A.5.5 0 0 1 2 12.5V3z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path d="M8 4v9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "star":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" className={className}>
          <path d="M8 1.5l2 4.4 4.7.5-3.5 3.2 1 4.6L8 12l-4.2 2.2 1-4.6L1.3 6.4l4.7-.5L8 1.5z" />
        </svg>
      );
    case "leaf":
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" className={className}>
          <path d="M14 2c-7 0-12 4-12 9 0 1 .2 2 .6 3l1-1c1-1 2.5-1.6 4.4-2C10.5 10.5 13 8 14 2zM3 14c2-3 4.5-5 7.5-6" stroke="currentColor" strokeWidth="0.8" />
        </svg>
      );
    case "default":
    default:
      return null;
  }
}

// The Aura brand mark — the binary-box icon: a rounded box holding two
// eyes, a "1" and a "0".
//
// This is the single source of truth for the logo glyph: the topbar
// brand, the native Aura agent avatar, and the #aura home-channel icon
// all render this one component so the mark stays identical everywhere
// and a future logo change is a one-file edit.
//
// The source artwork is two-tone (black box, white eyes). Here it is
// rendered monochrome: the box paints in `currentColor` and the two
// eyes are punched to real holes (a mask), so the mark tints with
// whatever `color` the caller sets and reads on any surface — the
// topbar passes the brand foreground, the agent tile the Aura brand fg,
// the home channel the accent. The "1" numeral and the "0" ring are
// then drawn back in `currentColor` inside those holes.
//
// Source viewBox is 104×79 (wider than tall); it is centered inside a
// square viewBox here so `size` stays a square footprint and every
// existing call site keeps its layout.
//
// `animated` brings over the brand kit's own motion
// (auravcs-icon-animated.svg): the outline draws itself, the body lands,
// the two bits pop in, and the mark then floats and blinks forever. The
// kit ships that as an inline <style> keyed off element ids — inlined
// into an HTML document those rules are global and the ids stop being
// unique the moment two marks are on screen, so the timing lives in
// styles.css under `.aura-mark-anim` and the elements carry classes.
// Each eye is a pair of nested groups (blink outside, pop inside) and
// the same pair wraps its mask ellipse, so the hole closes with the
// numeral instead of the numeral squashing inside a staring hole.

import { useId } from "react";

type Props = {
  /** Square edge in px. The mark is centered within it. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Decorative by default; pass a label to expose it to a11y. */
  title?: string;
  /** Play the brand kit's build-in, then float and blink. Off everywhere
   *  the mark is furniture (topbar, avatars, channel icons) — a logo that
   *  never stops moving in a 13px slot is noise, not identity. */
  animated?: boolean;
};

// Exact geometry from the auravcs logo kit (auravcs-icon.svg), inner
// coordinates (the artwork's own translate(1 1) group).
const BODY =
  "M9 10 C4 11 0 15 0 20 L0 54 C0 56 1 57 3 58 L38 75 C41 76.2 45 76 48 74 C58 71 77 65 89 61 C95 59 100 55 102 47 L102 24 C102 21 101 18 97 16 C84 12 68 6 52 1 C49 .1 46 -.2 43 0 L9 10 Z";
const DIGIT_ONE = "M47.4 45 L51.7 40.4 H54.6 V57.8 H50.1 V46.2 L47.4 48.2 Z";

export function AuraMark({
  size = 16,
  className,
  style,
  title,
  animated = false,
}: Props) {
  const maskId = useId();
  const anim = animated ? "aura-mark-anim " : "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -13 104 104"
      fill="none"
      className={`${anim}${className ?? ""}`.trim() || undefined}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <mask id={maskId}>
        <rect x="-4" y="-4" width="112" height="88" fill="#fff" />
        {/* the two eyes, punched out of the box */}
        <g className="am-blink am-one">
          <g className="am-pop am-pop-one">
            <ellipse
              cx="50.583"
              cy="48.377"
              rx="13.12"
              ry="18.196"
              transform="rotate(13.932 50.583 48.377)"
              fill="#000"
            />
          </g>
        </g>
        <g className="am-blink am-zero">
          <g className="am-pop am-pop-zero">
            <ellipse
              cx="86.319"
              cy="37.873"
              rx="11.604"
              ry="16.508"
              transform="rotate(9.405 86.319 37.873)"
              fill="#000"
            />
          </g>
        </g>
      </mask>
      <g transform="translate(1 1)">
        <g className="am-idle">
          {animated && (
            // Drawn on first, then faded out under the solid body — the
            // kit's "line build". Only mounted when it will animate; a
            // static outline sitting under the body is dead weight.
            <path
              className="am-outline"
              d={BODY}
              pathLength={1}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.35"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          <g className="am-body" mask={`url(#${maskId})`}>
            <path d={BODY} fill="currentColor" />
          </g>
          {/* the "1" */}
          <g className="am-blink am-one">
            <g className="am-pop am-pop-one">
              <path d={DIGIT_ONE} fill="currentColor" />
            </g>
          </g>
          {/* the "0" — a ring, so the hole reads as a zero */}
          <g className="am-blink am-zero">
            <g className="am-pop am-pop-zero">
              <ellipse
                cx="86.4"
                cy="37.86"
                rx="7.1"
                ry="10.4"
                transform="rotate(9.405 86.4 37.86)"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.6"
              />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

// The Aura brand mark — a six-petal blossom around a center seed.
//
// This is the single source of truth for the logo glyph: the topbar
// brand, the native Aura agent avatar, and the #aura home-channel icon
// all render this one component so the mark stays identical everywhere
// and a future logo change is a one-file edit.
//
// Every shape uses `currentColor`, so the mark tints with whatever
// `color` the caller sets (the topbar passes the brand foreground, the
// agent tile passes the Aura brand fg, the home channel passes the
// accent). Source artwork: 879×874 viewBox, kept verbatim.

type Props = {
  /** Square edge in px. The viewBox scales to fit. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Decorative by default; pass a label to expose it to a11y. */
  title?: string;
};

export function AuraMark({ size = 16, className, style, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 879 874"
      fill="none"
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M319 148C302.145 252.5 393 333.5 440.5 371C466.5 292.2 524.333 240.667 550 227C556.667 209.833 564.6 164.6 555 117C545.4 69.4 475.667 20.8333 440.5 0C414.5 11 335 48.8 319 148Z"
        fill="currentColor"
      />
      <path
        d="M557.452 726C574.307 621.5 483.452 540.5 435.952 503C409.952 581.8 352.118 633.333 326.452 647C319.785 664.167 311.852 709.4 321.452 757C331.052 804.6 400.785 853.167 435.952 874C461.952 863 541.452 825.2 557.452 726Z"
        fill="currentColor"
      />
      <path
        d="M232.071 690.276C333.252 659.183 365.37 539.686 378 480.5C325 480.5 244.5 471.5 201 453.5C182.655 455.112 147.448 470.341 109 500C58.5 538.956 61.635 615.746 58.5 656.5C79.8633 674.956 141 718.262 232.071 690.276Z"
        fill="currentColor"
      />
      <path
        d="M649.486 194.045C548.305 225.138 516.187 344.635 503.557 403.821C556.557 403.821 637.057 412.821 680.557 430.821C698.902 429.21 734.109 413.98 772.557 384.321C823.057 345.365 819.922 268.575 823.057 227.821C801.694 209.366 740.557 166.059 649.486 194.045Z"
        fill="currentColor"
      />
      <path
        d="M745.997 477.928C696 438.5 555.438 451.489 501 477.928C553.5 538 571.369 615.444 572.5 644.5C585.053 657.975 629.466 688.832 676.498 700.91C723.53 712.989 786.936 680.591 821 658C822.415 629.804 820.904 537 745.997 477.928Z"
        fill="currentColor"
      />
      <path
        d="M132.099 405.373C182.095 444.801 322.657 431.812 377.095 405.374C324.595 345.301 306.726 267.858 305.595 238.801C293.043 225.326 248.629 194.469 201.597 182.391C154.565 170.312 91.1597 202.71 57.0953 225.301C55.6801 253.497 57.1912 346.301 132.099 405.373Z"
        fill="currentColor"
      />
      <circle cx="438" cy="436" r="52" fill="currentColor" />
    </svg>
  );
}

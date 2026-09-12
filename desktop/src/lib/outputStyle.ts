// The answer style the next turn asks for — today, "Concise" or nothing.
//
// Claude Code has an `--output-style` flag; this is the one composer-side
// setting that reaches it. It is deliberately not threaded through the
// eight-argument send path the composer already carries: the chip writes it
// here, and the chat view reads it back at send time and puts it on the turn
// context, the same way the effort chip's value rides the request. Other
// brains ignore it — the chip's tooltip says so.

export type OutputStyle = "default" | "concise";

export const OUTPUT_STYLE_KEY = "aura.manager.output_style";

/** Storage → typed. Anything unrecognised is the default, so a stale value
 *  from a future build can't make the chip lie. */
export function parseOutputStyle(raw: string | null | undefined): OutputStyle {
  return raw === "concise" ? "concise" : "default";
}

export function toggleOutputStyle(current: OutputStyle): OutputStyle {
  return current === "concise" ? "default" : "concise";
}

/** The value to hand the CLI, or null when nothing should be added — the
 *  request stays byte-identical to a build without the chip. */
export function outputStyleArg(style: OutputStyle): string | null {
  return style === "concise" ? "concise" : null;
}

export function readOutputStyle(): OutputStyle {
  try {
    return parseOutputStyle(localStorage.getItem(OUTPUT_STYLE_KEY));
  } catch {
    return "default";
  }
}

/** Persist the choice; the default clears the key so an untouched profile
 *  stays empty. */
export function writeOutputStyle(style: OutputStyle): void {
  try {
    if (style === "default") localStorage.removeItem(OUTPUT_STYLE_KEY);
    else localStorage.setItem(OUTPUT_STYLE_KEY, style);
  } catch {
    /* storage disabled */
  }
}

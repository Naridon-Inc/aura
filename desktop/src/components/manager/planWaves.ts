// Reads the wave plan `aura plan` writes to `.aura/plans/ACTIVE_MILESTONE.xml`
// into steps the multi-step launcher can stage: each wave's action, how to
// check it, and the files it names (claimed as zones before it starts).

export type ParsedWave = {
  action: string;
  verify: string;
  zones: string[];
};

// `aura plan` emits each wave as `<wave> <action>…</action> <verify>…
// </verify> [<file>…</file>]* </wave>`. We walk it line by line like the
// CLI's own runner (gsd::execute_wave), but a wave ends at `</wave>` or at
// the next <action>, not at its <verify>: the <file> tags come after the
// verify line, and closing the wave there handed each wave's files to the
// one after it. Tolerant to whitespace + reordering within a wave block.
export function parseWaves(xml: string): ParsedWave[] {
  const out: ParsedWave[] = [];
  let action = "";
  let verify = "";
  let zones: string[] = [];
  const flush = () => {
    if (action) {
      out.push({ action: decode(action), verify: decode(verify), zones });
    }
    action = "";
    verify = "";
    zones = [];
  };
  // Strip CDATA wrappers and HTML entities while keeping the inner text.
  for (const raw of xml.split(/\r?\n/)) {
    const line = raw.trim();
    // A line may carry several tags (a one-line wave), so each is read.
    const a = matchTag(line, "action");
    if (a !== null) {
      // A second action means the previous wave had no closing tag.
      if (action) flush();
      action = a;
    }
    const v = matchTag(line, "verify");
    if (v !== null) verify = v;
    const f = matchTag(line, "file") ?? matchTag(line, "path");
    if (f) zones.push(f);
    if (line.includes("</wave>")) flush();
  }
  if (action) flush();
  return out;
}

function matchTag(line: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = line.indexOf(open);
  if (i < 0) return null;
  const j = line.indexOf(close, i + open.length);
  if (j < 0) return null;
  return line.slice(i + open.length, j).trim();
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

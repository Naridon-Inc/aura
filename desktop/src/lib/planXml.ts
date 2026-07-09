// Parser for `.aura/plans/ACTIVE_MILESTONE.xml` — the wave/task DAG
// `aura plan` writes after the discovery pass. The CLI's own runner
// (gsd::execute_wave) reads the same shape; we just render it.
//
// Two formats appear in the wild:
//   - Rich:   <milestone><plan><wave id="..."><task id="..."> ...children
//             <description>, <owner>, <priority>, <dependencies>, <tags>
//   - Legacy: flat sequence of <wave><action>...</action><verify>...</verify>
//             <file>...</file></wave> — the old aura-cli emit shape.
//
// We try the rich format first (DOMParser), fall back to the legacy
// line-walk if the document doesn't have any <task> children. Both
// shapes converge on the same `ParsedPlan` so the UI doesn't branch.

export type ParsedTask = {
  id: string;
  name: string;
  description: string;
  owner: string;
  priority: string;
  dependencies: string[];
  tags: string[];
};

export type ParsedWave = {
  id: string;
  name: string;
  tasks: ParsedTask[];
};

export type ParsedPlan = {
  waves: ParsedWave[];
};

export function parsePlanXml(xml: string): ParsedPlan {
  const trimmed = xml.trim();
  if (!trimmed) return { waves: [] };
  const rich = parseRich(trimmed);
  if (rich.waves.some((w) => w.tasks.length > 0)) return rich;
  return parseLegacy(trimmed);
}

function parseRich(xml: string): ParsedPlan {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return { waves: [] };
  }
  // DOMParser surfaces XML errors as a <parsererror> child of the root.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return { waves: [] };
  }
  const waves: ParsedWave[] = [];
  const waveNodes = doc.getElementsByTagName("wave");
  for (let i = 0; i < waveNodes.length; i++) {
    const w = waveNodes[i];
    const id = w.getAttribute("id") ?? `wave-${i + 1}`;
    const name = w.getAttribute("name") ?? "";
    const tasks: ParsedTask[] = [];
    const taskNodes = w.getElementsByTagName("task");
    for (let j = 0; j < taskNodes.length; j++) {
      const t = taskNodes[j];
      // Guard against tasks that belong to a *nested* wave — only count
      // direct children. getElementsByTagName is recursive.
      if (t.parentElement !== w) continue;
      tasks.push({
        id: t.getAttribute("id") ?? `task-${i + 1}.${j + 1}`,
        name: t.getAttribute("name") ?? "",
        description: textOf(t, "description"),
        owner: textOf(t, "owner"),
        priority: textOf(t, "priority"),
        dependencies: childrenText(t, "dependencies", "dependency"),
        tags: childrenText(t, "tags", "tag"),
      });
    }
    waves.push({ id, name, tasks });
  }
  return { waves };
}

function textOf(el: Element, tag: string): string {
  const node = el.getElementsByTagName(tag)[0];
  if (!node || node.parentElement !== el) return "";
  return (node.textContent ?? "").trim();
}

function childrenText(el: Element, container: string, leaf: string): string[] {
  const root = el.getElementsByTagName(container)[0];
  if (!root || root.parentElement !== el) return [];
  const out: string[] = [];
  const nodes = root.getElementsByTagName(leaf);
  for (let i = 0; i < nodes.length; i++) {
    const txt = (nodes[i].textContent ?? "").trim();
    if (txt) out.push(txt);
  }
  return out;
}

// Legacy shape: pair <action>+<verify> per wave, treat each pair as one
// synthetic task. Same line-walk as ManagerLauncher.parseWaves so older
// plans still render in the panel.
function parseLegacy(xml: string): ParsedPlan {
  const waves: ParsedWave[] = [];
  let action = "";
  let verify = "";
  let zones: string[] = [];
  let waveIdx = 0;
  const flush = () => {
    if (!action) return;
    waveIdx += 1;
    waves.push({
      id: `wave-${waveIdx}`,
      name: action.length > 60 ? action.slice(0, 60) + "…" : action,
      tasks: [
        {
          id: `task-${waveIdx}.1`,
          name: action,
          description: verify ? `Verify: ${verify}` : "",
          owner: "",
          priority: "",
          dependencies: waveIdx === 1 ? [] : [`wave-${waveIdx - 1}`],
          tags: zones.slice(),
        },
      ],
    });
    action = "";
    verify = "";
    zones = [];
  };
  for (const raw of xml.split(/\r?\n/)) {
    const line = raw.trim();
    const a = matchTag(line, "action");
    if (a !== null) {
      if (action && verify) flush();
      action = decode(a);
      continue;
    }
    const v = matchTag(line, "verify");
    if (v !== null) {
      verify = decode(v);
      if (action) flush();
      continue;
    }
    const f = matchTag(line, "file") ?? matchTag(line, "path");
    if (f) zones.push(f);
  }
  if (action) flush();
  return { waves };
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

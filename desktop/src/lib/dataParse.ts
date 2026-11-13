// dataParse — read a settings or data file into plain values, leniently.
//
// The change story compares two versions of a JSON, TOML or YAML file as data
// (see dataDiff). The shell ships no TOML or YAML parser, and pulling one in
// for a read-only comparison is a lot of weight, so this reads the subset real
// settings files are written in: tables and arrays of tables, block mappings
// and lists, quoted and bare scalars, inline lists. Anything outside that
// subset makes the parse give up (`undefined`) rather than guess — the caller
// then simply doesn't offer a structural reading for that file.

export type DataFormat = "json" | "toml" | "yaml";

/** Which reader a file needs, from its name. `null` for anything that isn't a
 *  data file — code goes through the syntax-tree pieces instead. */
export function dataFormatOf(path: string): DataFormat | null {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (/\.(json|jsonc|json5)$/.test(base)) return "json";
  if (base === ".babelrc" || base === ".eslintrc" || base === ".prettierrc") return "json";
  if (/\.toml$/.test(base)) return "toml";
  if (/\.ya?ml$/.test(base)) return "yaml";
  return null;
}

/** Parse `text` in `format`. An empty file reads as an empty object, so a file
 *  that did not exist before reads as "everything was added". */
export function parseData(text: string, format: DataFormat): unknown {
  if (!text.trim()) return {};
  try {
    switch (format) {
      case "json":
        return parseJsonLoose(text);
      case "toml":
        return parseToml(text);
      case "yaml":
        return parseYaml(text);
    }
  } catch {
    return undefined;
  }
}

// ── JSON, with the comments and trailing commas editors allow ─────────────

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonExtras(text));
  }
}

/** Drop `//` and block comments and trailing commas, leaving strings alone. */
function stripJsonExtras(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// ── Scalars shared by TOML and YAML ───────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Cut a trailing `# comment` that sits outside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split an inline list body on top-level commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function unquote(raw: string): string | null {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

function scalar(raw: string, yaml: boolean): unknown {
  const v = raw.trim();
  const q = unquote(v);
  if (q !== null) return q;
  if (v.startsWith("[") && v.endsWith("]")) {
    return splitTopLevel(v.slice(1, -1)).map((p) => scalar(p, yaml));
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const out: Obj = {};
    for (const part of splitTopLevel(v.slice(1, -1))) {
      const m = part.match(yaml ? /^([^:]+):\s*(.*)$/ : /^([^=]+)=\s*(.*)$/);
      if (!m) throw new Error("inline table");
      out[keyText(m[1])] = scalar(m[2], yaml);
    }
    return out;
  }
  if (v === "true" || (yaml && /^(yes|on)$/i.test(v))) return true;
  if (v === "false" || (yaml && /^(no|off)$/i.test(v))) return false;
  if (yaml && (v === "" || v === "~" || v === "null")) return null;
  // Anchors, aliases and tags change what a value means; reading them as text
  // would describe the file wrongly, so they are outside the subset.
  if (yaml && /^[&*!]/.test(v)) throw new Error("yaml anchor, alias or tag");
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v.replace(/^\+/, ""));
  if (!yaml && !/^\d{4}-\d{2}-\d{2}/.test(v)) throw new Error(`bare value: ${v}`);
  return v;
}

function keyText(raw: string): string {
  const k = raw.trim();
  return unquote(k) ?? k;
}

// ── TOML ──────────────────────────────────────────────────────────────────

function parseToml(text: string): Obj {
  const root: Obj = {};
  let table: Obj = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const aot = line.match(/^\[\[\s*(.+?)\s*\]\]$/);
    const tbl = !aot && line.match(/^\[\s*(.+?)\s*\]$/);
    if (aot) {
      const path = splitDotted(aot[1]);
      const parent = walk(root, path.slice(0, -1));
      const last = path[path.length - 1];
      const list = Array.isArray(parent[last]) ? (parent[last] as unknown[]) : [];
      parent[last] = list;
      table = {};
      list.push(table);
      continue;
    }
    if (tbl) {
      table = walk(root, splitDotted(tbl[1]));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error("toml line");
    const path = splitDotted(line.slice(0, eq));
    const value = line.slice(eq + 1).trim();
    // Multi-line strings and arrays are outside the subset this reads.
    if (/^("""|''')/.test(value) || (value.startsWith("[") && !value.endsWith("]"))) {
      throw new Error("multi-line toml value");
    }
    walk(table, path.slice(0, -1))[path[path.length - 1]] = scalar(value, false);
  }
  return root;
}

function splitDotted(raw: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let cur = "";
  for (const c of raw) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ".") {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

function walk(from: Obj, path: string[]): Obj {
  let at = from;
  for (const k of path) {
    let next = at[k];
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!isObj(next)) {
      next = {};
      at[k] = next;
    }
    at = next as Obj;
  }
  return at;
}

// ── YAML (block style) ────────────────────────────────────────────────────

type YLine = { indent: number; text: string };

function parseYaml(text: string): unknown {
  const lines: YLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) {
      if (lines.length) break; // one document is enough to compare
      continue;
    }
    const stripped = stripComment(raw);
    if (!stripped.trim()) continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  if (!lines.length) return {};
  const [value] = readBlock(lines, 0, lines[0].indent);
  return value;
}

/** Read the block that starts at `i` with indentation `indent`. Returns the
 *  value and the index of the first line after it. */
function readBlock(lines: YLine[], i: number, indent: number): [unknown, number] {
  if (lines[i].text.startsWith("- ") || lines[i].text === "-") return readList(lines, i, indent);
  return readMap(lines, i, indent);
}

function readList(lines: YLine[], i: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  while (i < lines.length && lines[i].indent === indent && /^-( |$)/.test(lines[i].text)) {
    const rest = lines[i].text.slice(1).trim();
    if (!rest) {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [v, next] = readBlock(lines, i + 1, lines[i + 1].indent);
        out.push(v);
        i = next;
      } else {
        out.push(null);
        i++;
      }
      continue;
    }
    if (isMapEntry(rest)) {
      // `- key: value` opens a mapping whose other keys sit under the dash.
      const childIndent = indent + 2;
      const synthetic: YLine[] = [{ indent: childIndent, text: rest }];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= childIndent) synthetic.push(lines[j++]);
      const [v] = readMap(synthetic, 0, childIndent);
      out.push(v);
      i = j;
      continue;
    }
    out.push(scalar(rest, true));
    i++;
  }
  return [out, i];
}

function isMapEntry(text: string): boolean {
  return /^("[^"]*"|'[^']*'|[^\s"'#][^:]*?):(\s|$)/.test(text);
}

function readMap(lines: YLine[], i: number, indent: number): [Obj, number] {
  const out: Obj = {};
  while (i < lines.length && lines[i].indent === indent) {
    const m = lines[i].text.match(/^("[^"]*"|'[^']*'|[^\s"'#][^:]*?):(?:\s+(.*))?$/);
    if (!m) throw new Error("yaml line");
    const key = keyText(m[1]);
    if (key === "<<") throw new Error("yaml merge key");
    const rest = (m[2] ?? "").trim();
    i++;
    if (rest === "|" || rest === ">" || /^[|>][+-]?$/.test(rest)) {
      // A block string: keep its lines, joined the way the indicator says.
      const parts: string[] = [];
      while (i < lines.length && lines[i].indent > indent) parts.push(lines[i++].text);
      out[key] = parts.join(rest.startsWith("|") ? "\n" : " ");
    } else if (rest) {
      out[key] = scalar(rest, true);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [v, next] = readBlock(lines, i, lines[i].indent);
      out[key] = v;
      i = next;
    } else if (i < lines.length && lines[i].indent === indent && /^-( |$)/.test(lines[i].text)) {
      // A list written flush with its key.
      const [v, next] = readList(lines, i, indent);
      out[key] = v;
      i = next;
    } else {
      out[key] = null;
    }
  }
  if (i < lines.length && lines[i].indent > indent) throw new Error("yaml indent");
  return [out, i];
}

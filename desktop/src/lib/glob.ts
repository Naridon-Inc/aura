// Minimal glob matcher for aura zone patterns. Supports `*` (one
// segment, no `/`), `**` (recursive across segments), and `?` (one
// char). Aura zone rules are simple — no brace expansion, no negation,
// no character classes — so a regex translation in ~30 lines beats
// pulling picomatch (~700 KB) into the bundle.
//
// Patterns are matched against repo-relative paths (no leading `/`).
// The matcher normalizes both sides with `stripLeadingSlash`.

function stripLeadingSlash(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

function patternToRegex(pattern: string): RegExp {
  // Order matters: `**` must be turned into a placeholder before `*`
  // so the single-star translation doesn't eat it.
  const RE_SPECIAL = /[.+^${}()|[\]\\]/g;
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // `**` → match anything including `/`. Eat an optional trailing
      // `/` so `src/**` matches `src/foo` AND `src` itself.
      out += "(?:.*?)";
      i += 2;
      if (pattern[i] === "/") i += 1;
    } else if (c === "*") {
      // `*` → match anything except `/` (one segment).
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += c.replace(RE_SPECIAL, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return patternToRegex(stripLeadingSlash(pattern)).test(stripLeadingSlash(path));
}

export function matchesAnyGlob(patterns: string[], path: string): boolean {
  return patterns.some((p) => matchesGlob(p, path));
}

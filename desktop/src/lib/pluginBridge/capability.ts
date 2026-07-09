// Mirror of `plugin_host::capability` (Rust) on the host TS side.
//
// Why the duplication: the bridge ACL-checks every plugin call *before*
// dispatching it to a host handler, and that hot path runs in the
// renderer process. We don't want to round-trip through Tauri for every
// `aura.intent.read` call from an iframe — so we ship the registry's
// capability snapshot down to the renderer at boot, and parse +
// glob-match here. The Rust side stays authoritative for what the
// shell scanned; this side is authoritative for "may the running
// plugin call X right now?".
//
// Keep the parse + glob behavior identical to capability.rs — the
// Rust unit tests are the spec; the matching test file in this module
// mirrors them line-for-line.

export type Capability = {
  family: string;
  verb: string;
  /** Optional glob scope; `undefined` means "unconstrained verb". */
  scope?: string;
};

export type CapabilityError =
  | { kind: "empty" }
  | { kind: "malformed"; raw: string };

/** Parse `family:verb[:scope...]` exactly like `capability.rs::parse`. */
export function parseCapability(raw: string): Capability | CapabilityError {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  const firstColon = trimmed.indexOf(":");
  if (firstColon <= 0) return { kind: "malformed", raw: trimmed };
  const family = trimmed.slice(0, firstColon).trim();
  const after = trimmed.slice(firstColon + 1);
  const secondColon = after.indexOf(":");
  let verb: string;
  let scope: string | undefined;
  if (secondColon < 0) {
    verb = after.trim();
  } else {
    verb = after.slice(0, secondColon).trim();
    const rest = after.slice(secondColon + 1).trim();
    scope = rest.length > 0 ? rest : undefined;
  }
  if (family.length === 0 || verb.length === 0) {
    return { kind: "malformed", raw: trimmed };
  }
  return { family, verb, scope };
}

/** Plugin's full capability set, used by the bridge to ACL-check
 *  inbound calls. Construct once at plugin start from the registry's
 *  declared capability strings. */
export class CapabilitySet {
  private readonly caps: Capability[] = [];

  static fromManifestStrings(
    raws: readonly string[],
  ): CapabilitySet | { error: CapabilityError; index: number } {
    const set = new CapabilitySet();
    for (let i = 0; i < raws.length; i++) {
      const parsed = parseCapability(raws[i]!);
      if ("kind" in parsed) {
        return { error: parsed, index: i };
      }
      set.caps.push(parsed);
    }
    return set;
  }

  /** True iff any declared capability covers (family, verb, target). */
  allows(family: string, verb: string, target?: string): boolean {
    for (const cap of this.caps) {
      if (cap.family !== family || cap.verb !== verb) continue;
      if (cap.scope === undefined) {
        // Unscoped capability — any target (or none) is accepted.
        return true;
      }
      if (target === undefined) {
        // Caller refused to declare a scope; we won't assume it
        // matches. Deny.
        continue;
      }
      if (globMatch(cap.scope, target)) return true;
    }
    return false;
  }

  /** Read-only iteration — for the "this plugin has these powers" UI. */
  entries(): readonly Capability[] {
    return this.caps;
  }
}

/** fnmatch-style match: `*` matches zero+ characters, `?` matches
 *  exactly one. Mirrors `capability.rs::glob_match` (iterative two-
 *  pointer + backtracking on `*`). */
export function globMatch(pattern: string, target: string): boolean {
  const p = pattern;
  const t = target;
  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = 0;
  while (ti < t.length) {
    const pc = pi < p.length ? p[pi] : undefined;
    if (pc !== undefined && (pc === "?" || pc === t[ti])) {
      pi++;
      ti++;
    } else if (pc === "*") {
      starPi = pi;
      starTi = ti;
      pi++;
    } else if (starPi >= 0) {
      pi = starPi + 1;
      starTi++;
      ti = starTi;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") {
    pi++;
  }
  return pi === p.length;
}

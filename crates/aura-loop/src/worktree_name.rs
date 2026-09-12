// Naming a worktree after the work it is for.
//
// Every surface that opens an isolated copy of the repo — `aura work`, the
// crew loop runner, the desktop's agent lanes, the Manager's per-task
// fan-out — used to name it out of a pool of memorable places (`granada`,
// `auckland`, `zagreb`) or out of an opaque id (`3f2504e0-4f89-41d3…`).
// Both read as noise: a row of worktrees named after cities tells you
// nothing about which one holds the login fix.
//
// The rule this module encodes: a worktree is named after the work. The
// caller hands over whatever it already knows the work is — a task title,
// the objective the user typed, the branch it forks from — and gets back a
// filesystem- and git-ref-safe slug of it. Only when the caller genuinely
// has no label does it fall back to a generated name, which stays each
// caller's own business (the CLI keeps its place-name pool).
//
// Everything here is PURE: no filesystem, no git, no clock, no rng. The
// caller owns "is this name already taken", which is why [`unique`] takes
// that question as a closure.

/// Longest slug this module will produce. Long enough for a real sentence
/// fragment ("switch-retry-to-exponential-backoff"), short enough that the
/// sibling directory name it lands in stays readable in a `ls` and well
/// clear of any path-length limit.
pub const MAX_SLUG_LEN: usize = 40;

/// A slug shorter than this is never cut at a word boundary — better a
/// mid-word cut than a name so short it stops identifying the work.
const MIN_BOUNDARY_LEN: usize = 20;

/// Namespaces stripped off the front of a label before it is slugified, so
/// `feat/worktree-control-plane` names a worktree `worktree-control-plane`
/// rather than `feat-worktree-control-plane` — the branch-flow prefix says
/// what KIND of change it is, never what the change is about, so it is pure
/// noise in a name whose whole job is to tell copies apart.
///
/// Stripping repeats while anything matches, so a fully-qualified
/// `refs/heads/feat/login` reduces to `login`.
const REF_PREFIXES: &[&str] = &[
    // fully-qualified refs and remotes
    "refs/heads/",
    "refs/remotes/",
    "origin/",
    "upstream/",
    // conventional branch flows
    "feature/",
    "feat/",
    "fix/",
    "bugfix/",
    "hotfix/",
    "chore/",
    "refactor/",
    "docs/",
    "doc/",
    "test/",
    "tests/",
    "perf/",
    "build/",
    "ci/",
    "style/",
    "revert/",
    "release/",
    "wip/",
    "spike/",
    "experiment/",
    "exp/",
    "bug/",
    "task/",
    "story/",
    "epic/",
    // Aura's own worktree namespaces, so a name round-trips through
    // `work/<slug>` → `<slug>` instead of growing a `work-` head.
    "work/",
    "loop/",
    "lane/",
    "aura/",
];

/// Conventional-commit types, stripped when the label opens with
/// `<type>: ` or `<type>(<scope>): ` — a task titled "fix(auth): reject
/// expired tokens" is about rejecting expired tokens.
const COMMIT_TYPES: &[&str] = &[
    "feat", "fix", "chore", "docs", "style", "refactor", "perf", "test", "build", "ci", "revert",
];

/// Drop every leading namespace and conventional-commit type from `raw`,
/// returning the part that actually describes the work. Returns `raw`
/// untouched when nothing matches, and never returns an empty string when
/// `raw` was non-empty — a label that is ONLY a prefix (`feat/`) keeps its
/// last non-empty segment rather than vanishing.
pub fn strip_prefixes(raw: &str) -> &str {
    let mut rest = raw.trim();
    loop {
        let before = rest;
        for p in REF_PREFIXES {
            if let Some(stripped) = strip_prefix_ci(rest, p) {
                // A prefix that consumes the whole label is not a prefix,
                // it IS the label — keep it rather than returning nothing.
                if !stripped.trim().is_empty() {
                    rest = stripped.trim_start();
                    break;
                }
            }
        }
        if let Some(stripped) = strip_commit_type(rest) {
            if !stripped.trim().is_empty() {
                rest = stripped.trim_start();
            }
        }
        if rest == before {
            return rest;
        }
    }
}

/// `s` without `prefix`, matched case-insensitively (branch names are
/// routinely typed `Feat/…`). `None` when it doesn't match.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    // `is_char_boundary` first: a label can open with a multi-byte character,
    // and slicing through one panics.
    if s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
    {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// `s` without a leading `<type>: ` / `<type>(<scope>): ` conventional-commit
/// head. `None` when `s` doesn't open with one.
fn strip_commit_type(s: &str) -> Option<&str> {
    let colon = s.find(':')?;
    let head = &s[..colon];
    // The scope, when present, is the parenthesised tail of the head.
    let ty = match head.find('(') {
        Some(open) if head.ends_with(')') => &head[..open],
        Some(_) => return None,
        None => head,
    };
    let ty = ty.trim();
    if ty.is_empty() || !COMMIT_TYPES.iter().any(|t| ty.eq_ignore_ascii_case(t)) {
        return None;
    }
    Some(&s[colon + 1..])
}

/// Lowercase, `[a-z0-9-]`-only, repeats collapsed, ends trimmed, capped at
/// [`MAX_SLUG_LEN`]. Non-ASCII characters are separators, not silently
/// transliterated — `café-99` is `caf-99`, which is honest about what
/// survived rather than inventing letters nobody typed.
///
/// Returns an EMPTY string when nothing usable survives (`""`, `"★★★"`).
/// Callers decide what an unusable label means to them; this function does
/// not invent a name.
pub fn slugify(raw: &str) -> String {
    let mut slug = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    cap(trimmed)
}

/// Cut `slug` down to [`MAX_SLUG_LEN`], preferring the last word boundary
/// inside the limit so a name reads as words rather than a severed one —
/// but only while that leaves something still identifying (see
/// [`MIN_BOUNDARY_LEN`]).
fn cap(slug: &str) -> String {
    if slug.len() <= MAX_SLUG_LEN {
        return slug.to_string();
    }
    let head = &slug[..MAX_SLUG_LEN];
    let cut = match head.rfind('-') {
        Some(i) if i >= MIN_BOUNDARY_LEN => i,
        _ => MAX_SLUG_LEN,
    };
    slug[..cut].trim_matches('-').to_string()
}

/// The slug for a label the caller believes describes the work: prefixes
/// stripped, then slugified. `None` when nothing usable survives, which is
/// the caller's signal to fall back to a generated name.
pub fn from_label(label: &str) -> Option<String> {
    let slug = slugify(strip_prefixes(label));
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

/// The first of `labels` that yields a usable slug. Lets a caller state its
/// naming precedence — "the name the user typed, else the branch we fork
/// from" — as one list.
pub fn from_labels<'a>(labels: impl IntoIterator<Item = &'a str>) -> Option<String> {
    labels.into_iter().find_map(from_label)
}

/// Highest `-N` suffix [`unique`] will try before giving the caller the last
/// candidate anyway. A repo with a thousand worktrees of the same name has a
/// bigger problem than its naming, and git's own "already exists" error is a
/// better place to learn about it than a loop that never returns.
const MAX_SUFFIX: usize = 1000;

/// `base` if it is free, else `base-2`, `base-3`, … until `taken` says no.
/// The suffix is added INSIDE [`MAX_SLUG_LEN`] (the base is shortened to make
/// room), so a name near the cap can still be disambiguated.
///
/// `taken` answers "does something with this name already exist" — a
/// directory, a branch, or both; only the caller knows which of those matter.
pub fn unique(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    for n in 2..=MAX_SUFFIX {
        let suffix = format!("-{n}");
        let room = MAX_SLUG_LEN.saturating_sub(suffix.len());
        // `base` is a slug in every caller, but this is a public entry point —
        // back off to a char boundary rather than panic on a stray multi-byte.
        let head = if base.len() > room {
            let mut cut = room;
            while cut > 0 && !base.is_char_boundary(cut) {
                cut -= 1;
            }
            base[..cut].trim_end_matches('-')
        } else {
            base
        };
        let candidate = format!("{head}{suffix}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("{base}-{MAX_SUFFIX}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn slugify_kebabs_a_title() {
        assert_eq!(slugify("Fix the login bug!"), "fix-the-login-bug");
        assert_eq!(slugify("AURA-203"), "aura-203");
        assert_eq!(slugify("  --weird__name-- "), "weird-name");
    }

    #[test]
    fn slugify_empty_input_stays_empty() {
        // No invented name — the caller decides what "no label" means.
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("   "), "");
        assert_eq!(from_label(""), None);
        assert_eq!(from_label("   "), None);
    }

    #[test]
    fn slugify_unicode_keeps_only_what_survives() {
        // Pure non-ASCII yields nothing rather than a transliteration nobody
        // typed; mixed input keeps the ASCII run.
        assert_eq!(slugify("★★★"), "");
        assert_eq!(slugify("日本語"), "");
        assert_eq!(from_label("日本語 — ★★★"), None);
        assert_eq!(slugify("café-99"), "caf-99");
        assert_eq!(slugify("Añadir búsqueda"), "a-adir-b-squeda");
    }

    #[test]
    fn strips_branch_flow_prefix() {
        assert_eq!(
            from_label("feat/worktree-control-plane").as_deref(),
            Some("worktree-control-plane")
        );
        assert_eq!(from_label("fix/login").as_deref(), Some("login"));
        assert_eq!(from_label("FEAT/Login-Flow").as_deref(), Some("login-flow"));
        assert_eq!(
            from_label("refs/heads/feat/login").as_deref(),
            Some("login")
        );
        assert_eq!(from_label("origin/hotfix/rate-limit").as_deref(), Some("rate-limit"));
        // Aura's own namespaces round-trip.
        assert_eq!(from_label("work/auth-refactor").as_deref(), Some("auth-refactor"));
        assert_eq!(from_label("lane/claude-ab12ef34").as_deref(), Some("claude-ab12ef34"));
    }

    #[test]
    fn a_prefix_that_is_the_whole_label_survives() {
        // "feat" alone is a name, not a prefix — stripping it would leave
        // nothing and force a pointless fallback.
        assert_eq!(from_label("feat/").as_deref(), Some("feat"));
        assert_eq!(from_label("docs").as_deref(), Some("docs"));
        assert_eq!(from_label("work/").as_deref(), Some("work"));
    }

    #[test]
    fn strips_conventional_commit_type() {
        assert_eq!(
            from_label("fix(auth): reject expired tokens").as_deref(),
            Some("reject-expired-tokens")
        );
        assert_eq!(
            from_label("feat: add retry backoff").as_deref(),
            Some("add-retry-backoff")
        );
        // A colon that isn't a conventional-commit head is left alone.
        assert_eq!(
            from_label("Bug: the sidebar jumps").as_deref(),
            Some("bug-the-sidebar-jumps")
        );
    }

    #[test]
    fn over_long_titles_are_capped_at_a_word_boundary() {
        let long = "Switch the retry logic over to exponential backoff so we stop tripping the rate limit";
        let slug = from_label(long).unwrap();
        assert!(slug.len() <= MAX_SLUG_LEN, "{slug} is {} chars", slug.len());
        assert_eq!(slug, "switch-the-retry-logic-over-to");
        assert!(!slug.ends_with('-'));
    }

    #[test]
    fn over_long_single_word_is_cut_hard() {
        // No boundary to prefer — a hard cut beats a name too short to read.
        let slug = slugify(&"a".repeat(80));
        assert_eq!(slug.len(), MAX_SLUG_LEN);
        assert!(slug.chars().all(|c| c == 'a'));
    }

    #[test]
    fn boundary_cut_never_shortens_below_the_floor() {
        // The only dash sits before MIN_BOUNDARY_LEN, so preferring it would
        // leave a stub — the hard cut wins instead.
        let raw = format!("ab-{}", "z".repeat(60));
        let slug = slugify(&raw);
        assert_eq!(slug.len(), MAX_SLUG_LEN);
        assert!(slug.starts_with("ab-z"));
    }

    #[test]
    fn unique_suffixes_on_collision() {
        let mut used: HashSet<String> = HashSet::new();
        used.insert("login-fix".to_string());
        assert_eq!(unique("login-fix", |c| used.contains(c)), "login-fix-2");

        used.insert("login-fix-2".to_string());
        used.insert("login-fix-3".to_string());
        assert_eq!(unique("login-fix", |c| used.contains(c)), "login-fix-4");
    }

    #[test]
    fn unique_returns_the_base_when_nothing_is_taken() {
        assert_eq!(unique("login-fix", |_| false), "login-fix");
    }

    #[test]
    fn unique_keeps_the_suffix_inside_the_length_cap() {
        let base = "a".repeat(MAX_SLUG_LEN);
        let out = unique(&base, |c| c == base);
        assert!(out.len() <= MAX_SLUG_LEN, "{out} is {} chars", out.len());
        assert!(out.ends_with("-2"));
    }

    #[test]
    fn unique_gives_up_loudly_rather_than_looping_forever() {
        // A `taken` that never yields returns a candidate instead of hanging.
        let out = unique("x", |_| true);
        assert_eq!(out, format!("x-{MAX_SUFFIX}"));
    }

    #[test]
    fn from_labels_takes_the_first_usable_one() {
        assert_eq!(
            from_labels(["", "★", "feat/login-flow", "ignored"]).as_deref(),
            Some("login-flow")
        );
        assert_eq!(from_labels(["", "  ", "★★"]), None);
        assert_eq!(from_labels([]), None);
    }

    #[test]
    fn slugs_are_git_ref_and_path_safe() {
        for raw in [
            "Fix ~the~ ^login^ bug?",
            "a..b",
            "feature/@{weird}",
            "path/../escape",
            "  .lock  ",
        ] {
            let Some(slug) = from_label(raw) else { continue };
            assert!(
                slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{slug} has an unsafe char"
            );
            assert!(!slug.starts_with('-') && !slug.ends_with('-'), "{slug} has a loose end");
            assert!(!slug.contains("--"), "{slug} has a collapsed-repeat leak");
            assert!(!slug.contains(".."), "{slug} can escape its parent");
        }
    }
}

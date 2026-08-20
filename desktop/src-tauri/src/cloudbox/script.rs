//! The commands we send to a box, and the rules about what may go into them.
//!
//! Everything here is a pure function that returns a string, so the interesting
//! half — the quoting — is testable without a machine anywhere near it. That
//! matters more than usual: some of what gets interpolated came *back from the
//! box* (a directory it found, a session it is running), so a hostile or merely
//! strange filename must not be able to turn a listing into an instruction.
//!
//! Two rules, applied together rather than either alone:
//!   1. Every value is single-quoted (`quote`), which suspends every expansion
//!      the remote shell has.
//!   2. Values that name things we will later address by name — sessions,
//!      directories, branches — must also *look* like what they claim to be
//!      (`is_session_name`, `is_abs_path`, `is_branch`). Quoting alone would
//!      make a path called `; rm -rf ~` harmless but still let it be created.

use super::domain::NewSession;
use crate::manager::brain::place_toolbox::fetch_if_missing;

/// One literal argument for the remote shell.
///
/// Single quotes suspend everything bash does to a word, so the only character
/// needing care is the single quote itself: close, escape one, reopen.
///
/// The frontend keeps one small copy of this (`remoteShell.ts::shQuote`) for
/// the few lines the connect wizard types into a shell that is already open.
/// The two are pinned to each other by `quoting.cases.json` rather than by a
/// comment asking people to look — a copy that quietly stopped agreeing would
/// be a quoting bug found on somebody's box instead of in a test.
pub fn quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', r"'\''"))
}

/// One argument of a command line *this laptop* will read, quoted only when it
/// has to be.
///
/// The difference from [`quote`] is who the reader is and what they will see.
/// Everything `quote` wraps is spliced into a script a box runs unattended, so
/// belt-and-braces quoting costs nothing. This builds the line a person watches
/// being typed into their own terminal, and `'ssh' '-i' '/Users/mo/keys/box.pem'`
/// is the app hiding what it just did behind a hedge. So a word made only of
/// characters no shell acts on is left as itself, and everything else — a path
/// with a space, a whole remote command — is quoted exactly as `quote` would.
///
/// The set is deliberately small and deliberately a whitelist. `~` is not in
/// it: bare, the local shell would expand it, and this is the one layer that
/// must not rewrite what it was handed.
pub fn word(v: &str) -> String {
    let plain = |c: char| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '@' | ':' | '=' | ',' | '+')
    };
    if !v.is_empty() && v.chars().all(plain) {
        v.to_string()
    } else {
        quote(v)
    }
}

/// tmux session names are addressed by name in every later command, so they are
/// held to characters that cannot mean anything to a shell or to tmux itself
/// (`:` and `.` are tmux's own window/pane separators).
pub fn is_session_name(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A directory on the box. Absolute, because a relative path means "wherever
/// the last command happened to leave us", which is not a place.
pub fn is_abs_path(v: &str) -> bool {
    v.starts_with('/')
        && v.len() <= 4096
        && !v.contains("..")
        && !v.contains('\n')
        && !v.contains('\'')
        && !v.contains('\0')
}

/// A path *under* a home directory, for the one case where absolute is wrong.
///
/// `Place::deliver` writes into the home of whoever the work runs as, and only
/// the machine knows where that is — a box with per-member accounts has one home
/// per person. So the caller names the tail and the far side supplies the head.
/// Everything `is_abs_path` refuses is refused here for the same reasons, plus
/// a leading dash, which every tool that later touches the file would read as an
/// option.
pub fn is_home_rel_path(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 4096
        && !v.starts_with('/')
        && !v.starts_with('-')
        && !v.contains("..")
        && !v.contains('\n')
        && !v.contains('\'')
        && !v.contains('\0')
}

/// One folder name, as opposed to a path.
///
/// What someone types when asked what to call a project they are putting on a
/// box: `naridon`, not `/home/ubuntu/naridon`. A leading dot would hide it and a
/// leading dash would be read as an option by half the tools that later touch
/// it, so neither is accepted rather than escaped.
pub fn is_dir_name(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 255
        && !v.starts_with('-')
        && !v.starts_with('.')
        && !v.contains('/')
        && !v.contains('\'')
        && !v.chars().any(char::is_control)
}

/// Where this box keeps things, in its own words.
///
/// The laptop cannot know a box's home directory, and guessing `/home/<user>`
/// is wrong on macOS boxes, on anything with a non-standard layout, and on
/// every account whose name isn't its directory. So we ask.
pub fn home_dir() -> String {
    "printf '%s\\n' \"$HOME\"".to_string()
}

/// What git will accept as a branch, narrowed to what we are willing to build a
/// directory name out of.
pub fn is_branch(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 200
        && !v.starts_with('-')
        && !v.starts_with('/')
        && !v.ends_with('/')
        && !v.contains("..")
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
}

/// A clone source. Only the two transports we can actually authenticate on a
/// box: https, and ssh in either spelling. `--upload-pack`-style argument
/// smuggling is refused outright rather than escaped, because a URL that starts
/// with a dash is never a real one.
pub fn is_remote_url(v: &str) -> bool {
    !v.starts_with('-')
        && v.len() <= 2048
        && !v.contains(char::is_whitespace)
        && (v.starts_with("https://") || v.starts_with("ssh://") || v.starts_with("git@"))
}

/// Free text that will be stored on the session and read back out of a
/// tab-separated listing. Tabs and newlines would split one row into two, so
/// they collapse to spaces here rather than being rejected — a title is
/// cosmetic, and losing the session over its label would be absurd.
pub fn sanitize_title(v: &str) -> String {
    let flat: String = v
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut out = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 120 {
        out = out.chars().take(119).collect::<String>() + "…";
    }
    out
}

/// Turn anything into the middle of a session name.
pub fn slug(v: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in v.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars().take(40).collect()
}

/// The last path component, which is what a project is called.
pub fn basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// The name a new session gets: what it is, what it's for, and enough noise to
/// keep two sessions started in the same second apart.
pub fn session_name(kind: &str, project: &str, nonce: &str) -> String {
    let k = slug(kind);
    let p = slug(basename(project));
    let n = slug(nonce);
    format!(
        "aura-{}-{}-{}",
        if k.is_empty() { "shell".into() } else { k },
        if p.is_empty() { "box".into() } else { p },
        if n.is_empty() { "0".into() } else { n },
    )
}

/// The separator between fields of one listed row.
///
/// A real tab, chosen because tmux emits format strings verbatim and every
/// value we put in has already had its own tabs flattened (`sanitize_title`) or
/// is a path/name that may not contain one. Splitting on something exotic would
/// only move the problem.
pub const FIELD_SEP: char = '\t';

/// Everything running on the box, in one round trip.
///
/// `2>/dev/null || true` because a box with no tmux server is the normal state
/// of a box nobody is using: tmux writes "no server running" to stderr and exits
/// non-zero, and that is not an error, it is an empty list. A box with no tmux
/// *at all* lands in the same place, which is right — it can hold no sessions.
///
/// The project falls back to the session's own working directory when nothing
/// stamped it. Most sessions on a real box were not started from here — someone
/// ran `tmux new` in a checkout over ssh, or the CLI did — and filing all of
/// those under "elsewhere" would make the list disagree with a machine that
/// knows perfectly well which directory they are in. `#{?x,a,b}` is tmux's own
/// conditional, so the choice is made on the box, in the same round trip.
pub fn list_sessions() -> String {
    format!(
        "tmux list-sessions -F \
         '#{{session_name}}{s}#{{?@aura_project,#{{@aura_project}},#{{pane_current_path}}}}\
{s}#{{@aura_kind}}{s}#{{@aura_agent}}\
{s}#{{@aura_branch}}{s}#{{@aura_title}}{s}#{{session_created}}{s}#{{session_activity}}\
{s}#{{session_attached}}' 2>/dev/null || true",
        s = FIELD_SEP
    )
}

/// Where to look for projects.
///
/// Discovered, not dictated. `~/aura-src` and `~/naridon` were cloned by hand
/// long before any of this existed and they are real projects; a layout we
/// invent now would make them invisible. So we scan a couple of roots one level
/// deep and take whatever has a `.git` in it.
pub fn project_roots() -> Vec<&'static str> {
    vec!["$HOME", "$HOME/aura/projects", "$HOME/workspaces"]
}

/// Every project the box has: path, remote, branch, and how much uncommitted
/// work is sitting in it.
///
/// `-e` rather than `-d` on the `.git` test: in a worktree it is a *file*
/// pointing at the parent's git dir, and a worktree is a place you can work as
/// much as the checkout it came from.
pub fn list_projects() -> String {
    let globs = project_roots()
        .iter()
        .map(|r| format!("\"{r}\"/*/"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"seen=""; for d in {globs}; do
  p="${{d%/}}"
  [ -e "$p/.git" ] || continue
  case " $seen " in *" $p "*) continue ;; esac
  seen="$seen $p"
  r="$(git -C "$p" remote get-url origin 2>/dev/null)"
  b="$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  n="$(git -C "$p" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  printf '%s{s}%s{s}%s{s}%s\n' "$p" "$r" "$b" "$n"
done"#,
        globs = globs,
        s = FIELD_SEP
    )
}

/// A coding-agent CLI binary name, e.g. `claude` / `opencode` / `gemini`. The
/// same charset a session name allows — a name is all it can ever be, so a
/// value carrying a slash, a space or a shell metacharacter is not a binary we
/// would `command -v`, it is an injection attempt, and it is dropped.
pub fn is_bin_name(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Ask the box which of these agent CLIs it actually has, so the picker offers
/// what will run THERE rather than what this laptop happens to hold. Prints one
/// installed binary name per line (via `command -v`), in the order asked;
/// absent ones print nothing. Names are validated with `is_bin_name` and
/// single-quoted, so a malformed candidate can neither run nor inject — the
/// loop simply never sees it.
pub fn probe_agents(bins: &[String]) -> String {
    let list = bins
        .iter()
        .filter(|b| is_bin_name(b))
        .map(|b| quote(b))
        .collect::<Vec<_>>()
        .join(" ");
    // Nothing valid to ask about → a script that succeeds and prints nothing,
    // so the caller reads "none installed" rather than an ssh error.
    if list.is_empty() {
        return "true".to_string();
    }
    format!(r#"for b in {list}; do command -v "$b" >/dev/null 2>&1 && printf '%s\n' "$b"; done"#)
}

/// Add a worktree so a session can have the project to itself.
///
/// Two spellings because there are two situations and git distinguishes them:
/// a branch that does not exist yet is created (`-b`), one that already does is
/// checked out. Trying the first and falling back reads the same either way to
/// whoever asked for "work on `fix/login`".
///
/// A directory that is already there is a success, not a third situation. Send
/// a fleet of three agents to one branch on a box and the first call makes the
/// worktree while the other two arrive to find it made — and every fallback
/// above ends in `worktree add <path>`, which fails on a path that exists. So
/// the second and third agents would have been refused a directory that was
/// sitting there ready for them, and the person who asked for three agents
/// would have got one.
pub fn add_worktree(project: &str, path: &str, branch: &str) -> String {
    let p = quote(project);
    let w = quote(path);
    let b = quote(branch);
    format!(
        "if [ -d {w} ]; then :; else \
         git -C {p} worktree add -b {b} {w} 2>/dev/null \
         || git -C {p} worktree add {w} {b} 2>/dev/null \
         || git -C {p} worktree add {w}; fi"
    )
}

/// Where a worktree for this branch goes: beside the project, never inside it.
///
/// Inside would make the worktree part of the project's own status, and every
/// `git status` in the parent would show a directory full of someone else's
/// half-finished work.
pub fn worktree_path(project: &str, branch: &str) -> String {
    format!(
        "{}-{}",
        project.trim_end_matches('/'),
        slug(branch)
    )
}

/// Stamp what we know onto the session itself.
///
/// tmux keeps `@`-prefixed options per session and hands them back in a format
/// string, so the session *is* the record. Nothing to write to disk, nothing to
/// clean up, and no way for the list to disagree with what is running: when the
/// session ends, so does everything we knew about it.
fn stamp(name: &str, key: &str, value: &str) -> String {
    format!(
        "tmux set-option -t {} {} {}",
        quote(name),
        key,
        quote(value)
    )
}

/// The shell command a session runs, given what it is for.
///
/// An agent that isn't installed says so and leaves a shell, rather than the
/// session dying with `command not found` — same bargain the interactive path
/// makes (`remoteShell.ts::remoteAgentCommand`), for the same reason: the box
/// is right there and installing it is one line.
///
/// After the agent exits, for any reason, the session drops to a login shell
/// instead of ending. You put work on this machine so it would outlive your
/// connection; having it vanish the moment the agent finishes — taking its own
/// last words with it — is the opposite of that.
///
/// `preload` runs first, inside the session's own process. It has to be there
/// rather than around the `tmux` call: `new-session` talks to a server that is
/// already running, and the session it makes takes its environment from that
/// server's — so anything exported by the shell that asked for the session
/// reaches nothing. Empty for a member with nothing held, which is most of them,
/// and the line is then byte-for-byte what it always was.
///
/// Two things ride in it, composed by the caller because both are the same kind
/// of thing — something the session's own process has to have run before the
/// work starts. The first is this member's secrets
/// ([`crate::manager::brain::place_secrets`]). The second is whose credential
/// the run spends ([`crate::manager::brain::place_agent_key`]), which is
/// announced before it is loaded: the sentence goes in front of the engine
/// taking the terminal, not after it has already billed somebody.
///
/// `confine` is the agent phase's guard, as a path in the member's home
/// ([`crate::manager::brain::place_egress`]). When it is there, the *agent* is
/// not started directly — the guard is, and it starts the agent behind a
/// default-deny wall with this project's allowlist. Everything around it is
/// unchanged, deliberately: the "is it installed" check stays outside, because
/// a missing agent is a sentence and a shell rather than a wall that refuses to
/// go up over it, and the drop to a login shell afterwards still happens
/// because the guard hands back the agent's own exit code.
///
/// A missing agent is no longer *only* a sentence, though. Before the check
/// runs, [`fetch_if_missing`] fetches the agent into the member's own home when
/// Aura knows which package it is — no root, nothing outside that home, and the
/// teammate in the next tmux window is untouched. The sentence stays exactly
/// where it was, because the check after the fetch is the one that decides: an
/// agent nobody has a package for, or a fetch that failed, still gets the
/// honest answer and a shell.
fn inner_command(spec: &NewSession, preload: &str, confine: Option<&str>) -> String {
    let preload = if preload.trim().is_empty() { "" } else { preload };
    match spec.agent.as_deref().filter(|_| spec.kind == "agent") {
        Some(bin) => {
            let b = quote(bin);
            let run = match confine {
                Some(guard) => home_sh(guard),
                // A detached session spec carries no flags of its own — `NewSession` has
                // no argv — so the empty slice here is the honest answer rather than a
                // place that quietly drops them.
                None => agent_line(bin, &[], spec.prompt.as_deref()),
            };
            format!(
                "{preload}{fetch}command -v {b} >/dev/null 2>&1 \
                 && {run}; \
                 command -v {b} >/dev/null 2>&1 \
                 || echo {missing}; \
                 exec \"$SHELL\" -l",
                fetch = fetch_if_missing(bin),
                missing = quote(&format!(
                    "{} isn't installed on this machine yet — install it here and start it again.",
                    bin
                ))
            )
        }
        None => format!("{preload}exec \"$SHELL\" -l"),
    }
}

/// The agent's own command line: the binary, and its first words if it was
/// given any.
///
/// One function because two surfaces build it — a detached session here and an
/// interactive terminal in [`crate::manager::brain::place_open`] — and a third
/// thing now *runs* it: the guard, which is handed this exact string to run
/// behind the wall. Spelled twice, the confined line and the unconfined one
/// would drift, and the drift would be an agent that gets a prompt in one
/// place-mode and not the other.
///
/// `args` are the agent's flags, which are argv on this laptop and a line on a
/// box — this is where the second is made from the first. Quoted one by one,
/// never joined and re-split: a model id is tame, but an
/// `--append-system-prompt` carries a paragraph of the user's own words, and
/// the shell over there would read every space in it as another argument. An
/// agent started with its flags dropped is the worst kind of parity bug — it
/// runs, it answers, and it is on the wrong model.
pub fn agent_line(bin: &str, args: &[String], prompt: Option<&str>) -> String {
    let mut line = quote(bin);
    for a in args {
        line.push(' ');
        line.push_str(&quote(a));
    }
    if let Some(p) = prompt.map(str::trim).filter(|p| !p.is_empty()) {
        line.push(' ');
        line.push_str(&quote(p));
    }
    line
}

/// A path in the member's own home, as a command to run.
///
/// `$HOME` stays outside the quotes so the machine expands it — quoted whole,
/// `~` is a literal directory name and the file is one nobody will ever find.
pub fn home_sh(home_path: &str) -> String {
    let rel = home_path.strip_prefix("~/").unwrap_or(home_path);
    format!("sh \"$HOME\"/{}", quote(rel))
}

/// Start a session, and record what it is.
///
/// `-d` so it starts detached: the session's life is the box's business, not
/// this terminal's. Attaching is a separate act, done later, possibly from a
/// different device, possibly by more than one person.
///
/// `preload` is the line that puts this member's secrets into the session's
/// environment ([`crate::manager::brain::place_secrets`]). It goes *inside* the
/// session's command, and never into `tmux -e NAME=value` — that is argv, and
/// argv is in `ps` on both ends.
///
/// `confine` is the agent phase's guard, when the place could hold one. A shell
/// session never has one — a person at a keyboard is not the agent phase — and
/// a machine that cannot put a wall up gets `None` and a sentence printed where
/// the work is, rather than a claim nobody can check.
pub fn start_session(
    spec: &NewSession,
    name: &str,
    dir: &str,
    preload: &str,
    confine: Option<&str>,
) -> String {
    let mut parts = vec![format!(
        "tmux new-session -d -s {} -c {} {}",
        quote(name),
        quote(dir),
        quote(&inner_command(spec, preload, confine))
    )];
    parts.push(stamp(name, "@aura_project", dir));
    parts.push(stamp(name, "@aura_kind", &spec.kind));
    if let Some(a) = spec.agent.as_deref().filter(|a| !a.is_empty()) {
        parts.push(stamp(name, "@aura_agent", a));
    }
    if let Some(b) = spec.branch.as_deref().filter(|b| !b.is_empty()) {
        parts.push(stamp(name, "@aura_branch", b));
    }
    let title = sanitize_title(
        spec.title
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| basename(dir)),
    );
    parts.push(stamp(name, "@aura_title", &title));
    parts.join(" && ")
}

/// End a session. Whatever it was running goes with it — which is the point,
/// and why the surface that calls this says so first.
pub fn stop_session(name: &str) -> String {
    format!("tmux kill-session -t {}", quote(name))
}

/// Clone a project onto the box, in a session you can watch.
///
/// A clone is minutes of output on a big repo, so it is not a command we run
/// and wait on with a spinner — it is a session like any other. You can open
/// it, watch it, and it is still there if you close the app.
///
/// `git_opts` are the `-c` arguments naming which credential this clone spends
/// (see [`crate::manager::brain::place_git`]). Empty is a real answer and not an
/// omission — a public repo needs none, and an ssh remote uses a key — so this
/// only ever *adds* what a source chose. `note` is that choice in words, printed
/// into the session before git starts, because the session is where a person
/// watching a clone actually is.
pub fn clone_project(url: &str, dir: &str, name: &str, git_opts: &[String], note: &str) -> String {
    let opts = git_opts
        .iter()
        .map(|o| quote(o))
        .collect::<Vec<_>>()
        .join(" ");
    let announce = match note.trim() {
        "" => String::new(),
        n => format!("echo {}; ", quote(n)),
    };
    let inner = format!(
        "{}git {}clone --progress {} {} && echo {} || echo {}; exec \"$SHELL\" -l",
        announce,
        if opts.is_empty() {
            String::new()
        } else {
            format!("{opts} ")
        },
        quote(url),
        quote(dir),
        quote("Cloned. This project is ready to work in."),
        quote("Clone failed — the message above is git's own.")
    );
    let parent = dir.rsplit_once('/').map(|(p, _)| p).unwrap_or("/");
    let mut parts = vec![
        format!("mkdir -p {}", quote(parent)),
        format!(
            "tmux new-session -d -s {} -c {} {}",
            quote(name),
            quote(parent),
            quote(&inner)
        ),
    ];
    parts.push(stamp(name, "@aura_project", dir));
    parts.push(stamp(name, "@aura_kind", "clone"));
    parts.push(stamp(
        name,
        "@aura_title",
        &sanitize_title(&format!("Cloning {}", basename(dir))),
    ));
    parts.join(" && ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_asks_command_v_for_each_valid_binary() {
        let s = probe_agents(&["claude".into(), "gemini".into()]);
        assert!(s.contains("command -v"));
        assert!(s.contains("'claude'"));
        assert!(s.contains("'gemini'"));
    }

    #[test]
    fn probe_drops_anything_that_isnt_a_binary_name() {
        // A slash, a space, a shell metacharacter — none can reach the loop.
        let s = probe_agents(&[
            "claude".into(),
            "rm -rf /".into(),
            "$(whoami)".into(),
            "a/b".into(),
        ]);
        assert!(s.contains("'claude'"));
        assert!(!s.contains("whoami"));
        assert!(!s.contains("rm -rf"));
        assert!(!s.contains("a/b"));
    }

    #[test]
    fn probe_of_no_valid_names_is_a_harmless_no_op() {
        // All dropped → a script that succeeds and prints nothing.
        assert_eq!(probe_agents(&["a/b".into()]), "true");
        assert_eq!(probe_agents(&[]), "true");
    }

    fn spec(kind: &str, agent: Option<&str>) -> NewSession {
        NewSession {
            project: "/home/ubuntu/naridon".into(),
            kind: kind.into(),
            agent: agent.map(String::from),
            title: None,
            branch: None,
            prompt: None,
        }
    }

    #[test]
    fn a_quote_in_a_value_cannot_end_the_string() {
        // The whole security model rests on this one line behaving.
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("; rm -rf ~"), "'; rm -rf ~'");
    }

    /// The table both halves of the app are held to. Parsed by hand rather than
    /// with serde so this test depends on nothing that could be configured away
    /// — it is the one place a mismatch between two languages is caught.
    fn quoting_cases() -> Vec<(String, String)> {
        let raw = include_str!("quoting.cases.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("the quoting table parses");
        v["cases"]
            .as_array()
            .expect("a `cases` array")
            .iter()
            .map(|c| {
                (
                    c["raw"].as_str().expect("a raw string").to_string(),
                    c["quoted"].as_str().expect("a quoted string").to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn the_frontends_copy_of_quoting_is_pinned_to_this_one() {
        // `remoteShell.ts::shQuote` reads the same file and asserts the same
        // rows, so neither spelling can change without the other going red.
        // Without this the two agree only for as long as nobody edits either.
        let cases = quoting_cases();
        assert!(cases.len() >= 10, "the shared quoting table has been gutted");
        for (raw, want) in cases {
            assert_eq!(quote(&raw), want, "quoting {raw:?} disagrees with the shared table");
        }
    }

    #[test]
    fn a_word_a_shell_would_not_touch_is_left_as_itself() {
        // The line a person watches being typed into their own terminal. Every
        // one of these is a word the app really does put in one.
        for plain in [
            "ssh",
            "-i",
            "/Users/mo/keys/box.pem",
            "StrictHostKeyChecking=accept-new",
            "ubuntu@box.example",
            "-t",
        ] {
            assert_eq!(word(plain), plain);
        }
    }

    #[test]
    fn a_word_a_shell_would_touch_is_quoted_exactly_as_a_remote_value_is() {
        // One rule, not two: anything that isn't plainly safe goes through the
        // same `quote` the far side is held to.
        for risky in [
            "/Users/mo/My Keys/box.pem",
            "cd '/home/u/p'; exec \"$SHELL\" -l",
            "$(id)",
            "it's",
            "",
            // `~` bare would be expanded by the local shell, and this layer
            // must never rewrite what it was handed.
            "~/keys/box.pem",
        ] {
            assert_eq!(word(risky), quote(risky), "{risky:?} reached a shell unquoted");
        }
    }

    #[test]
    fn a_session_name_is_only_ever_plain() {
        assert!(is_session_name("aura-agent-naridon-k3f9"));
        // tmux's own separators would address a different pane, not a session.
        assert!(!is_session_name("aura:0.1"));
        assert!(!is_session_name("aura shell"));
        assert!(!is_session_name(""));
        assert!(!is_session_name("$(whoami)"));
    }

    #[test]
    fn a_path_must_be_absolute_and_unsurprising() {
        assert!(is_abs_path("/home/ubuntu/naridon"));
        assert!(!is_abs_path("naridon"));
        // A traversal is refused rather than normalised: we would only be
        // guessing where it meant to land.
        assert!(!is_abs_path("/home/ubuntu/../root"));
        assert!(!is_abs_path("/home/ubuntu/a'b"));
        assert!(!is_abs_path("/home/ubuntu/a\nb"));
    }

    #[test]
    fn a_branch_may_have_slashes_but_not_a_leading_dash() {
        assert!(is_branch("fix/login"));
        assert!(is_branch("feat/cloud-placement-plane"));
        // Otherwise git reads it as an option.
        assert!(!is_branch("--upload-pack=evil"));
        assert!(!is_branch("a..b"));
        assert!(!is_branch("has space"));
    }

    #[test]
    fn only_transports_a_box_can_authenticate() {
        assert!(is_remote_url("https://github.com/Uniskool/naridon.git"));
        assert!(is_remote_url("git@github.com:Uniskool/naridon.git"));
        assert!(!is_remote_url("--upload-pack=touch /tmp/x"));
        assert!(!is_remote_url("file:///etc"));
        assert!(!is_remote_url("https://host/a b"));
    }

    #[test]
    fn a_title_cannot_split_a_row_in_two() {
        // The listing is tab-separated, so a tab in a title would invent a
        // field and shift every value after it.
        assert_eq!(sanitize_title("fix\tthe\nlogin bug"), "fix the login bug");
        assert_eq!(sanitize_title("   spaced   out   "), "spaced out");
        assert_eq!(sanitize_title(&"x".repeat(500)).chars().count(), 120);
    }

    #[test]
    fn a_session_name_says_what_it_is_and_where() {
        assert_eq!(
            session_name("agent", "/home/ubuntu/naridon", "k3f9"),
            "aura-agent-naridon-k3f9"
        );
        // Nothing a caller passes can escape the shape.
        assert!(is_session_name(&session_name(
            "a;b",
            "/home/ubuntu/my project",
            "$(id)"
        )));
    }

    #[test]
    fn a_worktree_sits_beside_its_project_not_inside_it() {
        // Inside, every `git status` in the parent would report a directory
        // full of someone else's half-finished work.
        let p = "/home/ubuntu/naridon";
        let w = worktree_path(p, "fix/login");
        assert_eq!(w, "/home/ubuntu/naridon-fix-login");
        assert!(!w.starts_with(&format!("{p}/")));
        assert!(is_abs_path(&w));
    }

    #[test]
    fn starting_an_agent_records_what_it_is() {
        let mut s = spec("agent", Some("claude"));
        s.branch = Some("fix/login".into());
        s.title = Some("Fix the login redirect".into());
        let out = start_session(&s, "aura-agent-naridon-k3f9", "/home/ubuntu/naridon", "", None);
        assert!(out.contains("tmux new-session -d -s 'aura-agent-naridon-k3f9'"));
        assert!(out.contains("@aura_project '/home/ubuntu/naridon'"));
        assert!(out.contains("@aura_agent 'claude'"));
        assert!(out.contains("@aura_branch 'fix/login'"));
        assert!(out.contains("@aura_title 'Fix the login redirect'"));
    }

    #[test]
    fn an_agent_that_is_not_installed_leaves_you_a_shell() {
        // A session that dies with `command not found` teaches nothing and
        // leaves you nowhere — the box is right there.
        let inner = inner_command(&spec("agent", Some("codex")), "", None);
        assert!(inner.contains("isn'\\''t installed on this machine yet"));
        assert!(inner.contains("exec \"$SHELL\" -l"));
    }

    #[test]
    fn an_agent_that_is_not_installed_is_fetched_into_the_members_own_home_first() {
        // The sentence above is now the second answer, not the first. A member
        // who opens a session for an agent this box hasn't got gets it fetched
        // into their own home — no root, and the person in the next tmux
        // window is not changed by it.
        let inner = inner_command(&spec("agent", Some("codex")), "", None);
        assert!(inner.contains("npm install -g '@openai/codex'"), "{inner}");
        assert!(!inner.contains("sudo"), "{inner}");
        // Into whoever is sitting there, resolved by that machine.
        assert!(inner.contains("NPM_CONFIG_PREFIX=\"$HOME/.npm-global\""), "{inner}");
        // And only when it is actually missing — a member who already has it
        // must not sit through an install every time they open a session.
        let guarded = inner.find("command -v 'codex' >/dev/null 2>&1 ||").expect("a guard");
        assert!(guarded < inner.find("npm install").unwrap(), "{inner}");
        // The sentence stays, because the check after the fetch is the one
        // that decides.
        assert!(inner.contains("isn'\\''t installed on this machine yet"));
    }

    #[test]
    fn an_agent_aura_has_no_package_for_is_the_line_it_always_was() {
        // The fetch is an extra chance, never a guess. An unlisted binary must
        // not become `npm install -g <whatever was typed>`.
        let inner = inner_command(&spec("agent", Some("mycoolagent")), "", None);
        assert!(!inner.contains("npm install"), "{inner}");
        assert!(inner.contains("isn'\\''t installed on this machine yet"));
        assert!(inner.contains("exec \"$SHELL\" -l"));
    }

    #[test]
    fn a_prompt_is_one_argument_however_it_is_written() {
        let mut s = spec("agent", Some("claude"));
        s.prompt = Some("fix the bug; drop table users".into());
        // The semicolon is inside the agent's argument, not a second command.
        assert!(inner_command(&s, "", None).contains(r"'claude' 'fix the bug; drop table users'"));
    }

    #[test]
    fn the_whole_inner_command_reaches_tmux_as_one_word() {
        // It is quoted twice on purpose — once for tmux's argument, and again
        // by the shell tmux hands it to. This is the assertion that would fail
        // if someone "simplified" one of those layers away, at which point a
        // prompt containing a quote would start executing.
        let mut s = spec("agent", Some("claude"));
        s.prompt = Some("it's broken; ls".into());
        let out = start_session(&s, "aura-x", "/home/ubuntu/x", "", None);
        let inner = inner_command(&s, "", None);
        assert!(out.contains(&quote(&inner)));
        assert!(!out.contains("; ls'\n"));
    }

    #[test]
    fn a_shell_session_starts_no_agent() {
        let s = spec("shell", None);
        assert_eq!(inner_command(&s, "", None), "exec \"$SHELL\" -l");
        assert!(!start_session(&s, "aura-x", "/home/ubuntu/x", "", None).contains("@aura_agent"));
    }

    #[test]
    fn a_session_loads_its_environment_inside_itself() {
        // `tmux new-session` talks to a server that is already running, and the
        // session takes ITS environment from that server. Anything exported
        // around this command would reach nothing, so the load has to be in the
        // session's own process — before the agent, and before the shell.
        let preload = "set -a; . \"$HOME\"/'.config/aura/env/p-0123456789abcdef.env' \
                       2>/dev/null || true; set +a; ";
        let agent = inner_command(&spec("agent", Some("claude")), preload, None);
        assert!(agent.starts_with("set -a; "), "{agent}");
        assert!(agent.find("set -a").unwrap() < agent.find("command -v").unwrap());
        let shell = inner_command(&spec("shell", None), preload, None);
        assert_eq!(shell, format!("{preload}exec \"$SHELL\" -l"));

        // It goes inside the session's command and never into `tmux -e`, which
        // would put values in argv — and argv is in `ps` on both ends.
        let out = start_session(&spec("shell", None), "aura-x", "/home/u/x", preload, None);
        assert!(!out.contains(" -e "), "{out}");
        assert!(out.contains(&quote(&shell)), "{out}");
    }

    #[test]
    fn a_member_with_nothing_held_gets_the_line_they_always_got() {
        // Most sessions. A feature almost nobody uses must not rewrite the
        // command every other session runs.
        for kind in [spec("shell", None), spec("agent", Some("claude"))] {
            assert_eq!(inner_command(&kind, "", None), inner_command(&kind, "   ", None));
            assert!(!inner_command(&kind, "", None).contains("set -a"));
        }
    }

    #[test]
    fn a_run_says_whose_credential_it_spends_before_it_spends_it() {
        // What `place_agent_key` hands the caller — a sentence and a loader —
        // arrives here as one preload, and the order inside it is the point:
        // the note is printed before the engine takes the terminal, not after
        // it has already billed somebody.
        let preload = "printf '%s\\n\\n' 'Running on mo'\\''s own Anthropic key on aura-runner.'; \
                       if [ -r \"$HOME\"/'.config/aura/agent.env' ]; then set -a; \
                       . \"$HOME\"/'.config/aura/agent.env'; set +a; fi; ";
        let inner = inner_command(&spec("agent", Some("claude")), preload, None);
        let said = inner.find("Running on mo").expect("the run says nothing");
        let loaded = inner.find("set -a").expect("the credential is never loaded");
        let ran = inner.find("command -v 'claude'").expect("nothing starts");
        assert!(said < loaded && loaded < ran, "{inner}");
        // Quoted as one word, like every other sentence we print into a session.
        assert!(inner.contains(r"'Running on mo'\''s own Anthropic key on aura-runner.'"));
    }

    #[test]
    fn a_run_with_no_credential_chosen_is_exactly_what_it_always_was() {
        // The engine Aura can't speak for, and the place that couldn't be
        // asked. Neither is a reason to refuse to start work, and neither may
        // leave a blank line where a sentence would have been.
        let plain = inner_command(&spec("agent", Some("claude")), "", None);
        assert!(!plain.contains("printf '%s\\n\\n' ''"), "an empty note became a blank line");
        assert!(plain.contains("command -v 'claude'"), "{plain}");
    }

    #[test]
    fn a_confined_agent_session_runs_the_guard_and_not_the_agent() {
        let mut s = spec("agent", Some("claude"));
        s.prompt = Some("fix the login redirect".into());
        let guard = ".config/aura/egress/aura-agent-naridon-k3f9.sh";
        let inner = inner_command(&s, "", Some(guard));
        // The guard is the thing that runs; it puts the wall up and starts the
        // agent behind it. The agent appearing here on its own would mean an
        // unconfined process with the same prompt.
        assert!(
            inner.contains("sh \"$HOME\"/'.config/aura/egress/aura-agent-naridon-k3f9.sh'"),
            "{inner}"
        );
        assert!(!inner.contains("&& 'claude';"), "the agent ran outside its wall: {inner}");
        assert!(!inner.contains("fix the login redirect"), "{inner}");
        // `$HOME` is expanded by the machine that runs this, not by us — we do
        // not know where a box keeps a given member's home.
        assert!(!inner.contains("'$HOME'"), "{inner}");
        // Everything around it is unchanged: still checked for, still leaves a
        // shell if it isn't installed.
        assert!(inner.contains("command -v 'claude' >/dev/null 2>&1"), "{inner}");
        assert!(inner.ends_with("exec \"$SHELL\" -l"), "{inner}");
    }

    #[test]
    fn a_confined_session_is_still_one_argument_to_tmux() {
        let s = spec("agent", Some("claude"));
        let guard = ".config/aura/egress/aura-x.sh";
        let out = start_session(&s, "aura-x", "/home/ubuntu/x", "", Some(guard));
        assert!(out.contains(&quote(&inner_command(&s, "", Some(guard)))), "{out}");
        // A shell session never gets one: a person at a keyboard is not the
        // agent phase.
        let shell = spec("shell", None);
        assert!(!inner_command(&shell, "", Some(guard)).contains("egress"));
    }

    #[test]
    fn the_agents_command_line_is_spelled_once() {
        // Two surfaces build it and a third runs it. Spelled twice, a prompt
        // would reach the agent in one place-mode and not the other.
        assert_eq!(agent_line("claude", &[], None), "'claude'");
        assert_eq!(agent_line("claude", &[], Some("   ")), "'claude'");
        assert_eq!(
            agent_line("claude", &[], Some("it's broken")),
            r"'claude' 'it'\''s broken'"
        );
        // And a home-relative path is a command with `$HOME` left to the far
        // side, whether or not the caller wrote the `~/`.
        assert_eq!(home_sh("~/a/b.sh"), "sh \"$HOME\"/'a/b.sh'");
        assert_eq!(home_sh("a/b.sh"), "sh \"$HOME\"/'a/b.sh'");
    }

    #[test]
    fn a_session_with_no_title_is_named_after_its_directory() {
        let out = start_session(&spec("shell", None), "aura-x", "/home/ubuntu/naridon", "", None);
        assert!(out.contains("@aura_title 'naridon'"));
    }

    #[test]
    fn the_listing_asks_for_every_field_the_row_parser_expects() {
        let s = list_sessions();
        for f in [
            "#{session_name}",
            "#{@aura_project}",
            "#{@aura_kind}",
            "#{@aura_agent}",
            "#{@aura_branch}",
            "#{@aura_title}",
            "#{session_created}",
            "#{session_activity}",
            "#{session_attached}",
        ] {
            assert!(s.contains(f), "listing is missing {f}");
        }
        // A box with no tmux server is an empty list, not a failure.
        assert!(s.contains("|| true"));
    }

    #[test]
    fn a_session_nobody_stamped_still_reports_the_directory_it_is_in() {
        // Sessions started over plain ssh, or by the CLI, carry no `@aura_`
        // options. The box knows their working directory perfectly well, so
        // filing them under "elsewhere" would be the list contradicting the
        // machine — the one thing this surface must never do.
        assert!(list_sessions()
            .contains("#{?@aura_project,#{@aura_project},#{pane_current_path}}"));
    }

    #[test]
    fn a_folder_name_is_a_name_and_not_a_path() {
        assert!(is_dir_name("naridon"));
        assert!(is_dir_name("my project 2"));
        // A path is a different answer to a different question, and letting one
        // through here would put a project somewhere nobody chose.
        assert!(!is_dir_name("/home/ubuntu/naridon"));
        assert!(!is_dir_name("a/b"));
        // Hidden, or read as an option by the next tool to touch it.
        assert!(!is_dir_name(".ssh"));
        assert!(!is_dir_name("-rf"));
        assert!(!is_dir_name(""));
        assert!(!is_dir_name("it's"));
    }

    #[test]
    fn where_home_is_gets_asked_rather_than_assumed() {
        // `/home/<user>` is wrong on macOS boxes, on anything with a custom
        // layout, and on every account whose name isn't its directory.
        let s = home_dir();
        assert!(s.contains("$HOME"));
        assert!(!s.contains("/home/"));
    }

    #[test]
    fn cloning_happens_in_a_session_you_can_watch() {
        let out = clone_project(
            "https://github.com/Uniskool/naridon.git",
            "/home/ubuntu/naridon",
            "aura-clone-naridon-1",
            &[],
            "",
        );
        assert!(out.contains("tmux new-session -d -s 'aura-clone-naridon-1'"));
        assert!(out.contains("git clone --progress"));
        // Its parent, so the clone creates the directory itself rather than
        // landing inside a stale one.
        assert!(out.contains("mkdir -p '/home/ubuntu'"));
        assert!(out.contains("@aura_kind 'clone'"));
    }

    #[test]
    fn a_clone_spends_a_named_credential_and_says_which() {
        // The `-c` pair comes from whichever source answered, and the session
        // prints the choice before git starts — because "which token did that
        // clone use" is not a question anybody can answer afterwards.
        let out = clone_project(
            "https://github.com/Uniskool/naridon.git",
            "/home/ubuntu/naridon",
            "aura-clone-naridon-1",
            &[
                "-c".into(),
                "credential.helper=".into(),
                "-c".into(),
                "credential.helper=store --file=/home/mo/.git-credentials".into(),
            ],
            "Cloning with mo's own credential on aura-runner.",
        );
        // The whole inner line is quoted again for tmux, so this asserts on the
        // order the arguments end up in rather than on one spelling of the
        // escaping — the order is the part that has to be true.
        let at = |needle: &str| out.find(needle).unwrap_or_else(|| panic!("no {needle} in {out}"));
        let named = at("credential.helper=store --file=/home/mo/.git-credentials");
        let clearing = at("credential.helper=");
        assert!(
            clearing < named,
            "the helper the box already had isn't cleared before ours is named, so it \
             would still answer first: {out}"
        );
        assert!(named < at("clone --progress"), "the credential lands after the subcommand");
        assert!(out.contains("Cloning with mo"), "the session doesn't say whose credential it is");
    }

    #[test]
    fn a_clone_with_no_credential_is_the_clone_it_always_was() {
        // A public repo needs none and an ssh remote uses a key. Forcing an
        // empty `credential.helper` on either would clear a working setup to
        // prove a point, so nothing is added at all.
        let out = clone_project("https://github.com/torvalds/linux.git", "/home/ubuntu/linux", "s", &[], "");
        assert!(out.contains("git clone --progress"));
        assert!(!out.contains("credential.helper"));
    }

    #[test]
    fn a_worktree_is_created_or_checked_out_whichever_applies() {
        let out = add_worktree("/home/ubuntu/naridon", "/home/ubuntu/naridon-fix", "fix/login");
        assert!(out.contains("worktree add -b 'fix/login'"));
        assert!(out.contains("|| git -C '/home/ubuntu/naridon' worktree add"));
    }

    #[test]
    fn a_worktree_that_is_already_there_is_not_an_error() {
        // Three agents sent to one branch on one box: the first makes the
        // directory, the other two arrive to find it made. Every fallback ends
        // in a bare `worktree add <path>`, which refuses a path that exists —
        // so without the guard, asking for three agents would get you one.
        let out = add_worktree("/home/ubuntu/naridon", "/home/ubuntu/naridon-fix", "fix/login");
        assert!(out.starts_with("if [ -d '/home/ubuntu/naridon-fix' ]; then :; else "));
        assert!(out.ends_with("; fi"));
    }
}

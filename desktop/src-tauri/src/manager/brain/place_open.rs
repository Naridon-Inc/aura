//! Getting a terminal into a place.
//!
//! There is one function here and it returns a string, which is the point. A
//! shell on a box and a shell on this laptop differ in exactly one way — the
//! first is handed to `ssh` and the second to `sh` — and everything *inside*
//! that string is the same command either way: cd into the root, hold the work
//! under tmux so it survives losing the wire, drop to a login shell if the
//! agent isn't there.
//!
//! Written the other way round — a local builder and a remote builder — the two
//! drift on the first fix. `remoteShell.ts` learned to say "this machine has no
//! tmux, so it can't be holding a session" and the local terminal never did,
//! because nobody thought to. Sharing the body is what makes that impossible
//! rather than merely unlikely.
//!
//! ## Why a durable session is not optional here
//!
//! `tmux new -A` attaches to a session of that name or creates it. Without it
//! an agent dies with the pty that started it: quit the app, lose wifi in a
//! tunnel, and the work you deliberately put somewhere else goes with the
//! window. With it, reconnecting — tomorrow, from another computer, as another
//! person — puts you back in front of the same running process.
//!
//! A box is allowed to have no tmux, and installing one behind the owner's back
//! on a machine they own is not ours to do. So every line below degrades to a
//! plain shell and says so on screen, rather than failing.

use crate::cloudbox::script::{is_bin_name, is_session_name, quote};

use super::place::Place;
use super::place_contract::{Address, Open};

impl Place {
    /// A terminal here, as one line to type into a pty that is already open.
    ///
    /// [`Place::open`] is the real answer — a program and its arguments, which
    /// is the only form in which a key path with a space in it is safe. But the
    /// two surfaces that open terminals do not spawn the pty: the workspace and
    /// the connect wizard both start the user's own shell on this laptop, with
    /// their prompt and their profile, and the only way into one is to type.
    ///
    /// So the line is *derived* from the argv rather than assembled beside it.
    /// That distinction is the whole task: `remoteShell.ts` used to build its
    /// own from three fields off a machine row, which meant a second transport
    /// with none of what this one has — no multiplexed connection, no
    /// `BatchMode` distinction, its own copy of the quoting — reached by a
    /// route that would keep working while a second way of getting a machine
    /// quietly got fewer features.
    ///
    /// Reaches nothing. Both arms of this are a string, so a terminal can be
    /// asked for without waiting on a box that may be asleep.
    pub fn boot(&self, what: &Open) -> Result<String, String> {
        Ok(self.open(what)?.line())
    }
}

/// The command a terminal boots with, wherever it is going.
///
/// Named the same three ways a place can be named, because the surfaces that
/// open terminals arrive by all three routes. A machine in the book is the
/// ordinary case. An `address` is the connect wizard, which dials a box before
/// it is written down — see [`Place::at_address`]. Neither means this laptop,
/// in `root`, opened through the same body.
///
/// `open` is the same value the contract takes: a shell, an agent, or joining
/// something already running. Anything it can't hold — a session name carrying
/// a second command, a binary that isn't a binary name — is an error here
/// rather than a quoted string sent to a machine.
#[tauri::command]
pub async fn place_boot(
    root: Option<String>,
    machine_id: Option<String>,
    address: Option<Address>,
    open: Open,
) -> Result<String, String> {
    let place = match machine_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => Place::at_machine(id)?,
        None => match &address {
            Some(a) => Place::at_address(a)?,
            None => Place::resolve(root.unwrap_or_default(), None),
        },
    };
    place.boot(&open)
}

/// The one-liner that opens something, wherever it is going to run.
///
/// `root` is the working directory as written on the machine that will run
/// this — a local path for this laptop, a remote one for a box. It is only ever
/// `cd`'d into, and a root that has moved lands in the home directory rather
/// than killing the whole session over a path.
///
/// `preload` is run inside the work's own process before the work starts, and is
/// empty for a place that needs none ([`super::place_secrets`] gives one only to
/// a box, since a local process is handed its environment directly). It goes
/// *inside* rather than in front for a reason worth keeping: exporting a
/// variable in the outer shell and trusting tmux to pass it on does not work —
/// a new session in an already-running server takes its environment from the
/// server, filtered by `update-environment`, so the variable would arrive the
/// first time somebody opened a terminal and be missing every time after.
///
/// `confine` is the agent phase's guard, as a path in the member's own home
/// ([`super::place_egress`]). Present, the agent is not started directly — the
/// guard is, and it starts the agent behind a default-deny wall holding this
/// project's allowlist. It applies to [`Open::Agent`] and to nothing else, and
/// that is the split rather than an omission: a shell is a person at a keyboard,
/// and attaching joins a session that is already running with whatever it was
/// started with.
pub(super) fn command(
    what: &Open,
    root: &str,
    preload: &str,
    confine: Option<&str>,
) -> Result<String, String> {
    match what {
        Open::Shell { session } => {
            let s = checked_session(session.as_deref())?;
            Ok(format!(
                "{}{}",
                cd_into(root),
                durable(s, preload, LOGIN_SHELL)
            ))
        }
        Open::Agent {
            bin,
            args,
            prompt,
            session,
        } => {
            if !is_bin_name(bin) {
                return Err(format!("{bin} isn't the name of an agent to run."));
            }
            let s = checked_session(session.as_deref())?;
            let b = quote(bin);
            // Confined, the guard is what starts — and the guard was built
            // around this same line, flags and all
            // ([`super::place_egress::Place::confine_agent`]), so the wall goes
            // up around the command the member actually asked for.
            let run = match confine {
                Some(guard) => crate::cloudbox::script::home_sh(guard),
                None => crate::cloudbox::script::agent_line(bin, args, prompt.as_deref()),
            };
            // Not installed used to be a sentence and a shell — never `command
            // not found` and a closed window, but still a dead end: the machine
            // is right there, and the only reason the member was told to type
            // the install themselves was that nothing knew how to run it
            // without root. Now something does, so the agent is fetched into
            // this member's own home first ([`super::place_toolbox`]) and
            // nobody else on the box is changed by it. The sentence stays for
            // what the fetch cannot answer: an agent Aura has no package for,
            // or a fetch that failed. Same bargain `script::inner_command`
            // makes for a detached session, from the same function, because the
            // two must not drift.
            Ok(format!(
                "{}{fetch}command -v {b} >/dev/null 2>&1 || {{ echo {missing}; exec {LOGIN_SHELL}; }}; {}",
                cd_into(root),
                durable(s, preload, &run),
                fetch = super::place_toolbox::fetch_if_missing(bin),
                missing = quote(&format!(
                    "{bin} isn't installed here yet — install it and start it again."
                )),
            ))
        }
        // Attaching takes no `preload`, and that is the honest answer rather
        // than an omission: the session is already running, with whatever
        // environment it was started with. Loading secrets into the attaching
        // client would change nothing about the processes inside it.
        Open::Attach { session, read_only } => {
            let Some(s) = checked_session(Some(session.as_str()))? else {
                return Err("There's no session named to attach to.".to_string());
            };
            let q = quote(s);
            let flags = if *read_only { "-r " } else { "" };
            // Two ways this is nothing to sit in front of, and they are
            // different problems: a machine with no tmux was never holding a
            // session, and a session that ended between the list and the click
            // is the ordinary race. Both leave a shell rather than closing the
            // tab on an error nobody read.
            Ok(format!(
                "command -v tmux >/dev/null 2>&1 || {{ echo {no_tmux}; exec {LOGIN_SHELL}; }}; \
                 tmux has-session -t {q} 2>/dev/null || {{ echo {gone}; exec {LOGIN_SHELL}; }}; \
                 exec tmux attach {flags}-t {q}",
                no_tmux = quote("This machine has no tmux, so it can't be holding a session."),
                gone = quote("That session has ended. Nothing to attach to."),
            ))
        }
    }
}

/// The user's own shell, as a login shell so their profile is loaded — the
/// PATH that finds an agent usually lives in it.
const LOGIN_SHELL: &str = "\"$SHELL\" -l";

/// Land in the project if it's there, and in the home directory if it isn't.
///
/// A root that moved is a bad afternoon, not a reason to refuse to open a
/// terminal on the machine that could tell you where it went.
fn cd_into(root: &str) -> String {
    let r = root.trim();
    if r.is_empty() {
        String::new()
    } else {
        format!("cd {} 2>/dev/null || cd \"$HOME\"; ", quote(r))
    }
}

/// Run something under a named tmux session, when tmux is there to hold it —
/// with its environment loaded first, when this place has one to load.
///
/// With nothing to preload the line is byte-for-byte what it always was, which
/// is deliberate: the ordinary terminal is most of them, and a change that
/// rewrote every line to carry a feature almost nobody uses would be paid for by
/// everybody.
///
/// With something to preload, the whole thing becomes **one** argument. tmux is
/// given a shell command, and passing `sh -c … …` as three arguments relies on
/// how tmux joins the ones after the first — behaviour worth nobody's afternoon
/// when the failure mode is a session that starts with no credentials and says
/// nothing about why.
fn durable(session: Option<&str>, preload: &str, run: &str) -> String {
    let script = (!preload.trim().is_empty()).then(|| quote(&format!("{preload}exec {run}")));
    match (session, script) {
        (None, None) => format!("exec {run}"),
        (None, Some(s)) => format!("exec sh -c {s}"),
        (Some(name), None) => format!(
            "command -v tmux >/dev/null 2>&1 && exec tmux new -A -s {} {run}; exec {run}",
            quote(name)
        ),
        (Some(name), Some(s)) => format!(
            "command -v tmux >/dev/null 2>&1 && exec tmux new -A -s {} {s}; exec sh -c {s}",
            quote(name)
        ),
    }
}

/// A session name is addressed by name in every command after this one, so it
/// is refused rather than quoted if it isn't one.
fn checked_session(s: Option<&str>) -> Result<Option<&str>, String> {
    match s.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) if is_session_name(v) => Ok(Some(v)),
        Some(v) => Err(format!("{v} isn't a session name this can hold.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::cmd_machines::Machine;

    fn address() -> Address {
        Address {
            user: "ubuntu".into(),
            host: "box.example".into(),
            key_path: "/Users/mo/keys/box.pem".into(),
            kind: "mine".into(),
            forward_agent: false,
        }
    }

    fn a_box() -> Place {
        Place::Box {
            machine: Box::new(Machine {
                id: "ubuntu@box.example:/srv/work".into(),
                name: "aura-runner".into(),
                host: "box.example".into(),
                user: "ubuntu".into(),
                key_path: "/Users/mo/keys/box.pem".into(),
                box_kind: "mine".into(),
                repo_path: Some("/srv/work/aura".into()),
                repo_branch: None,
                project_root: Some("/Users/mo/aura".into()),
                org_slug: None,
                forward_agent: false,
                instance_id: None,
                asleep_since: 0,
                added_at: 0,
                last_used_at: 0,
            }),
            root: "/srv/work/aura".into(),
            here: "/Users/mo/aura".into(),
        }
    }

    #[test]
    fn a_terminal_typed_into_a_pty_is_the_one_that_would_have_been_spawned() {
        // The claim that lets a line exist at all: it is the argv, rendered —
        // not a second command built from the same parts. If these ever come
        // apart, the transport has forked again and this is where it shows.
        let want = Open::Attach {
            session: "aura-agent-aura-3f1".into(),
            read_only: false,
        };
        let place = a_box();
        let spawned = place.open(&want).expect("argv");
        let typed = place.boot(&want).expect("a line");

        assert_eq!(typed, spawned.line());
        assert!(typed.starts_with("ssh "), "{typed}");
        // The remote command is one word of that line, quoted whole.
        assert!(
            typed.contains(&quote(spawned.args.last().expect("a command"))),
            "the far side's command was spliced into the line rather than quoted: {typed}"
        );
    }

    #[test]
    fn the_words_a_shell_would_not_touch_stay_readable() {
        // A person watches this being typed into their own terminal. Quoting
        // every word would be safe and would also hide what the app just did.
        let typed = a_box()
            .boot(&Open::Shell { session: None })
            .expect("a line");
        assert!(typed.contains(" -i /Users/mo/keys/box.pem "), "{typed}");
        assert!(typed.contains(" -o StrictHostKeyChecking=accept-new "), "{typed}");
        assert!(typed.contains(" ubuntu@box.example "), "{typed}");
        assert!(typed.contains(" -t "), "a terminal needs a pty on the far side");
    }

    #[test]
    fn this_laptops_terminal_is_the_same_line_with_a_different_program() {
        // Parity at the level of one string. The body is identical; only the
        // program in front of it differs, which is the entire seam.
        let want = Open::Shell {
            session: Some("aura-work".into()),
        };
        let here = Place::Here {
            root: "/Users/mo/aura".into(),
        }
        .boot(&want)
        .expect("a line");
        let there = a_box().boot(&want).expect("a line");

        assert!(here.starts_with("sh -c "), "{here}");
        let body = command(&want, "/Users/mo/aura", "", None).expect("a body");
        assert!(here.contains(&quote(&body)), "{here}");
        // Same verbs, both places — held under tmux, degrading without it.
        for both in ["tmux new -A -s", "exec \"$SHELL\" -l"] {
            assert!(here.contains(both), "{here}");
            assert!(there.contains(both), "{there}");
        }
    }

    #[test]
    fn a_key_path_with_a_space_in_it_is_one_argument_in_the_line() {
        // The failure the old frontend builder was one edit away from: a path
        // that splits into two arguments and a session that dies naming a file
        // nobody typed.
        let place = Place::at_address(&Address {
            key_path: "/Users/mo/My Keys/box.pem".into(),
            ..address()
        })
        .expect("a place");
        let typed = place.boot(&Open::Shell { session: None }).expect("a line");
        assert!(typed.contains("-i '/Users/mo/My Keys/box.pem'"), "{typed}");
    }

    #[test]
    fn a_box_the_book_has_never_seen_still_opens() {
        // The connect wizard's whole case: dial first, write the row down when
        // the shell answers, so a typo leaves nothing behind.
        let typed = Place::at_address(&address())
            .expect("a place")
            .boot(&Open::Shell { session: None })
            .expect("a line");
        assert!(typed.contains("ubuntu@box.example"), "{typed}");
        // Nowhere to cd to: nobody has been there yet, so the box decides.
        assert!(!typed.contains("cd "), "{typed}");
        assert!(typed.ends_with(&quote("exec \"$SHELL\" -l")), "{typed}");
    }

    #[test]
    fn an_address_that_is_not_one_is_refused_before_anything_is_typed() {
        // The book is a file on disk and the wizard's fields are a form. Both
        // reach the same check, so neither can put an argument where this
        // laptop expects a host.
        for bad in [
            Address { host: "box.example; id".into(), ..address() },
            Address { host: "$(hostname)".into(), ..address() },
            Address { user: "ubuntu`id`".into(), ..address() },
            Address { key_path: "  ".into(), ..address() },
        ] {
            assert!(
                Place::at_address(&bad).is_err(),
                "{bad:?} should not have been dialable"
            );
        }
        assert!(Place::at_address(&address()).is_ok());
    }

    #[test]
    fn a_name_a_place_cannot_hold_never_becomes_a_line() {
        // `command` refuses these; `boot` must not launder one into a string
        // somebody types at a machine.
        assert!(a_box()
            .boot(&Open::Attach {
                session: "a; rm -rf ~".into(),
                read_only: false,
            })
            .is_err());
    }

    fn shell(root: &str, session: Option<&str>) -> String {
        command(
            &Open::Shell {
                session: session.map(str::to_string),
            },
            root,
            "",
            None,
        )
        .expect("a shell")
    }

    #[test]
    fn a_shell_lands_in_the_root_and_falls_back_to_home() {
        let out = shell("/home/u/naridon", None);
        assert!(out.starts_with("cd '/home/u/naridon' 2>/dev/null || cd \"$HOME\"; "));
        assert!(out.ends_with("exec \"$SHELL\" -l"));
    }

    #[test]
    fn a_named_shell_is_held_by_tmux_and_still_opens_without_it() {
        let out = shell("/home/u/p", Some("aura-work"));
        assert!(out.contains("exec tmux new -A -s 'aura-work' \"$SHELL\" -l"));
        // The fallback matters: a box with no tmux must still give a terminal.
        assert!(out.ends_with("; exec \"$SHELL\" -l"));
    }

    #[test]
    fn a_place_with_no_root_opens_wherever_it_starts() {
        // A machine we haven't yet learned a project path for. Refusing to open
        // a terminal on it would be worse than opening one in `$HOME`.
        assert_eq!(shell("", None), "exec \"$SHELL\" -l");
    }

    #[test]
    fn an_agent_that_is_missing_says_so_and_leaves_a_shell() {
        let out = command(
            &Open::Agent {
                bin: "claude".into(),
                args: vec![],
                prompt: None,
                session: Some("aura-fix-login".into()),
            },
            "/home/u/p",
            "",
            None,
        )
        .expect("an agent");
        assert!(out.contains("command -v 'claude' >/dev/null 2>&1 ||"));
        // The sentence carries an apostrophe, so it also proves the quoting:
        // an unescaped one would close the string and run the rest.
        assert!(out.contains(r"isn'\''t installed here yet"), "{out}");
        assert!(out.contains("exec tmux new -A -s 'aura-fix-login' 'claude'"));
    }

    #[test]
    fn a_missing_agent_is_fetched_for_this_member_in_both_place_modes() {
        // The governing rule of this programme, as a test rather than a
        // promise: this is the same string a box gets, built by the same
        // function `script::inner_command` calls. There is nothing here for
        // the two modes to drift on.
        let out = command(
            &Open::Agent {
                bin: "claude".into(),
                args: vec![],
                prompt: None,
                session: None,
            },
            "/home/u/p",
            "",
            None,
        )
        .expect("an agent");
        assert!(out.contains("npm install -g '@anthropic-ai/claude-code'"), "{out}");
        assert!(!out.contains("sudo"), "{out}");
        assert!(out.contains("NPM_CONFIG_PREFIX=\"$HOME/.npm-global\""), "{out}");
        assert!(out.contains(r"isn'\''t installed here yet"), "{out}");
        // Byte-for-byte the same guard both modes put in front of it.
        let shared = super::super::place_toolbox::fetch_if_missing("claude");
        assert!(!shared.is_empty());
        assert!(out.contains(&shared), "{out}");
    }

    #[test]
    fn an_agent_with_no_known_package_still_gets_the_sentence_and_a_shell() {
        let out = command(
            &Open::Agent {
                bin: "mycoolagent".into(),
                args: vec![],
                prompt: None,
                session: None,
            },
            "/home/u/p",
            "",
            None,
        )
        .expect("an agent");
        assert!(!out.contains("npm install"), "{out}");
        assert!(out.contains(r"isn'\''t installed here yet"), "{out}");
    }

    #[test]
    fn an_agents_first_words_reach_it_as_one_argument() {
        let out = command(
            &Open::Agent {
                bin: "claude".into(),
                args: vec![],
                prompt: Some("fix the login redirect; don't touch tests".into()),
                session: None,
            },
            "/home/u/p",
            "",
            None,
        )
        .expect("an agent");
        assert!(out.contains(&format!(
            "exec 'claude' {}",
            quote("fix the login redirect; don't touch tests")
        )));
    }

    #[test]
    fn a_prompt_that_is_only_spaces_is_no_prompt() {
        let out = command(
            &Open::Agent {
                bin: "codex".into(),
                args: vec![],
                prompt: Some("   ".into()),
                session: None,
            },
            "/p",
            "",
            None,
        )
        .expect("an agent");
        assert!(out.ends_with("exec 'codex'"), "{out}");
    }

    #[test]
    fn attaching_tells_no_tmux_apart_from_no_session() {
        let out = command(
            &Open::Attach {
                session: "aura-shell-abc".into(),
                read_only: false,
            },
            "/ignored",
            "",
            None,
        )
        .expect("an attach");
        assert!(out.contains("no tmux"));
        assert!(out.contains("That session has ended"));
        assert!(out.ends_with("exec tmux attach -t 'aura-shell-abc'"));
    }

    #[test]
    fn watching_without_taking_the_keyboard_is_a_different_line() {
        let out = command(
            &Open::Attach {
                session: "aura-shell-abc".into(),
                read_only: true,
            },
            "/ignored",
            "",
            None,
        )
        .expect("an attach");
        // Without `-r` two attached clients type into one buffer and the result
        // is neither person's command.
        assert!(out.ends_with("exec tmux attach -r -t 'aura-shell-abc'"));
    }

    #[test]
    fn a_name_carrying_a_second_command_is_refused_not_quoted() {
        // Quoting would probably hold. "Probably" is not a posture when the
        // payload reaches a shell on someone else's machine.
        for bad in ["a; rm -rf ~", "a b", "a'b", "x\ny"] {
            assert!(
                command(
                    &Open::Shell {
                        session: Some(bad.into())
                    },
                    "/p",
                    "",
                    None,
                )
                .is_err(),
                "{bad:?} should not have been accepted"
            );
            assert!(
                command(
                    &Open::Attach {
                        session: bad.into(),
                        read_only: false
                    },
                    "/p",
                    "",
                    None,
                )
                .is_err(),
                "{bad:?} should not have been accepted"
            );
        }
        assert!(command(
            &Open::Agent {
                bin: "claude; rm -rf ~".into(),
                args: vec![],
                prompt: None,
                session: None
            },
            "/p",
            "",
            None,
        )
        .is_err());
    }

    // -- what a place loads before it starts --------------------------------

    /// What [`super::place_secrets`] hands in: load the member's env file if it
    /// is there, and carry on if it is not.
    const PRELOAD: &str = "set -a; . \"$HOME\"/'.config/aura/env/p-0123456789abcdef.env' \
                           2>/dev/null || true; set +a; ";

    #[test]
    fn a_place_with_nothing_to_load_gets_the_line_it_always_got() {
        // The ordinary terminal is most of them. A feature almost nobody uses
        // must not be paid for by every session that doesn't.
        for session in [None, Some("aura-work")] {
            let plain = command(
                &Open::Shell {
                    session: session.map(str::to_string),
                },
                "/home/u/p",
                "",
                None,
            )
            .expect("a shell");
            let blank = command(
                &Open::Shell {
                    session: session.map(str::to_string),
                },
                "/home/u/p",
                "   ",
                None,
            )
            .expect("a shell");
            assert_eq!(plain, blank, "whitespace counted as something to preload");
            assert!(!plain.contains("sh -c"), "{plain}");
        }
    }

    #[test]
    fn the_preload_runs_inside_the_pane_rather_than_around_it() {
        let out = shell_with("/home/u/p", Some("aura-work"), PRELOAD);
        // tmux's `update-environment` means a new session in an already-running
        // server takes its environment from the server, not from the shell that
        // asked for it. Exporting around tmux would reach nothing.
        let (before, after) = out.split_once("exec tmux new -A -s 'aura-work' ").expect("a tmux line");
        assert!(!before.contains("set -a"), "the preload ran outside the pane: {out}");
        assert!(after.starts_with('\''), "the pane's command is not one argument: {out}");
        assert!(after.contains("set -a"), "{out}");

        // And the fallback for a box with no tmux loads it too, or the same
        // session works one way and silently has no credentials the other.
        assert!(out.ends_with("; exec sh -c 'set -a; . \"$HOME\"/'\\''.config/aura/env/p-0123456789abcdef.env'\\'' 2>/dev/null || true; set +a; exec \"$SHELL\" -l'"), "{out}");
    }

    #[test]
    fn an_unheld_shell_still_loads_what_it_was_given() {
        let out = shell_with("/home/u/p", None, PRELOAD);
        assert!(out.contains("exec sh -c '"), "{out}");
        assert!(out.contains("set -a"), "{out}");
        assert!(out.ends_with("exec \"$SHELL\" -l'"), "{out}");
        // The `cd` stays outside: it is this line's business, not the loaded
        // environment's, and a root that moved must not stop the shell opening.
        assert!(out.starts_with("cd '/home/u/p' 2>/dev/null || cd \"$HOME\"; "), "{out}");
    }

    #[test]
    fn an_agent_gets_its_environment_before_it_is_exec_d() {
        let out = command(
            &Open::Agent {
                bin: "claude".into(),
                args: vec![],
                prompt: None,
                session: Some("aura-fix-login".into()),
            },
            "/home/u/p",
            PRELOAD,
            None,
        )
        .expect("an agent");
        let pane = out.split_once("-s 'aura-fix-login' ").expect("a tmux line").1;
        // The pane's whole command is one quoted argument, so the agent's own
        // quoting is escaped inside it — which is the thing being checked as
        // much as the ordering is.
        let loaded = pane.find("set -a").expect("the preload");
        let started = pane.find(r"exec '\''claude'\''").expect("the agent");
        assert!(loaded < started, "the agent started before its environment loaded: {out}");
        // The "not installed" guard stays outside: it has to be able to say so
        // and leave a shell whether or not there was anything to load.
        assert!(out.starts_with("cd '/home/u/p' 2>/dev/null"), "{out}");
        assert!(!out[..out.find("command -v").unwrap()].contains("set -a"), "{out}");
    }

    #[test]
    fn joining_a_running_session_loads_nothing() {
        // The session already exists with the environment it was started with.
        // Loading a second copy into the attaching client would achieve nothing
        // except putting values somewhere new.
        let out = command(
            &Open::Attach {
                session: "aura-shell-abc".into(),
                read_only: false,
            },
            "/ignored",
            PRELOAD,
            None,
        )
        .expect("an attach");
        assert!(!out.contains("set -a"), "{out}");
        assert!(out.ends_with("exec tmux attach -t 'aura-shell-abc'"), "{out}");
    }

    // -- the agent phase ----------------------------------------------------

    const GUARD: &str = ".config/aura/egress/aura-agent-p-k3f9.sh";

    #[test]
    fn a_confined_agent_is_started_by_its_guard_and_not_directly() {
        let out = command(
            &Open::Agent {
                bin: "claude".into(),
                args: vec![],
                prompt: Some("fix the login redirect".into()),
                session: Some("aura-fix-login".into()),
            },
            "/home/u/p",
            "",
            Some(GUARD),
        )
        .expect("an agent");
        // The guard is what runs. It puts the wall up and starts the agent
        // behind it — so the agent's own name must not appear as the thing
        // being exec'd, or the confinement is decorative.
        assert!(out.contains("exec sh \"$HOME\"/'.config/aura/egress/aura-agent-p-k3f9.sh'"), "{out}");
        assert!(!out.contains("exec 'claude'"), "the agent ran outside its wall: {out}");
        // The prompt is the guard's business now: it is baked into the script's
        // command, so passing it here too would run the agent twice.
        assert!(!out.contains("fix the login redirect"), "{out}");
        // Everything else about the line is unchanged, including the sentence
        // for an agent that was never installed.
        assert!(out.starts_with("cd '/home/u/p' 2>/dev/null || cd \"$HOME\"; "), "{out}");
        assert!(out.contains("command -v 'claude' >/dev/null 2>&1 ||"), "{out}");
    }

    #[test]
    fn a_shell_is_a_person_at_a_keyboard_and_is_not_confined() {
        // A wall around a terminal someone is typing into would be a different
        // feature with a different argument. This one is about what an agent
        // can reach while nobody is watching it.
        for what in [
            Open::Shell {
                session: Some("aura-work".into()),
            },
            Open::Attach {
                session: "aura-work".into(),
                read_only: false,
            },
        ] {
            let out = command(&what, "/home/u/p", "", Some(GUARD)).expect("a line");
            assert!(!out.contains("egress"), "{out}");
        }
    }

    fn shell_with(root: &str, session: Option<&str>, preload: &str) -> String {
        command(
            &Open::Shell {
                session: session.map(str::to_string),
            },
            root,
            preload,
            None,
        )
        .expect("a shell")
    }
}

/// The same lines, typed into a real pty, against a real machine.
///
/// Everything above proves the string is right. That is worth having and it is
/// not the claim the workspace rests on: a line can be perfectly quoted and
/// still land you nowhere, and every failure that actually bites — a key the
/// box refuses, a directory that moved, a tmux that isn't installed — only
/// shows up on the other side of the wire.
///
/// So these run the line the app really types, on a pty, and read the far
/// shell's own bytes back. A pty and not a pipe: `-t` asks the far end for a
/// terminal and ssh will not hand one over unless this end has one too, so a
/// piped spawn would be testing a different command than the one that ships.
///
/// ```text
/// AURA_LIVE_MACHINE='ubuntu@1.2.3.4:/home/ubuntu/naridon' \
///   cargo test --lib manager::brain::place_open::live -- --ignored --test-threads=1
/// ```
///
/// They clean up after themselves, and every session they make is named
/// `aura-livetest-…` so a failed run leaves something obviously disposable
/// rather than something you have to guess about.
#[cfg(test)]
mod live {
    use std::io::{Read, Write};
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

    use super::*;
    use crate::cloudbox::shellexpand_home;

    /// Reaching a box across the internet is not fast, and a cold one is slower.
    const PATIENCE: Duration = Duration::from_secs(90);

    /// How long to leave between lines typed at the far shell. Bytes written
    /// into the ssh handshake window are simply lost with no error, which is
    /// the whole reason the wizard knocks rather than assuming.
    const SETTLE: Duration = Duration::from_millis(2_500);

    /// What the far shell says back. Split so the terminal's echo of the
    /// command can never contain it — only the command's output can.
    const READY: &str = "___AURA_SHELL_READY___";
    const KNOCK: &str = r#"echo "___AURA""_SHELL_READY___""#;

    fn there() -> Option<Place> {
        let id = std::env::var("AURA_LIVE_MACHINE")
            .ok()
            .filter(|v| !v.is_empty())?;
        let p = Place::at_machine(&id).expect("a machine in the book");
        // A live test that silently tested this laptop would be worse than no
        // test at all.
        assert!(p.is_remote(), "{id} isn't a machine in the book");
        Some(p)
    }

    /// A pty with something running in it — the app's own arrangement, since
    /// the app never spawns `ssh` itself either. `sh -c <line>` is exactly what
    /// the terminal does with what `Place::boot` hands it.
    struct Session {
        _master: Box<dyn MasterPty + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        writer: Box<dyn Write + Send>,
        said: Arc<Mutex<String>>,
    }

    impl Session {
        fn open(line: &str) -> Session {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 40,
                    cols: 120,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .expect("a pty");

            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.arg("-c");
            cmd.arg(line);
            cmd.env("TERM", "xterm-256color");

            let child = pair.slave.spawn_command(cmd).expect("a shell");
            drop(pair.slave);

            let writer = pair.master.take_writer().expect("a writer");
            let mut reader = pair.master.try_clone_reader().expect("a reader");
            let said = Arc::new(Mutex::new(String::new()));
            let into = Arc::clone(&said);
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => into
                            .lock()
                            .unwrap()
                            .push_str(&String::from_utf8_lossy(&buf[..n])),
                    }
                }
            });

            Session {
                _master: pair.master,
                child,
                writer,
                said,
            }
        }

        /// Type a line, having waited for whatever is over there to be reading.
        fn say(&mut self, line: &str) {
            thread::sleep(SETTLE);
            let _ = self.writer.write_all(line.as_bytes());
            let _ = self.writer.write_all(b"\r");
            let _ = self.writer.flush();
        }

        /// Pull the plug on this end, the way quitting the app would.
        fn hang_up(&mut self) {
            let _ = self.child.kill();
        }

        /// Everything the far end said, once it is done saying it.
        fn ended(mut self) -> String {
            let until = Instant::now() + PATIENCE;
            while Instant::now() < until {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                thread::sleep(Duration::from_millis(200));
            }
            self.hang_up();
            // Let the reader drain what arrived just before the end.
            thread::sleep(Duration::from_millis(400));
            let out = self.said.lock().unwrap().clone();
            out
        }
    }

    /// Open a session, type into it, and hand back everything it said.
    fn over(line: &str, say: &[&str]) -> String {
        let mut s = Session::open(line);
        for l in say {
            s.say(l);
        }
        s.ended()
    }

    /// Ask the box a question from a second connection.
    ///
    /// Deliberately not built by `Place`: this is the observer, and an observer
    /// that shares the thing under test can agree with it for the wrong reason.
    fn observe(p: &Place, remote: &str) -> String {
        let who = p.identity();
        let out = Command::new("ssh")
            .arg("-i")
            .arg(shellexpand_home(&who.key_path.expect("a key path")))
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-o")
            .arg("ConnectTimeout=15")
            .arg(format!("{}@{}", who.user, who.host.expect("a host")))
            .arg(remote)
            .output()
            .expect("ssh ran");
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn the_line_lands_in_a_live_shell_in_the_root_under_tmux() {
        let Some(p) = there() else { return };
        let session = "aura-livetest-boot-shell";
        let out = over(
            &p.boot(&Open::Shell {
                session: Some(session.into()),
            })
            .expect("a line"),
            &[
                KNOCK,
                "pwd",
                // Inside tmux this prints the session; outside it prints
                // nothing, which is exactly the distinction the workspace
                // draws on screen.
                "tmux display-message -p '#S' 2>/dev/null || echo NO-TMUX",
                // Leaving kills the pane, and with it the session — a test
                // that left sessions on a shared box would be a bug of its own.
                "exit",
            ],
        );

        // The far shell read something we typed and ran it. Everything else
        // here depends on that being true.
        assert!(out.contains(READY), "{out}");
        // We were put where the workspace says we are, not in $HOME.
        assert!(out.contains(p.root()), "{out}");
        // And the session is durable: closing this pty would leave the work.
        assert!(out.contains(session), "{out}");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn an_agent_that_isnt_there_says_so_and_leaves_a_usable_shell() {
        let Some(p) = there() else { return };
        let bin = "aura-agent-that-does-not-exist";
        let out = over(
            &p.boot(&Open::Agent {
                bin: bin.into(),
                args: vec![],
                prompt: None,
                session: Some("aura-livetest-missing-agent".into()),
            })
            .expect("a line"),
            &[KNOCK, "exit"],
        );

        assert!(out.contains(&format!("{bin} isn't installed here yet")), "{out}");
        // The fallback is a real shell, not a dead pane: it answers the knock.
        assert!(out.contains(READY), "{out}");
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn an_agent_that_is_there_outlives_this_end_of_the_wire() {
        let Some(p) = there() else { return };
        let session = "aura-livetest-agent-run";
        // `cat` stands in for the coding agent, for two reasons. It is on every
        // box, so `command -v` takes the installed branch — and it stays up,
        // which is the property under test: the process is running on THAT
        // machine, in a session that does not belong to this pty.
        let mut agent = Session::open(
            &p.boot(&Open::Agent {
                bin: "cat".into(),
                args: vec![],
                prompt: None,
                session: Some(session.into()),
            })
            .expect("a line"),
        );
        thread::sleep(Duration::from_secs(8));

        let pane = observe(
            &p,
            &format!("tmux list-panes -t {session} -F '#{{pane_current_command}}'"),
        );
        assert_eq!(pane.trim(), "cat", "{pane}");

        // Now do what closing the laptop does: kill this end without warning.
        // The agent is on the other machine, so it has no reason to care — and
        // this is the whole argument for running work on a box at all.
        agent.hang_up();
        let _ = agent.ended();
        thread::sleep(Duration::from_millis(1_500));

        let after = observe(
            &p,
            &format!("tmux list-panes -t {session} -F '#{{pane_current_command}}'"),
        );
        assert_eq!(after.trim(), "cat", "{after}");

        // Ours to start, ours to clean up.
        observe(&p, &format!("tmux kill-session -t {session}"));
        let gone = observe(&p, &format!("tmux has-session -t {session} 2>&1 || true"));
        // Either answer means the same thing. If ours was the only session, the
        // tmux server itself has nothing left to do and exits with it.
        assert!(
            gone.contains("can't find session") || gone.contains("no server running"),
            "{gone}"
        );
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_session_started_by_something_else_is_joinable() {
        let Some(p) = there() else { return };
        let session = "aura-livetest-attach-existing";
        // Started over a *second* connection, not by the code under test: this
        // stands in for the CLI, yesterday's laptop, or a teammate. If attaching
        // only worked for sessions this window started, the whole list on screen
        // would be a lie the moment anyone else touched the box.
        observe(
            &p,
            &format!(
                "tmux new-session -d -s {session} -c \"$HOME\" 'cat' && \
                 tmux set-option -t {session} @aura_title 'started elsewhere'"
            ),
        );
        thread::sleep(Duration::from_secs(2));

        let out = over(
            &p.boot(&Open::Attach {
                session: session.into(),
                read_only: false,
            })
            .expect("a line"),
            &[
                // Inside the attached session, tmux answers with the session's
                // own name — proof we joined *that* one rather than being
                // handed a fresh shell that merely looks the same.
                "tmux display-message -p '#S'",
                // Leave without ending it: detach, not exit.
                "\x02d",
            ],
        );

        assert!(out.contains(session), "{out}");
        assert!(!out.contains("That session has ended"), "{out}");

        // The process it was running never noticed us come or go.
        let pane = observe(
            &p,
            &format!("tmux list-panes -t {session} -F '#{{pane_current_command}}'"),
        );
        assert_eq!(pane.trim(), "cat", "{pane}");

        observe(&p, &format!("tmux kill-session -t {session}"));
    }

    #[test]
    #[ignore = "needs a real box; set AURA_LIVE_MACHINE"]
    fn a_session_that_ended_says_so_and_leaves_a_shell() {
        let Some(p) = there() else { return };
        // The normal race, not a failure: the list is a moment old by the time
        // anyone clicks it. What must not happen is `tmux new -A` quietly
        // creating an empty session of that name and letting somebody believe
        // they are watching an agent.
        let session = "aura-livetest-attach-gone";
        observe(
            &p,
            &format!("tmux kill-session -t {session} 2>/dev/null || true"),
        );

        let out = over(
            &p.boot(&Open::Attach {
                session: session.into(),
                read_only: false,
            })
            .expect("a line"),
            &[KNOCK, "exit"],
        );

        assert!(out.contains("That session has ended"), "{out}");
        // And you are left somewhere useful — on the box, at a shell that
        // answers.
        assert!(out.contains(READY), "{out}");

        // Nothing was created by asking.
        let after = observe(&p, &format!("tmux has-session -t {session} 2>&1 || true"));
        assert!(
            after.contains("can't find session") || after.contains("no server running"),
            "{after}"
        );
    }

    #[test]
    #[ignore = "spawns a real shell on this laptop"]
    fn this_laptops_line_boots_a_shell_too() {
        // The parity claim, run rather than asserted about. Same verb, same
        // body, same tmux bargain — the only difference is which program the
        // line starts with, and that is the entire seam.
        let root = std::env::var("HOME").expect("a home directory");
        let session = "aura-livetest-here";
        let out = over(
            &Place::Here { root: root.clone() }
                .boot(&Open::Shell {
                    session: Some(session.into()),
                })
                .expect("a line"),
            &[
                KNOCK,
                "tmux display-message -p '#S' 2>/dev/null || echo NO-TMUX",
                "exit",
            ],
        );

        assert!(out.contains(READY), "{out}");
        assert!(
            out.contains(session) || out.contains("NO-TMUX"),
            "neither held by tmux nor honest about not having it: {out}"
        );
    }

    #[test]
    fn an_agents_flags_reach_it_as_flags() {
        // The launch composer's model and approvals ride on argv locally. On a
        // box the same argv has to survive being written into a line, and a
        // dropped `--model` is an agent that runs on the wrong one without ever
        // saying so.
        let out = command(
            &Open::Agent {
                bin: "claude".into(),
                args: vec![
                    "--model".into(),
                    "claude-opus-4-8".into(),
                    "--permission-mode".into(),
                    "bypassPermissions".into(),
                ],
                prompt: None,
                session: Some("aura-agent-naridon-claude".into()),
            },
            "/home/u/naridon",
            "",
            None,
        )
        .expect("an agent");
        assert!(
            out.contains(
                "exec tmux new -A -s 'aura-agent-naridon-claude' 'claude' '--model' \
                 'claude-opus-4-8' '--permission-mode' 'bypassPermissions'"
            ),
            "{out}"
        );
    }

    #[test]
    fn a_flag_carrying_a_second_command_is_quoted_not_run() {
        // `--append-system-prompt` and friends carry the user's own prose, which
        // is the one argument on the line most likely to contain a quote, a
        // semicolon or a backtick. Quoted per argument, none of them are the
        // shell's business.
        let out = command(
            &Open::Agent {
                bin: "claude".into(),
                args: vec!["--append-system-prompt".into(), "don't `id`; ok".into()],
                prompt: None,
                session: None,
            },
            "/p",
            "",
            None,
        )
        .expect("an agent");
        assert!(out.ends_with(&format!(
            "exec 'claude' '--append-system-prompt' {}",
            quote("don't `id`; ok")
        )), "{out}");
    }
}

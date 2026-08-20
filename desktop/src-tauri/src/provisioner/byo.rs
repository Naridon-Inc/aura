//! Bring-your-own provisioner.
//!
//! The user already owns the Linux box; Aura's only job is the one privileged
//! step that can't happen inside the box's own shell — minting a
//! runner-registry token on the signed-in cloud account so a fresh box can join
//! the user's board. Everything else (install `aura`, `claude setup-token`,
//! start the service) the wizard drives over the embedded SSH terminal.
//!
//! This is the refactored home of the logic that used to live inline in
//! `cmd_remote_connect::runner_provision`. It shells the bundled `aura` CLI
//! rather than re-implementing the cloud HTTP client, so the token is minted
//! through the exact same `recall_cloud_creds` path the CLI itself uses — one
//! source of truth for "who am I on the cloud".

use async_trait::async_trait;

use super::domain::{
    ProvisionError, ProvisionKind, ProvisionSpec, ProvisionedTarget, Result, TargetId,
    TargetStatus,
};
use super::Provisioner;

/// Provisioner for machines the user brings. Stateless — every target it hands
/// back is identified by its registry name, and each call shells the CLI fresh.
#[derive(Debug, Default, Clone)]
pub struct ByoProvider;

impl ByoProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Provisioner for ByoProvider {
    fn kind(&self) -> ProvisionKind {
        ProvisionKind::Byo
    }

    /// Always ready. There is nothing on this laptop to set up before somebody
    /// can bring their own box — the hardware is theirs and the address is
    /// typed into the wizard. What this arm still needs is a cloud account to
    /// mint the runner token against, and that is checked by
    /// [`Provisioner::provision`], which is the one step that needs it and the
    /// only one that can say whether the CLI found credentials. Answering "not
    /// ready" here for a signed-out account would hide the connect wizard from
    /// somebody one sign-in away from using it.
    fn readiness(&self) -> Result<()> {
        Ok(())
    }

    /// Mint a runner token on the signed-in cloud account for a brand-new box.
    ///
    /// Requires the user to be signed in to cloud — the underlying
    /// `aura runner register` reads `recall_cloud_creds`, the same store the
    /// desktop's `cloud_auth_*` commands use, and fails clearly if it's absent.
    async fn provision(&self, spec: ProvisionSpec) -> Result<ProvisionedTarget> {
        let name = spec.machine_name()?;

        let bin = crate::agent_event_listener::resolve_aura_bin();
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(register_argv(&name, spec.repo.as_deref()));
        // Force plain output so token parsing is ANSI-free regardless of the
        // child's colour heuristics (belt-and-braces with `colored`'s own
        // non-TTY auto-disable).
        cmd.env("NO_COLOR", "1");

        let out = cmd
            .output()
            .await
            .map_err(|e| ProvisionError::CliSpawn(format!("run aura runner register: {e}")))?;

        if !out.status.success() {
            return Err(register_failure(&String::from_utf8_lossy(&out.stderr)));
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        let token = parse_runner_token(&stdout).ok_or(ProvisionError::TokenNotFound)?;

        Ok(adopted(name, token))
    }

    /// Report the box's runner state via `aura runner status`.
    ///
    /// That CLI reports the box's OWN registry record and reads
    /// `AURA_RUNNER_TOKEN` from the environment — that is how the command is
    /// defined. We surface exactly that here, mapping its `●/○` line to a
    /// [`TargetStatus`]. From a desktop that doesn't carry the runner token the
    /// CLI says so and we return a typed [`ProvisionError::StatusUnavailable`];
    /// live board liveness for the wizard's "wait until online" step is polled
    /// by the frontend against the cloud board, not through this call. `id` is
    /// not a selector because the CLI scopes to the ambient token, not an
    /// arbitrary registry id.
    async fn status(&self, _id: &TargetId) -> Result<TargetStatus> {
        let bin = crate::agent_event_listener::resolve_aura_bin();
        let out = tokio::process::Command::new(&bin)
            .arg("runner")
            .arg("status")
            .env("NO_COLOR", "1")
            .output()
            .await
            .map_err(|e| ProvisionError::CliSpawn(format!("run aura runner status: {e}")))?;

        if !out.status.success() {
            return Err(status_failure(&String::from_utf8_lossy(&out.stderr)));
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        Ok(parse_status_line(&stdout))
    }

    /// A BYO box is the user's own hardware, and the runner registry has no
    /// remote-delete verb. Detaching = stopping `aura runner serve` on the box
    /// itself (the wizard does this over its SSH terminal). We refuse to pretend
    /// we can destroy a machine we don't own — a real product boundary, not a
    /// stub, expressed as a typed error.
    /// A box you brought is on your own account, and Aura holds no credential
    /// for it. There is nothing here to stop with — not "we chose not to", but
    /// "there is no such call to make" — so it is refused with the sentence that
    /// says which, rather than succeeding quietly and leaving a machine running
    /// that everything above believes is asleep.
    async fn sleep(&self, _id: &TargetId) -> Result<TargetStatus> {
        Err(ProvisionError::Unsupported(
            "This machine is yours, so Aura can't put it to sleep — it holds no account \
             that could stop it. Nothing is lost by walking away: the sessions on it are \
             still there when you come back. It just keeps costing its owner."
                .to_string(),
        ))
    }

    async fn wake(&self, _id: &TargetId) -> Result<String> {
        Err(ProvisionError::Unsupported(
            "This machine is yours, so Aura can't start it — it holds no account that \
             could. If it isn't answering, it needs turning on where it lives."
                .to_string(),
        ))
    }

    async fn teardown(&self, _id: &TargetId) -> Result<()> {
        Err(ProvisionError::Unsupported(
            "This machine is yours — stop the runner from the box itself (or the setup \
             terminal). Aura won't remotely tear down hardware you own."
                .to_string(),
        ))
    }
}

/// The argv handed to the bundled CLI to mint a token.
///
/// Split out so the shape can be asserted without a box to register against.
/// `--repo` is omitted rather than passed empty: the CLI treats an absent repo
/// as "this machine serves any project", and `--repo ""` as a project named
/// nothing, which registers a runner no project can ever match.
fn register_argv(name: &str, repo: Option<&str>) -> Vec<String> {
    let mut argv = vec![
        "runner".to_string(),
        "register".to_string(),
        "--name".to_string(),
        name.to_string(),
    ];
    if let Some(r) = repo.map(str::trim).filter(|s| !s.is_empty()) {
        argv.push("--repo".to_string());
        argv.push(r.to_string());
    }
    argv
}

/// What the user is told when `aura runner register` refuses.
///
/// The CLI's own words are kept — it is the half that knows whether the problem
/// was the network, the account or the name — and only prefixed, so the message
/// says which step failed. A silent CLI gets the one cause worth guessing at,
/// because "not signed in to cloud" is what an empty stderr here almost always
/// means.
fn register_failure(stderr: &str) -> ProvisionError {
    let msg = stderr.trim();
    ProvisionError::CliFailed(if msg.is_empty() {
        "Couldn't register the machine — are you signed in to cloud?".to_string()
    } else {
        format!("Couldn't register the machine: {msg}")
    })
}

/// What the user is told when `aura runner status` refuses.
///
/// Typed apart from [`register_failure`] because the caller acts on it
/// differently: a failed registration means there is no machine, a failed status
/// means there may well be one and we simply cannot see it from here.
fn status_failure(stderr: &str) -> ProvisionError {
    let msg = stderr.trim();
    ProvisionError::StatusUnavailable(if msg.is_empty() {
        "Couldn't read the machine's status — is it registered?".to_string()
    } else {
        msg.to_string()
    })
}

/// The board row for a box that now has a token but has not yet reported in.
///
/// [`TargetStatus::Provisioning`], not `Online`: the token is minted, and the
/// user still has to run the setup steps on the box before anything answers.
/// Claiming online here would put a machine in the picker that every later call
/// fails against.
fn adopted(name: String, token: String) -> ProvisionedTarget {
    ProvisionedTarget {
        id: TargetId(name.clone()),
        kind: ProvisionKind::Byo,
        name,
        runner_token: Some(token),
        // The user typed this box's address into the wizard before we were
        // called, and it is already on its way to the machine book. Reporting
        // our own copy of it here would be a second opinion about one box.
        address: None,
        status: TargetStatus::Provisioning,
    }
}

/// Pull the runner token out of `aura runner register`'s human output. The CLI
/// prints it twice — standalone under "shown only once", and in the
/// `export AURA_RUNNER_TOKEN=<tok>` hint. We key off the export line since its
/// shape is unambiguous, falling back to the first non-empty line after the
/// "shown only once" note.
fn parse_runner_token(stdout: &str) -> Option<String> {
    // Preferred: the `export AURA_RUNNER_TOKEN=<tok>` line (indentation varies,
    // so trim first).
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix("export AURA_RUNNER_TOKEN=") {
            let tok = rest.trim();
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    // Fallback: the first non-empty line after the "shown only once" marker.
    let mut lines = stdout.lines();
    while let Some(l) = lines.next() {
        if l.contains("shown only once") {
            for next in lines.by_ref() {
                let tok = next.trim();
                if !tok.is_empty() {
                    return Some(tok.to_string());
                }
            }
        }
    }
    None
}

/// Map `aura runner status`'s one-line output (`● name · running · task`) to a
/// coarse [`TargetStatus`]. The leading glyph is the authoritative online flag;
/// with `NO_COLOR=1` it is a plain `●`/`○`. If the glyph is absent we fall back
/// to the status word between the first pair of `·` separators.
fn parse_status_line(stdout: &str) -> TargetStatus {
    let line = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.contains('●') {
        return TargetStatus::Online;
    }
    if line.contains('○') {
        return TargetStatus::Offline;
    }
    match line.split('·').nth(1).map(str::trim).unwrap_or("") {
        "online" | "running" | "busy" => TargetStatus::Online,
        "offline" => TargetStatus::Offline,
        _ => TargetStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, repo: Option<&str>) -> ProvisionSpec {
        ProvisionSpec {
            kind: ProvisionKind::Byo,
            name: name.into(),
            repo: repo.map(str::to_string),
            class: None,
        }
    }

    // -----------------------------------------------------------------------
    // The name a box answers to
    // -----------------------------------------------------------------------

    #[test]
    fn a_typed_name_is_trimmed_before_it_becomes_an_identity() {
        // The wizard's field is typed into, and the same string is later what
        // the board is polled for by name. Registered with the space and polled
        // without it, the box comes online and the wizard waits forever.
        assert_eq!(spec("  home-server  ", None).machine_name().unwrap(), "home-server");
    }

    #[test]
    fn an_unnamed_box_is_refused_rather_than_named_for_the_user() {
        // A generated name would be the friendlier-looking choice and the worse
        // one: the picker fills with boxes nobody can tell apart, and the row
        // the user meant is unfindable.
        for typed in ["", "   ", "\t\n"] {
            let refused = spec(typed, None).machine_name();
            assert!(matches!(refused, Err(ProvisionError::MissingName)), "{typed:?}");
        }
        assert_eq!(
            ProvisionError::MissingName.to_string(),
            "Give the machine a name first."
        );
    }

    // -----------------------------------------------------------------------
    // The line the CLI is asked to run
    // -----------------------------------------------------------------------

    #[test]
    fn a_machine_with_no_repo_drains_every_project() {
        assert_eq!(
            register_argv("home-server", None),
            ["runner", "register", "--name", "home-server"]
        );
    }

    #[test]
    fn a_repo_scoped_machine_names_its_repo() {
        assert_eq!(
            register_argv("ci-box", Some("MHASK/aura-sovereign")),
            [
                "runner",
                "register",
                "--name",
                "ci-box",
                "--repo",
                "MHASK/aura-sovereign",
            ]
        );
    }

    #[test]
    fn an_empty_repo_is_no_repo_at_all_not_a_repo_named_nothing() {
        // `--repo ""` registers a runner scoped to a project that does not
        // exist, so it joins the board and then drains nothing — which looks
        // exactly like a broken box rather than a mis-scoped one.
        for empty in ["", "   "] {
            assert_eq!(
                register_argv("box", Some(empty)),
                ["runner", "register", "--name", "box"],
                "{empty:?}"
            );
        }
        assert_eq!(
            register_argv("box", Some("  MHASK/aura  ")),
            ["runner", "register", "--name", "box", "--repo", "MHASK/aura"]
        );
    }

    #[test]
    fn a_name_is_one_argument_however_it_is_spelled() {
        // The same claim the parity gate makes about ssh, made here: this is an
        // argv handed to a process, never a string handed to a shell. A name
        // with a semicolon in it is a silly name, not a command.
        let argv = register_argv("my box; rm -rf /", None);
        assert_eq!(argv.last().unwrap(), "my box; rm -rf /");
        assert_eq!(argv.len(), 4);
    }

    // -----------------------------------------------------------------------
    // What the user is told when it fails
    // -----------------------------------------------------------------------

    #[test]
    fn a_failure_keeps_the_clis_own_words_and_says_which_step_failed() {
        let told = register_failure("error: no cloud credentials found\n").to_string();
        assert!(told.contains("Couldn't register the machine"), "{told}");
        assert!(told.contains("no cloud credentials found"), "{told}");
    }

    #[test]
    fn a_silent_failure_still_names_the_likeliest_cause() {
        // An empty stderr is nearly always "not signed in", and a bare
        // "something went wrong" leaves the user with nothing to do next.
        let told = register_failure("   \n").to_string();
        assert!(told.contains("signed in to cloud"), "{told}");
    }

    #[test]
    fn failing_to_register_and_failing_to_look_are_different_answers() {
        // A failed registration means there is no machine. A failed status
        // means there may well be one and we cannot see it from this laptop —
        // the wizard must not offer to re-register a box that already exists.
        assert!(matches!(register_failure("x"), ProvisionError::CliFailed(_)));
        assert!(matches!(
            status_failure("x"),
            ProvisionError::StatusUnavailable(_)
        ));
        // Status passes the CLI's words through unprefixed: it is the half that
        // knows whether the token was missing or the box simply never answered.
        assert_eq!(status_failure("  no runner token in this shell\n").to_string(), "no runner token in this shell");
        assert!(status_failure("").to_string().contains("is it registered?"));
    }

    // -----------------------------------------------------------------------
    // The row handed back
    // -----------------------------------------------------------------------

    #[test]
    fn a_fresh_box_is_provisioning_not_online() {
        // Claiming online here would put a machine in the picker before the
        // user has run a single setup step on it, and every call against it
        // would fail until they did.
        let t = adopted("home-server".to_string(), "rk_live_ABC".to_string());
        assert_eq!(t.status, TargetStatus::Provisioning);
        assert_eq!(t.kind, ProvisionKind::Byo);
        assert_eq!(t.id, TargetId("home-server".into()));
        assert_eq!(t.name, "home-server");
        assert_eq!(t.runner_token.as_deref(), Some("rk_live_ABC"));
    }

    // -----------------------------------------------------------------------
    // The operations that need no box to answer
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn it_is_the_byo_backend_and_says_so() {
        assert_eq!(ByoProvider::new().kind(), ProvisionKind::Byo);
    }

    #[tokio::test]
    async fn an_unnamed_box_is_refused_before_anything_is_launched() {
        // The check is first in `provision` on purpose: no CLI is resolved, no
        // process is spawned, and the user gets the one sentence that fixes it.
        let refused = ByoProvider::new().provision(spec("   ", None)).await;
        assert!(matches!(refused, Err(ProvisionError::MissingName)));
    }

    #[tokio::test]
    async fn aura_will_not_tear_down_hardware_you_own() {
        // A product boundary stated as a typed error, not a silent success and
        // not a stub: the box is the user's, and stopping the runner is
        // something they do on it. A caller that treats this as "done" would
        // remove the row while the runner kept draining work.
        let refused = ByoProvider::new()
            .teardown(&TargetId("home-server".into()))
            .await;
        let ProvisionError::Unsupported(why) = refused.unwrap_err() else {
            panic!("tearing down a BYO box must be Unsupported, with a reason");
        };
        assert!(why.contains("stop the runner"), "{why}");
    }

    #[test]
    fn parses_export_line() {
        let out = "\u{2713} runner box-1 registered\n\nSave this token — it is shown only once:\n\n  rk_live_ABC123\n\nOn the runner box, export it and start serving:\n  export AURA_RUNNER_TOKEN=rk_live_ABC123\n  aura runner serve\n";
        assert_eq!(parse_runner_token(out).as_deref(), Some("rk_live_ABC123"));
    }

    #[test]
    fn falls_back_to_standalone_line() {
        // No export hint — only the "shown only once" standalone token.
        let out = "Save this token — it is shown only once:\n\n  rk_live_XYZ789\n";
        assert_eq!(parse_runner_token(out).as_deref(), Some("rk_live_XYZ789"));
    }

    #[test]
    fn none_when_absent() {
        assert_eq!(parse_runner_token("nothing here\n"), None);
    }

    #[test]
    fn status_line_online_and_offline() {
        assert_eq!(
            parse_status_line("● home-server · running · idle\n"),
            TargetStatus::Online
        );
        assert_eq!(
            parse_status_line("○ home-server · offline · idle\n"),
            TargetStatus::Offline
        );
    }

    #[test]
    fn status_line_word_fallback_when_no_glyph() {
        assert_eq!(
            parse_status_line("home-server · online · task-42\n"),
            TargetStatus::Online
        );
        assert_eq!(parse_status_line("garbage\n"), TargetStatus::Unknown);
    }
}

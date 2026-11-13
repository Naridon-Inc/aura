//! The scripts that keep an agent's conversation alive on a machine after the
//! laptop that started it has gone away.
//!
//! A chat with an agent on a box is a long-lived process speaking a protocol
//! over stdin and stdout. Run it as the child of an `ssh`, and closing the lid
//! ends the conversation mid-sentence. So the agent is never anyone's child:
//!
//! - it runs in its own tmux server (`-L aura-chat`), apart from the terminals
//!   and from anything the machine's runner service started, so nothing the
//!   runner holds in its environment is inherited by a member's agent;
//! - its stdin is a fifo it opens read-write itself, so there is always a
//!   writer and an attach that drops is never end-of-file to the agent;
//! - its stdout is appended to a log, so what it said while nobody was attached
//!   is still there to read, and an offset into that log names one line
//!   exactly.
//!
//! An attach writes into the fifo and reads the log from the byte offset the
//! laptop last saw, so reconnecting after a drop loses nothing and repeats
//! nothing. The protocol on top (ACP) is not this module's business: it moves
//! bytes, and the offsets are what make the bytes resumable.
//!
//! When the chat runs on a member's own sign-in, the machine asks the cloud for
//! it at start, with the machine's own runner token, for one lease the member
//! minted. The answer is turned into environment variables of the agent process
//! and never written to a file: not on this laptop, which never sees it, and
//! not on the machine.

use super::script::{is_abs_path, is_bin_name, is_home_rel_path, is_session_name, quote};

/// The tmux server every chat lives in, apart from the default one.
pub const SOCKET: &str = "aura-chat";

/// Where a machine's runner keeps the token it proves itself with.
pub const RUNNER_ENV: &str = "/etc/aura-runner/runner.env";

/// Where a machine set up without sudo keeps it instead: in the home of the
/// account it runs as, with the token alone and no cloud named.
pub const OWN_RUNNER_ENV: &str = ".config/aura/runner.env";

/// The exit codes the run script uses for its own refusals, so the laptop can
/// say which one happened instead of "the agent exited".
pub const EXIT_NO_DIR: i32 = 40;
pub const EXIT_NO_SIGN_IN: i32 = 41;
pub const EXIT_NO_RUNNER: i32 = 42;

/// A chat's name on the machine: what its directory and tmux session are
/// called. A workspace id fits.
pub fn is_key(key: &str) -> bool {
    key.len() <= 64 && is_session_name(key)
}

fn session(key: &str) -> String {
    format!("aura-chat-{key}")
}

fn dir_line(key: &str) -> String {
    format!("d=\"$HOME/.aura/chat/{key}\"")
}

/// The member's own sign-in, fetched by the machine at start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignIn {
    /// The machine's place id: the runner the cloud knows it as.
    pub place: String,
    /// The member the agent acts for.
    pub member: String,
    /// The single-use lease the member minted for this chat.
    pub lease: String,
    /// The workspace the lease is bound to.
    pub workspace: String,
    /// Which agent's sign-in: `claude`, `codex`, …
    pub harness: String,
    /// Where the machine's runner token is.
    pub token_file: String,
    /// The cloud this laptop minted the lease on, asked when the machine's
    /// runner file names none. Empty when the laptop is pointed somewhere other
    /// than where it signed in, so a runner token is never sent to that host.
    pub cloud: String,
}

/// One agent to start and keep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub key: String,
    /// The worktree the agent works in: absolute, or `~/…`.
    pub cwd: String,
    /// The agent's command line. The first word may start with `~/`.
    pub argv: Vec<String>,
    pub sign_in: Option<SignIn>,
}

fn is_uuid(v: &str) -> bool {
    uuid::Uuid::parse_str(v).is_ok()
}

fn is_harness(v: &str) -> bool {
    !v.is_empty() && v.len() <= 16 && v.chars().all(|c| c.is_ascii_lowercase())
}

/// A path the far side's shell expands `~/` in, and nothing else.
fn box_path(p: &str) -> Result<String, String> {
    if let Some(rest) = p.strip_prefix("~/") {
        if is_home_rel_path(rest) {
            return Ok(format!("\"$HOME\"/{}", quote(rest)));
        }
    } else if is_abs_path(p) {
        return Ok(quote(p));
    }
    Err(format!("{p} is not a path on the machine"))
}

fn check(l: &Launch) -> Result<(), String> {
    if !is_key(&l.key) {
        return Err("a chat is named by letters, digits and dashes".into());
    }
    if l.argv.is_empty() || l.argv.iter().any(|a| a.contains('\0') || a.contains('\n')) {
        return Err("the agent's command line is empty or has a line break in it".into());
    }
    if let Some(s) = &l.sign_in {
        if ![&s.place, &s.member, &s.lease, &s.workspace].iter().all(|v| is_uuid(v)) {
            return Err("a sign-in is bound by ids, and one of them is not an id".into());
        }
        if !is_harness(&s.harness) || !is_abs_path(&s.token_file) {
            return Err("that sign-in does not name an agent and a token file".into());
        }
        if !s.cloud.is_empty() && !is_cloud(&s.cloud) {
            return Err("that sign-in names a cloud that is not a web address".into());
        }
    }
    Ok(())
}

/// Python, run on the machine, that turns the cloud's answer into `unset` and
/// `export` lines. Single quotes never appear in it: it travels inside them.
const TO_ENV: &str = r#"import json,sys,shlex
raw=sys.stdin.read()
body,_,code=raw.rpartition("\n")
try:
    a=json.loads(body)
except Exception:
    a={}
if code.strip()!="200":
    sys.stderr.write("aura: the cloud would not hand this chat a sign-in (%s): %s\n" % (a.get("reason") or "http "+code.strip(), a.get("detail") or ""))
    sys.exit(41)
ok=lambda n: isinstance(n,str) and n.isascii() and n.replace("_","a").isalnum() and not n[:1].isdigit()
out=["unset "+n for n in a.get("clear",[]) if ok(n)]
out+=["export %s=%s" % (k,shlex.quote(v)) for k,v in sorted(a.get("env",{}).items()) if ok(k) and isinstance(v,str)]
print("\n".join(out))"#;

/// One `KEY=value` out of a systemd environment file, quotes stripped, printed
/// to stdout and nowhere else.
fn read_env_line(var: &str, file: &str, sudo: bool) -> String {
    format!(
        "{}awk -v K={var} 'index($0,K\"=\")==1{{v=substr($0,length(K)+2); gsub(/^[\"\\047]|[\"\\047]$/,\"\",v); print v; exit}}' {file} 2>/dev/null",
        if sudo { "sudo -n " } else { "" }
    )
}

/// An https or http origin and nothing a shell could read as more than that.
fn is_cloud(url: &str) -> bool {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    rest.is_some_and(|r| {
        !r.is_empty()
            && r.len() <= 200
            && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '/' | '_'))
    })
}

fn sign_in_block(s: &SignIn) -> String {
    let url = format!(
        // One double-quoted word: unquoted, the shell reads each `&` as "run in
        // the background" and curl asks with `harness=` alone.
        "\"$url/api/v2/places/{}/agent-env?harness={}&chat={}&workspace={}\"",
        s.place, s.harness, s.lease, s.workspace
    );
    [
        // The box-wide file first: it is the runner these chats have always
        // signed in through. A machine set up without sudo has only its own.
        format!("tok=$({})", read_env_line("AURA_RUNNER_TOKEN", &quote(&s.token_file), true)),
        format!("url=$({})", read_env_line("AURA_CLOUD_URL", &quote(&s.token_file), true)),
        format!(
            "if [ -z \"$tok\" ]; then tok=$({}); url=$({}); fi",
            read_env_line("AURA_RUNNER_TOKEN", &format!("\"$HOME/{OWN_RUNNER_ENV}\""), false),
            read_env_line("AURA_CLOUD_URL", &format!("\"$HOME/{OWN_RUNNER_ENV}\""), false)
        ),
        if s.cloud.is_empty() {
            ":".to_string()
        } else {
            format!("if [ -z \"$url\" ]; then url={}; fi", quote(&s.cloud))
        },
        format!(
            "if [ -z \"$tok\" ] || [ -z \"$url\" ]; then echo 'aura: this machine has no runner token to ask for a sign-in with' >&2; exit {EXIT_NO_RUNNER}; fi"
        ),
        // The token goes to curl on stdin, never in argv where `ps` shows it.
        format!(
            "got=$(printf 'Authorization: Bearer %s\\nX-Aura-Acting-Member: %s\\n' \"$tok\" {} | curl -sS -m 20 -H @- -w '\\n%{{http_code}}' {url})",
            s.member
        ),
        "unset tok".into(),
        format!("envs=$(printf '%s' \"$got\" | python3 -I -c {}) || exit {EXIT_NO_SIGN_IN}", quote(TO_ENV)),
        "unset got".into(),
        "eval \"$envs\"".into(),
        "unset envs".into(),
    ]
    .join("\n")
}

/// What runs inside the chat's tmux session.
pub fn run_script(l: &Launch) -> Result<String, String> {
    check(l)?;
    let mut argv = Vec::with_capacity(l.argv.len());
    for (i, a) in l.argv.iter().enumerate() {
        argv.push(if i == 0 && a.starts_with("~/") { box_path(a)? } else { quote(a) });
    }
    let mut lines = vec![
        "#!/bin/sh".to_string(),
        dir_line(&l.key),
        "exec 2>>\"$d/err.log\"".into(),
        ": >\"$d/exit\"".into(),
        "trap 'echo $? >\"$d/exit\"' EXIT".into(),
        // Read-write: the agent holds its own writer, so no attach ever ends it.
        "exec 3<>\"$d/in\"".into(),
        "unset AURA_RUNNER_TOKEN AURA_CLOUD_TOKEN".into(),
    ];
    if let Some(s) = &l.sign_in {
        lines.push(sign_in_block(s));
    }
    lines.push(format!("cd {} || exit {EXIT_NO_DIR}", box_path(&l.cwd)?));
    lines.push(format!("{} <&3 >>\"$d/out.log\"", argv.join(" ")));
    Ok(lines.join("\n") + "\n")
}

/// Make the chat's directory, fifo and log, and start the agent unless it is
/// already running. Prints `already`, or `started <offset>` where the new
/// agent's first byte will land in the log.
pub fn start(l: &Launch) -> Result<String, String> {
    let run = run_script(l)?;
    let name = session(&l.key);
    Ok([
        "set -e".to_string(),
        dir_line(&l.key),
        "mkdir -p \"$d\"".into(),
        "chmod 700 \"$d\"".into(),
        "[ -p \"$d/in\" ] || mkfifo -m 600 \"$d/in\"".into(),
        ": >>\"$d/out.log\"".into(),
        "chmod 600 \"$d/out.log\"".into(),
        format!("if tmux -L {SOCKET} has-session -t ={name} 2>/dev/null; then echo already; exit 0; fi"),
        format!("printf '%s' {} >\"$d/run.sh\"", quote(&run)),
        "at=$(stat -c %s \"$d/out.log\")".into(),
        format!("tmux -L {SOCKET} new-session -d -s {name} -x 200 -y 50 \"sh '$d/run.sh'\""),
        "echo \"started $at\"".into(),
    ]
    .join("\n"))
}

/// Feed this connection's stdin to the agent and stream its log from `from`, a
/// byte offset. A chat whose agent has stopped gets the rest of its log and an
/// exit code of 4, so a reader can tell "ended" from "dropped".
pub fn attach(key: &str, from: u64) -> Result<String, String> {
    if !is_key(key) {
        return Err("a chat is named by letters, digits and dashes".into());
    }
    let start = from + 1;
    let name = session(key);
    Ok([
        dir_line(key),
        format!("[ -p \"$d/in\" ] || {{ echo 'aura: there is no chat {key} on this machine' >&2; exit 3; }}"),
        format!(
            "if ! tmux -L {SOCKET} has-session -t ={name} 2>/dev/null; then tail -c +{start} \"$d/out.log\"; exit 4; fi"
        ),
        format!("tail -c +{start} -F \"$d/out.log\" 2>/dev/null & t=$!"),
        "trap 'kill $t 2>/dev/null' EXIT HUP INT TERM".into(),
        "cat >\"$d/in\"".into(),
    ]
    .join("\n"))
}

/// Print the absolute path `p` names on the machine. The agent protocol takes a
/// working directory as an absolute path and expands no `~`.
pub fn absolute(p: &str) -> Result<String, String> {
    Ok(format!("cd {} && pwd", box_path(p)?))
}

/// Print the path of the agent adapter the machine has for `agent`: the newest
/// version Aura installed under `~/.aura/acp/agents/<agent>/`, else one on
/// `PATH`, trying each name in `bins` in order. Prints nothing and exits 3 when
/// the machine has none of them.
pub fn find_agent(agent: &str, bins: &[&str]) -> Result<String, String> {
    if !is_bin_name(agent) || bins.is_empty() || !bins.iter().all(|b| is_bin_name(b)) {
        return Err(format!("{agent} is not an agent name"));
    }
    let names = bins.iter().map(|b| quote(b)).collect::<Vec<_>>().join(" ");
    Ok(format!(
        "for b in {names}; do p=$(ls -1d \"$HOME\"/.aura/acp/agents/{a}/*/node_modules/.bin/\"$b\" 2>/dev/null | sort -V | tail -n 1); \
         if [ -n \"$p\" ]; then printf '%s\\n' \"$p\"; exit 0; fi; done; \
         for b in {names}; do if command -v \"$b\"; then exit 0; fi; done; exit 3",
        a = quote(agent),
    ))
}

/// One line about the chat, plus the last things it said on stderr.
pub fn status(key: &str) -> Result<String, String> {
    if !is_key(key) {
        return Err("a chat is named by letters, digits and dashes".into());
    }
    let name = session(key);
    Ok([
        dir_line(key),
        "a=0".to_string(),
        format!("tmux -L {SOCKET} has-session -t ={name} 2>/dev/null && a=1"),
        "s=$(stat -c %s \"$d/out.log\" 2>/dev/null || echo -1)".into(),
        "e=$(cat \"$d/exit\" 2>/dev/null || true)".into(),
        "printf 'alive=%s size=%s exit=%s\\n' \"$a\" \"$s\" \"$e\"".into(),
        "tail -n 5 \"$d/err.log\" 2>/dev/null | sed 's/^/err: /' || true".into(),
    ]
    .join("\n"))
}

/// The last `bytes` of what the agent said. The first line may be cut short,
/// and a chat with no log reads as nothing.
pub fn tail(key: &str, bytes: u64) -> Result<String, String> {
    if !is_key(key) {
        return Err("a chat is named by letters, digits and dashes".into());
    }
    Ok([dir_line(key), format!("tail -c {bytes} \"$d/out.log\" 2>/dev/null || true")].join("\n"))
}

/// End the agent. The log stays, so the conversation can still be read.
pub fn stop(key: &str) -> Result<String, String> {
    if !is_key(key) {
        return Err("a chat is named by letters, digits and dashes".into());
    }
    Ok(format!(
        "tmux -L {SOCKET} kill-session -t ={} 2>/dev/null || true\necho stopped",
        session(key)
    ))
}

/// What a machine said about one chat.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The agent is running.
    pub alive: bool,
    /// Bytes in its log, or `None` when the machine has no such chat.
    pub size: Option<u64>,
    /// How it ended, once it has.
    pub exit: Option<i32>,
    /// The last lines it wrote to stderr.
    pub errors: Vec<String>,
}

pub fn parse_status(out: &str) -> Status {
    let mut st = Status::default();
    for line in out.lines() {
        if let Some(e) = line.strip_prefix("err: ") {
            st.errors.push(e.to_string());
            continue;
        }
        for field in line.split_whitespace() {
            match field.split_once('=') {
                Some(("alive", v)) => st.alive = v == "1",
                Some(("size", v)) => st.size = v.parse().ok(),
                Some(("exit", v)) => st.exit = v.parse().ok(),
                _ => {}
            }
        }
    }
    st
}

/// What `start` said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "offset", rename_all = "camelCase")]
pub enum Started {
    /// It was already running; attach where you left off.
    Already,
    /// A new agent; its output begins at this offset.
    At(u64),
}

pub fn parse_started(out: &str) -> Option<Started> {
    let line = out.lines().map(str::trim).rfind(|l| !l.is_empty())?;
    if line == "already" {
        return Some(Started::Already);
    }
    line.strip_prefix("started ")?.trim().parse().ok().map(Started::At)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> String {
        format!("00000000-0000-4000-8000-0000000000{n:02}")
    }

    fn launch(sign_in: bool) -> Launch {
        Launch {
            key: id(1),
            cwd: "~/aura-sovereign-chat".into(),
            argv: vec!["~/.aura/acp/agents/claude-acp/0.103.0/node_modules/.bin/claude-agent-acp".into()],
            sign_in: sign_in.then(|| SignIn {
                place: id(2),
                member: id(3),
                lease: id(4),
                workspace: id(1),
                harness: "claude".into(),
                token_file: RUNNER_ENV.into(),
                cloud: "https://cloud.example".into(),
            }),
        }
    }

    #[test]
    fn the_agent_holds_its_own_writer_and_appends_to_its_log() {
        let run = run_script(&launch(false)).unwrap();
        let open = run.find("exec 3<>\"$d/in\"").unwrap();
        let agent = run.find("<&3 >>\"$d/out.log\"").unwrap();
        assert!(open < agent);
        assert!(run.contains("\"$HOME\"/'.aura/acp/agents/claude-acp/0.103.0/node_modules/.bin/claude-agent-acp'"));
        assert!(run.contains("cd \"$HOME\"/'aura-sovereign-chat' || exit 40"));
    }

    #[test]
    fn the_runners_own_tokens_never_reach_the_agent() {
        let run = run_script(&launch(true)).unwrap();
        let unset = run.find("unset AURA_RUNNER_TOKEN AURA_CLOUD_TOKEN").unwrap();
        assert!(unset < run.find("<&3").unwrap());
        assert!(run.find("unset tok").unwrap() < run.find("eval \"$envs\"").unwrap());
    }

    #[test]
    fn the_token_travels_on_stdin_and_the_sign_in_never_touches_disk() {
        let run = run_script(&launch(true)).unwrap();
        assert!(run.contains("curl -sS -m 20 -H @-"));
        assert!(run.contains("printf 'Authorization: Bearer %s"));
        // Nothing the cloud answered is redirected into a file.
        for line in run.lines().filter(|l| l.contains("$got") || l.contains("$envs")) {
            assert!(!line.contains('>') || line.contains("2>"), "{line}");
        }
        assert!(run.contains(&format!("chat={}&workspace={}", id(4), id(1))));
        assert!(run.contains(&format!("X-Aura-Acting-Member: %s\\n' \"$tok\" {}", id(3))));
    }

    #[test]
    fn the_whole_ask_reaches_curl_as_one_word() {
        let run = run_script(&launch(true)).unwrap();
        let ask = run.lines().find(|l| l.starts_with("got=$(")).unwrap();
        let script = format!(
            "curl() {{ for a; do last=$a; done; printf '%s' \"$last\"; }}\nurl=https://cloud.example\ntok=t\n{ask}\nprintf '%s' \"$got\""
        );
        let out = std::process::Command::new("sh").arg("-c").arg(&script).output().unwrap();
        let got = String::from_utf8(out.stdout).unwrap();
        assert_eq!(
            got,
            format!(
                "https://cloud.example/api/v2/places/{}/agent-env?harness=claude&chat={}&workspace={}",
                id(2),
                id(4),
                id(1)
            )
        );
    }

    /// Runs the lines that find the token, on a machine where `sudo` refuses
    /// and the account's home holds `home_file`, and says what they found.
    fn found(l: &Launch, home_file: Option<&str>) -> (String, i32) {
        let run = run_script(l).unwrap();
        let start = run.find("tok=$(").unwrap();
        let end = run.find("got=$(").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".config/aura")).unwrap();
        if let Some(body) = home_file {
            std::fs::write(home.join(OWN_RUNNER_ENV), body).unwrap();
        }
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let sudo = bin.join("sudo");
        std::fs::write(&sudo, "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n").unwrap();
        let mut perm = std::fs::metadata(&sudo).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perm, 0o755);
        std::fs::set_permissions(&sudo, perm).unwrap();
        let script = format!("{}\nprintf '%s|%s' \"$tok\" \"$url\"", &run[start..end]);
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .env("HOME", &home)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .output()
            .unwrap();
        (String::from_utf8(out.stdout).unwrap(), out.status.code().unwrap_or(-1))
    }

    #[test]
    fn a_machine_set_up_without_sudo_signs_in_with_its_own_token() {
        let (got, code) = found(&launch(true), Some("AURA_RUNNER_TOKEN='own-token'\n"));
        assert_eq!((got.as_str(), code), ("own-token|https://cloud.example", 0));
    }

    #[test]
    fn a_cloud_named_in_the_machines_file_wins_over_the_laptops() {
        let (got, _) = found(&launch(true), Some("AURA_RUNNER_TOKEN=t\nAURA_CLOUD_URL=https://own.example\n"));
        assert_eq!(got, "t|https://own.example");
    }

    #[test]
    fn a_machine_with_no_token_anywhere_says_so() {
        let (_, code) = found(&launch(true), None);
        assert_eq!(code, EXIT_NO_RUNNER);
        let mut l = launch(true);
        l.sign_in.as_mut().unwrap().cloud = String::new();
        let (_, code) = found(&l, Some("AURA_RUNNER_TOKEN=t\n"));
        assert_eq!(code, EXIT_NO_RUNNER, "no cloud named and none from the laptop");
    }

    #[test]
    fn a_cloud_that_could_run_as_shell_is_refused() {
        let mut l = launch(true);
        l.sign_in.as_mut().unwrap().cloud = "https://x.example$(reboot)".into();
        assert!(run_script(&l).is_err());
    }

    #[test]
    fn a_launch_that_is_not_ids_and_paths_is_refused() {
        let mut l = launch(true);
        l.sign_in.as_mut().unwrap().lease = "$(reboot)".into();
        assert!(run_script(&l).is_err());
        let mut l = launch(false);
        l.key = "a;b".into();
        assert!(start(&l).is_err());
        let mut l = launch(false);
        l.cwd = "../etc".into();
        assert!(run_script(&l).is_err());
        let mut l = launch(false);
        l.argv.clear();
        assert!(run_script(&l).is_err());
        assert!(attach("x y", 0).is_err());
    }

    #[test]
    fn the_converter_travels_inside_single_quotes() {
        assert!(!TO_ENV.contains('\''));
    }

    #[test]
    fn a_chat_lives_on_its_own_tmux_server() {
        let s = start(&launch(false)).unwrap();
        assert!(s.contains(&format!("tmux -L aura-chat has-session -t =aura-chat-{}", id(1))));
        assert!(s.contains("tmux -L aura-chat new-session -d -s aura-chat-"));
        assert!(stop(&id(1)).unwrap().contains("-L aura-chat kill-session"));
    }

    #[test]
    fn an_attach_resumes_at_the_byte_after_the_last_one_seen() {
        let a = attach(&id(1), 0).unwrap();
        assert!(a.contains("tail -c +1 -F"));
        let a = attach(&id(1), 4096).unwrap();
        assert!(a.contains("tail -c +4097 -F"));
        assert!(a.contains("exit 4"));
        assert!(a.ends_with("cat >\"$d/in\""));
    }

    #[test]
    fn a_folder_is_resolved_on_the_machine_and_nothing_else_runs() {
        assert_eq!(absolute("~/aura-feat-x").unwrap(), "cd \"$HOME\"/'aura-feat-x' && pwd");
        assert!(absolute("/srv/w").unwrap().starts_with("cd '/srv/w'"));
        assert!(absolute("../etc").is_err());
        assert!(absolute("~/a; rm").map_or(true, |s| !s.contains("; rm &&")));
    }

    #[test]
    fn an_agent_is_found_where_aura_put_it_before_anywhere_on_path() {
        let s = find_agent("claude-acp", &["claude-agent-acp", "claude-code-acp"]).unwrap();
        let installed = s.find("/.aura/acp/agents/'claude-acp'/*/node_modules/.bin/").unwrap();
        assert!(installed < s.find("command -v").unwrap());
        assert!(s.contains("sort -V | tail -n 1"));
        assert!(s.contains("for b in 'claude-agent-acp' 'claude-code-acp'"));
        assert!(find_agent("claude-acp", &["x; reboot"]).is_err());
        assert!(find_agent("../x", &["claude"]).is_err());
        assert!(find_agent("claude-acp", &[]).is_err());
    }

    #[test]
    fn status_and_start_are_read_back() {
        let st = parse_status("alive=1 size=812 exit=\nerr: warming up\n");
        assert_eq!(st, Status { alive: true, size: Some(812), exit: None, errors: vec!["warming up".into()] });
        let st = parse_status("alive=0 size=-1 exit=41\n");
        assert_eq!((st.alive, st.size, st.exit), (false, None, Some(41)));
        assert_eq!(parse_started("started 120\n"), Some(Started::At(120)));
        assert_eq!(parse_started("already\n"), Some(Started::Already));
        assert_eq!(parse_started("nonsense"), None);
    }

    #[test]
    fn the_end_of_a_log_is_read_once_and_never_followed() {
        let t = tail("ws-1", 4096).unwrap();
        assert!(t.contains("tail -c 4096 \"$d/out.log\""), "{t}");
        assert!(!t.contains("-F"), "a read, not an attach");
        assert!(tail("ws 1", 10).is_err());
    }
}

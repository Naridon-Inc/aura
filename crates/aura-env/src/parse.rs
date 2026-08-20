//! `.aura/settings.toml` → [`EnvSpec`].
//!
//! ## Two parsers, on purpose
//!
//! The `[worktree]` scripts were read by a hand-rolled line scanner, which the
//! comment above it defended as not worth a TOML dependency for three string
//! keys. That was true, and it had a side effect nobody designed: the scanner
//! accepts things TOML does not. `setup = make build # warm it up` — a bare,
//! unquoted value — is not valid TOML, and it has been working for every project
//! that wrote it that way.
//!
//! `[env]` needs arrays of tables, so a real parser is no longer optional. But
//! swapping the scanner out would take those projects' lifecycle away on the
//! upgrade, silently, because a parse failure degrades to "no lifecycle" and a
//! worktree with no warm-up looks exactly like a project that never had one.
//!
//! So: strict TOML first, and if the document does not parse, fall back to the
//! old scanner for the `[worktree]` table alone. A hand-written file keeps
//! working, an `[env]` table gets a real parser, and nobody has to be told.
//!
//! ## Leniency
//!
//! [`load`] never fails: a missing file, an unreadable one, or a document
//! neither parser can make sense of all give an empty spec, which is exactly
//! today's bare behaviour. [`load_checked`] is the same read with the errors
//! kept, for the commands whose whole job is to tell a person what is wrong with
//! their spec.

use std::path::{Path, PathBuf};

use toml_edit::{DocumentMut, Item, Value};

use crate::spec::{EnvSpec, Lifecycle, Network, Package, Service, Tool, Toolchain};

/// Where the spec lives, relative to the repo root. Git-tracked, reviewed in a
/// pull request like anything else that changes what runs on your machines.
pub const SETTINGS_REL_PATH: &str = ".aura/settings.toml";

pub fn settings_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("settings.toml")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Neither the TOML parser nor the legacy scanner could make sense of it.
    Toml(String),
    /// A field is present but not the shape it has to be.
    Field { path: String, detail: String },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Toml(e) => write!(f, "{}: {}", SETTINGS_REL_PATH, e),
            ParseError::Field { path, detail } => write!(f, "{path}: {detail}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Read the spec, degrading to empty on any problem. The path every existing
/// caller of the old lifecycle loader takes.
pub fn load(repo_root: &Path) -> EnvSpec {
    match std::fs::read_to_string(settings_path(repo_root)) {
        Ok(text) => parse_spec(&text).unwrap_or_else(|_| legacy_lifecycle_only(&text)),
        Err(_) => EnvSpec::default(),
    }
}

/// Read the spec, keeping the errors. A missing file is not an error — a
/// project is allowed to declare nothing — but a malformed one is.
pub fn load_checked(repo_root: &Path) -> Result<EnvSpec, ParseError> {
    match std::fs::read_to_string(settings_path(repo_root)) {
        Ok(text) => parse_spec(&text),
        Err(_) => Ok(EnvSpec::default()),
    }
}

/// Read the spec the way anything that is about to *run* it should: strict
/// about `[env]`, forgiving about a `[worktree]` block that predates it.
///
/// The two halves of that sentence are both load-bearing, and neither of the
/// simpler rules works.
///
/// Being lenient everywhere is what [`load`] does, and it is right for the
/// callers that only ever wanted the three scripts — but a project that mistypes
/// a package name would silently be brought to a *smaller* environment than the
/// one it wrote down, and the plan would report itself at spec. Quietly doing
/// less is the exact failure this whole feature exists to remove.
///
/// Being strict everywhere is what [`load_checked`] does, and it breaks projects
/// that never had to be valid TOML: `setup = make build # warm it up` has always
/// been read by the line scanner and has always worked. Those projects declare
/// no `[env]`, so nothing about them is ambiguous — there is no environment to
/// get wrong.
///
/// So the rule is the presence of `[env]`. Declare one and it must parse.
pub fn load_declared(repo_root: &Path) -> Result<EnvSpec, ParseError> {
    match std::fs::read_to_string(settings_path(repo_root)) {
        Ok(text) => parse_declared(&text),
        Err(_) => Ok(EnvSpec::default()),
    }
}

/// PURE: [`load_declared`]'s rule, for a document that came from somewhere other
/// than this disk — a box's checkout read over the wire.
pub fn parse_declared(text: &str) -> Result<EnvSpec, ParseError> {
    match parse_spec(text) {
        Ok(spec) => Ok(spec),
        Err(e) if mentions_env_table(text) => Err(e),
        Err(_) => Ok(legacy_lifecycle_only(text)),
    }
}

/// Whether the document tries to declare an environment at all.
///
/// Header lines only, and the same tolerance for a trailing comment the legacy
/// scanner has. A `[worktree]` key whose *value* happens to contain the word env
/// (`setup = "env NODE_ENV=test npm ci"`) is not a declaration, and reading it as
/// one would turn the forgiving path off for exactly the projects it exists for.
fn mentions_env_table(text: &str) -> bool {
    text.lines().any(|raw| {
        let line = raw.trim();
        if !line.starts_with('[') {
            return false;
        }
        let header = line.split('#').next().unwrap_or(line).trim();
        let name = header
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim();
        name == "env" || name.starts_with("env.")
    })
}

/// PURE: a settings document → the environment it declares.
pub fn parse_spec(text: &str) -> Result<EnvSpec, ParseError> {
    let doc: DocumentMut = text
        .parse()
        .map_err(|e: toml_edit::TomlError| ParseError::Toml(e.to_string()))?;

    let mut spec = EnvSpec {
        lifecycle: lifecycle_from(&doc),
        ..Default::default()
    };

    let Some(env) = doc.get("env").and_then(Item::as_table_like) else {
        return Ok(spec);
    };

    spec.version = env
        .get("version")
        .and_then(Item::as_integer)
        .unwrap_or(0)
        .max(0) as u32;

    if let Some(tc) = env.get("toolchain").and_then(Item::as_table_like) {
        spec.toolchain = toolchain_from(tc)?;
    }
    for (ix, t) in tables_at(env, "package").into_iter().enumerate() {
        spec.packages.push(package_from(&t, ix)?);
    }
    for (ix, t) in tables_at(env, "service").into_iter().enumerate() {
        spec.services.push(service_from(&t, ix)?);
    }
    if let Some(net) = env.get("network").and_then(Item::as_table_like) {
        spec.network = network_from(net)?;
    }

    Ok(spec)
}

/// `[env.network] allow = ["api.anthropic.com", "github.com:443"]`.
///
/// Strict, and deliberately stricter than the rest of this file. Everything else
/// here describes what to *install*, and a typo costs a failed step somebody
/// reads. This describes what may be *reached*, and a typo that parses is a hole:
/// `https://api.example.com` read as a hostname is a name that resolves to
/// nothing, so the entry silently allows nothing and the person who wrote it
/// believes otherwise. Every one of those is an error with the line in it.
fn network_from(net: &dyn toml_edit::TableLike) -> Result<Network, ParseError> {
    let Some(item) = net.get("allow") else {
        return Ok(Network::default());
    };
    let Some(list) = item.as_array() else {
        return Err(ParseError::Field {
            path: "env.network.allow".into(),
            detail: "expected a list of hosts, like [\"api.anthropic.com\", \"github.com:443\"]"
                .into(),
        });
    };

    let mut allow: Vec<String> = Vec::new();
    for (ix, value) in list.iter().enumerate() {
        let path = format!("env.network.allow[{ix}]");
        let Some(raw) = value.as_str() else {
            return Err(ParseError::Field {
                path,
                detail: "expected a host, written as a string".into(),
            });
        };
        allow.push(endpoint(raw, &path)?);
    }

    // Sorted and de-duplicated: the same list in a different order is the same
    // policy, and must seal to the same digest.
    allow.sort();
    allow.dedup();
    Ok(Network { allow })
}

/// One allowlist entry → `host:port`, or the reason it is not one.
///
/// The default port is 443 and not 80: what a project declares here is an API it
/// talks to, and plaintext HTTP is not the thing to make the easy spelling.
fn endpoint(raw: &str, path: &str) -> Result<String, ParseError> {
    let refuse = |detail: String| ParseError::Field {
        path: path.to_string(),
        detail,
    };
    let text = raw.trim();
    if text.is_empty() {
        return Err(refuse("an empty host allows nothing — take it out".into()));
    }
    if let Some((scheme, _)) = text.split_once("://") {
        return Err(refuse(format!(
            "write the host on its own, without `{scheme}://` — the allowlist is host and port, not a URL"
        )));
    }
    if text.contains('/') || text.contains('@') || text.contains('?') {
        return Err(refuse(format!(
            "`{text}` is not a host — the allowlist names machines, not paths on them"
        )));
    }
    if text.contains('*') {
        return Err(refuse(format!(
            "`{text}` cannot be allowed: a wildcard names no address to allow, and every host it \
             would cover has to be resolvable before the work starts. Name them one per line"
        )));
    }

    let (host, port) = match text.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p.trim().parse().map_err(|_| {
                refuse(format!("`{p}` is not a port — write a number from 1 to 65535"))
            })?;
            if port == 0 {
                return Err(refuse("port 0 is not a port to reach".into()));
            }
            (h.trim(), port)
        }
        None => (text, 443),
    };

    if host.is_empty() {
        return Err(refuse(format!("`{text}` names a port but no host")));
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(refuse(format!(
            "`{host}` is not a hostname — letters, digits, dots and dashes only"
        )));
    }
    Ok(format!("{host}:{port}"))
}

/// One `[[env.x]]` array of tables, flattened to owned maps so the two callers
/// below read the same way whether TOML gave us an array of tables or a single
/// inline table. A project that writes `[env.package]` once instead of
/// `[[env.package]]` gets what it obviously meant rather than silence.
fn tables_at(env: &dyn toml_edit::TableLike, key: &str) -> Vec<Table> {
    let Some(item) = env.get(key) else {
        return Vec::new();
    };
    if let Some(arr) = item.as_array_of_tables() {
        return arr.iter().map(|t| Table::from_table_like(t)).collect();
    }
    if let Some(arr) = item.as_array() {
        return arr
            .iter()
            .filter_map(Value::as_inline_table)
            .map(|t| Table::from_table_like(t))
            .collect();
    }
    match item.as_table_like() {
        Some(t) => vec![Table::from_table_like(t)],
        None => Vec::new(),
    }
}

/// A flattened `key -> scalar` view of one TOML table.
#[derive(Default)]
struct Table {
    strings: Vec<(String, String)>,
    ints: Vec<(String, i64)>,
    bools: Vec<(String, bool)>,
}

impl Table {
    fn from_table_like(t: &dyn toml_edit::TableLike) -> Self {
        let mut out = Table::default();
        for (k, v) in t.iter() {
            match v.as_value().or_else(|| v.as_value()) {
                Some(Value::String(s)) => out.strings.push((k.to_string(), s.value().clone())),
                Some(Value::Integer(i)) => out.ints.push((k.to_string(), *i.value())),
                Some(Value::Boolean(b)) => out.bools.push((k.to_string(), *b.value())),
                _ => {}
            }
        }
        out
    }

    fn str(&self, key: &str) -> Option<String> {
        self.strings
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    fn int(&self, key: &str) -> Option<i64> {
        self.ints.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
    }

    fn bool(&self, key: &str) -> Option<bool> {
        self.bools.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
    }
}

fn required(t: &Table, key: &str, path: &str) -> Result<String, ParseError> {
    t.str(key).ok_or_else(|| ParseError::Field {
        path: format!("{path}.{key}"),
        detail: format!("missing — every {path} entry needs a `{key}`"),
    })
}

/// `[env.toolchain]`: `manager` plus one entry per pinned tool. A tool is
/// either `node = "20.11.0"` or a sub-table carrying its own check/install.
fn toolchain_from(tc: &dyn toml_edit::TableLike) -> Result<Toolchain, ParseError> {
    let mut out = Toolchain {
        manager: tc
            .get("manager")
            .and_then(Item::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        tools: Vec::new(),
    };

    for (name, item) in tc.iter() {
        if name == "manager" {
            continue;
        }
        if let Some(version) = item.as_str() {
            let version = version.trim();
            if version.is_empty() {
                continue;
            }
            out.tools.push(Tool {
                name: name.to_string(),
                version: version.to_string(),
                check: None,
                install: None,
            });
            continue;
        }
        let Some(sub) = item.as_table_like() else {
            return Err(ParseError::Field {
                path: format!("env.toolchain.{name}"),
                detail: "expected a version string or a table with a `version`".into(),
            });
        };
        let sub = Table::from_table_like(sub);
        out.tools.push(Tool {
            version: required(&sub, "version", &format!("env.toolchain.{name}"))?,
            name: name.to_string(),
            check: sub.str("check"),
            install: sub.str("install"),
        });
    }

    // Sorted so two files that name the same tools in different orders seal to
    // the same digest — a reordering is not a change to the environment.
    out.tools.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn package_from(t: &Table, ix: usize) -> Result<Package, ParseError> {
    let path = format!("env.package[{ix}]");
    Ok(Package {
        manager: required(t, "manager", &path)?,
        name: required(t, "name", &path)?,
        version: t.str("version"),
        global: t.bool("global").unwrap_or(true),
        check: t.str("check"),
        install: t.str("install"),
    })
}

fn service_from(t: &Table, ix: usize) -> Result<Service, ParseError> {
    let path = format!("env.service[{ix}]");
    let wait = t.int("wait_secs").or_else(|| t.int("wait")).unwrap_or(60);
    Ok(Service {
        name: required(t, "name", &path)?,
        start: required(t, "start", &path)?,
        ready: t.str("ready"),
        stop: t.str("stop"),
        wait_secs: wait.clamp(0, 3600) as u32,
    })
}

fn lifecycle_from(doc: &DocumentMut) -> Lifecycle {
    let Some(wt) = doc.get("worktree").and_then(Item::as_table_like) else {
        return Lifecycle::default();
    };
    let get = |k: &str| {
        wt.get(k)
            .and_then(Item::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Lifecycle {
        setup: get("setup"),
        run: get("run"),
        archive: get("archive"),
    }
}

/// The original hand-rolled `[worktree]` scanner, kept verbatim in behaviour as
/// the fallback for documents TOML rejects.
///
/// A deliberately small subset — single-line `key = "..."` (or `'...'`, or a
/// bare unquoted value) under the `[worktree]` header. Other tables, unknown
/// keys, blank lines and `#` comments are ignored.
fn legacy_lifecycle_only(toml: &str) -> EnvSpec {
    let mut life = Lifecycle::default();
    let mut in_table = false;
    for raw in toml.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            // A new table header — we only care about `[worktree]` (tolerate a
            // trailing inline comment after the closing bracket).
            let header = line.split('#').next().unwrap_or(line).trim();
            in_table = header == "[worktree]";
            continue;
        }
        if !in_table {
            continue;
        }
        if let Some((key, val)) = line.split_once('=') {
            let val = unquote(val.trim());
            if val.is_empty() {
                continue;
            }
            match key.trim() {
                "setup" => life.setup = Some(val),
                "run" => life.run = Some(val),
                "archive" => life.archive = Some(val),
                _ => {}
            }
        }
    }
    EnvSpec {
        lifecycle: life,
        ..Default::default()
    }
}

/// PURE: strip one layer of matching quotes from a TOML scalar. A quoted value
/// is returned verbatim (a `#` inside a quoted command is part of the command,
/// not a comment); a bare value has any trailing ` # comment` removed.
fn unquote(s: &str) -> String {
    let s = s.trim();
    let bytes = s.as_bytes();
    if s.len() >= 2 {
        let first = bytes[0];
        let last = bytes[s.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return s[1..s.len() - 1].to_string();
        }
    }
    // Bare value: a ` #` (space then hash) starts an inline comment.
    match s.split_once(" #") {
        Some((v, _)) => v.trim().to_string(),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the lifecycle, exactly as it behaved before `[env]` existed -------

    #[test]
    fn empty_doc_is_empty_lifecycle() {
        assert!(parse_spec("").unwrap().is_empty());
        assert!(parse_spec("[other]\nx = 1\n").unwrap().is_empty());
    }

    #[test]
    fn reads_all_three_keys() {
        let doc = r#"
[worktree]
setup = "npm install"
run = 'npm run dev'
archive = "docker compose down"
"#;
        let life = parse_spec(doc).unwrap().lifecycle;
        assert_eq!(life.setup.as_deref(), Some("npm install"));
        assert_eq!(life.run.as_deref(), Some("npm run dev"));
        assert_eq!(life.archive.as_deref(), Some("docker compose down"));
        assert!(!life.is_empty());
    }

    #[test]
    fn only_worktree_table_is_read() {
        let doc = "[editor]\nsetup = \"WRONG\"\n[worktree]\nsetup = \"npm ci\"\n[build]\nsetup = \"ALSO WRONG\"\n";
        let life = parse_spec(doc).unwrap().lifecycle;
        assert_eq!(life.setup.as_deref(), Some("npm ci"));
        assert_eq!(life.run, None);
    }

    #[test]
    fn hash_inside_quotes_is_kept() {
        let life = parse_spec("[worktree]\nsetup = \"cargo build --features 'a#b'\"\n")
            .unwrap()
            .lifecycle;
        assert_eq!(life.setup.as_deref(), Some("cargo build --features 'a#b'"));
    }

    #[test]
    fn comments_and_blank_lines_ignored() {
        let doc = "# top comment\n\n[worktree]\n# inner comment\nsetup = \"x\"\n\n";
        assert_eq!(parse_spec(doc).unwrap().lifecycle.setup.as_deref(), Some("x"));
    }

    #[test]
    fn compound_command_survives() {
        let life = parse_spec("[worktree]\nsetup = \"npm install && cargo build\"\n")
            .unwrap()
            .lifecycle;
        assert_eq!(life.setup.as_deref(), Some("npm install && cargo build"));
    }

    #[test]
    fn empty_value_is_skipped_not_empty_string() {
        let life = parse_spec("[worktree]\nsetup = \"\"\nrun = \"go run .\"\n")
            .unwrap()
            .lifecycle;
        assert_eq!(life.setup, None);
        assert_eq!(life.run.as_deref(), Some("go run ."));
    }

    #[test]
    fn a_bare_unquoted_value_still_reads_through_the_legacy_scanner() {
        // Not valid TOML. It has been working since the day the scanner was
        // written, so it goes on working: the strict parser rejects the
        // document and the fallback reads the table it always read.
        let text = "[worktree]\nsetup = make build # warm it up\n";
        assert!(parse_spec(text).is_err());
        let life = legacy_lifecycle_only(text).lifecycle;
        assert_eq!(life.setup.as_deref(), Some("make build"));
    }

    // ---- the environment ---------------------------------------------------

    const FULL: &str = r#"
[env]
version = 3

[env.toolchain]
manager = "mise"
node = "20.11.0"
bun  = "1.1.29"

[[env.package]]
manager = "brew"
name = "ripgrep"

[[env.package]]
manager = "cargo"
name = "cargo-nextest"
version = "0.9.72"

[[env.service]]
name  = "postgres"
start = "docker compose up -d db"
ready = "pg_isready -h 127.0.0.1"
stop  = "docker compose down"
wait_secs = 30

[worktree]
setup = "npm ci"
"#;

    #[test]
    fn reads_a_whole_environment() {
        let s = parse_spec(FULL).unwrap();
        assert_eq!(s.version, 3);
        assert_eq!(s.toolchain.manager.as_deref(), Some("mise"));
        // Sorted by name, not by file order.
        assert_eq!(
            s.toolchain
                .tools
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            vec!["bun", "node"]
        );
        assert_eq!(s.packages.len(), 2);
        assert_eq!(s.packages[1].version.as_deref(), Some("0.9.72"));
        assert_eq!(s.services.len(), 1);
        assert_eq!(s.services[0].wait_secs, 30);
        assert_eq!(s.lifecycle.setup.as_deref(), Some("npm ci"));
        assert!(s.declares_environment());
    }

    #[test]
    fn tool_order_in_the_file_does_not_change_the_digest() {
        let a = parse_spec("[env.toolchain]\nnode = \"20\"\nbun = \"1\"\n").unwrap();
        let b = parse_spec("[env.toolchain]\nbun = \"1\"\nnode = \"20\"\n").unwrap();
        assert_eq!(a.digest().unwrap(), b.digest().unwrap());
    }

    #[test]
    fn a_tool_can_bring_its_own_check_and_install() {
        let doc = r#"
[env.toolchain.zig]
version = "0.13.0"
check   = "zig version | grep -qF 0.13.0"
install = "curl -sSL https://ziglang.org/x | sh"
"#;
        let t = &parse_spec(doc).unwrap().toolchain.tools[0];
        assert_eq!(t.name, "zig");
        assert_eq!(t.version, "0.13.0");
        assert!(t.check.is_some() && t.install.is_some());
    }

    #[test]
    fn a_package_without_a_name_is_an_error_not_a_silent_skip() {
        let err = parse_spec("[[env.package]]\nmanager = \"brew\"\n").unwrap_err();
        assert!(matches!(err, ParseError::Field { .. }), "{err}");
        assert!(err.to_string().contains("name"), "{err}");
    }

    #[test]
    fn a_service_without_a_start_is_an_error() {
        let err = parse_spec("[[env.service]]\nname = \"db\"\n").unwrap_err();
        assert!(err.to_string().contains("start"), "{err}");
    }

    #[test]
    fn a_singular_package_table_reads_as_one_entry() {
        // `[env.package]` where `[[env.package]]` was meant.
        let s = parse_spec("[env.package]\nmanager = \"brew\"\nname = \"jq\"\n").unwrap();
        assert_eq!(s.packages.len(), 1);
        assert_eq!(s.packages[0].name, "jq");
    }

    #[test]
    fn an_inline_array_of_packages_reads_too() {
        let s = parse_spec(
            "[env]\npackage = [{ manager = \"brew\", name = \"jq\" }, { manager = \"brew\", name = \"fd\" }]\n",
        )
        .unwrap();
        assert_eq!(s.packages.len(), 2);
        assert_eq!(s.packages[1].name, "fd");
    }

    #[test]
    fn package_scope_can_be_narrowed_to_the_project() {
        let s = parse_spec(
            "[[env.package]]\nmanager = \"npm\"\nname = \"vite\"\nglobal = false\n",
        )
        .unwrap();
        assert!(!s.packages[0].global);
    }

    #[test]
    fn a_project_that_never_had_to_be_toml_still_gets_its_scripts() {
        // The line that made the legacy scanner necessary: unquoted, with a
        // trailing comment. It has always worked and must keep working, because
        // it declares no environment for anyone to get wrong.
        let legacy = "[worktree]\nsetup = make build # warm it up\narchive = echo bye\n";
        let s = parse_declared(legacy).expect("a legacy file is not an error");
        assert_eq!(s.lifecycle.setup.as_deref(), Some("make build"));
        assert_eq!(s.lifecycle.archive.as_deref(), Some("echo bye"));
        assert!(!s.declares_environment());
    }

    #[test]
    fn a_project_that_does_declare_an_environment_must_get_it_right() {
        // The other side. Degrading here would run a *smaller* environment than
        // the one written down and then report itself at spec.
        let typo = "[env]\nversion = 1\n\n[[env.package]]\nmanager = \"brew\"\n";
        let e = parse_declared(typo).expect_err("a broken [env] is an error");
        assert!(e.to_string().contains("name"), "{e}");

        // And a file that is not TOML at all, but does mention [env].
        let worse = "[env]\nversion = 1\n\n[worktree]\nsetup = make build\n";
        assert!(parse_declared(worse).is_err());
    }

    #[test]
    fn the_word_env_inside_a_command_is_not_a_declaration() {
        // `env NODE_ENV=test npm ci` is a shell command, not an [env] table.
        // Reading it as one would turn the forgiving path off for precisely the
        // projects it exists for.
        let s = parse_declared("[worktree]\nsetup = env NODE_ENV=test npm ci\n")
            .expect("a command is not a declaration");
        assert_eq!(s.lifecycle.setup.as_deref(), Some("env NODE_ENV=test npm ci"));
        assert!(!mentions_env_table("[worktree]\nsetup = env FOO=1 make\n"));
        for header in ["[env]", "[env.toolchain]", "[[env.package]]", "  [env] # yes"] {
            assert!(mentions_env_table(header), "{header}");
        }
        for header in ["[environment]", "[worktree]", "[copy]"] {
            assert!(!mentions_env_table(header), "{header}");
        }
    }

    #[test]
    fn a_negative_version_never_becomes_a_huge_one() {
        let s = parse_spec("[env]\nversion = -1\n").unwrap();
        assert_eq!(s.version, 0);
    }

    #[test]
    fn load_of_a_missing_file_is_empty_not_an_error() {
        let dir = std::env::temp_dir().join("aura-env-parse-missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).is_empty());
        assert!(load_checked(&dir).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- the allowlist ----------------------------------------------------

    #[test]
    fn an_allowlist_is_canonical_sorted_and_deduplicated() {
        let s = parse_spec(
            r#"
[env]
version = 1

[env.network]
allow = ["github.com:443", "api.anthropic.com", "GITHUB.com:443", "example.dev:8443"]
"#,
        )
        .unwrap();
        // Every entry carries its port, whether or not it was written; the same
        // list in a different order is the same policy and seals the same way.
        assert_eq!(
            s.network.allow,
            vec!["GITHUB.com:443", "api.anthropic.com:443", "example.dev:8443", "github.com:443"]
        );
        assert!(s.declares_environment(), "an allowlist is worth signing");
    }

    #[test]
    fn an_allowlist_entry_that_would_silently_allow_nothing_is_an_error() {
        // Each of these parses fine as a *string*. Accepted as a host, each one
        // is a line somebody wrote to allow something, that allows nothing.
        for bad in [
            r#"allow = ["https://api.example.com"]"#,
            r#"allow = ["api.example.com/v1"]"#,
            r#"allow = ["*.example.com"]"#,
            r#"allow = ["api.example.com:notaport"]"#,
            r#"allow = ["api.example.com:0"]"#,
            r#"allow = [":443"]"#,
            r#"allow = [""]"#,
            r#"allow = [443]"#,
            r#"allow = "api.example.com""#,
        ] {
            let doc = format!("[env]\nversion = 1\n\n[env.network]\n{bad}\n");
            let err = parse_spec(&doc).unwrap_err();
            assert!(
                format!("{err}").contains("env.network.allow"),
                "{bad} was accepted, or complained about the wrong thing: {err}"
            );
        }
    }

    #[test]
    fn a_project_that_declares_no_allowlist_says_so_rather_than_an_empty_one() {
        // The distinction matters at the other end: nothing declared means the
        // run gets the floor it cannot work without, not "reach nowhere".
        let s = parse_spec("[env]\nversion = 1\n").unwrap();
        assert!(s.network.is_empty());
        let s = parse_spec("[env]\nversion = 1\n\n[env.network]\nallow = []\n").unwrap();
        assert!(s.network.is_empty());
    }

    #[test]
    fn load_falls_back_to_the_scanner_on_disk_too() {
        let dir = std::env::temp_dir().join("aura-env-parse-legacy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".aura")).unwrap();
        std::fs::write(
            settings_path(&dir),
            "[worktree]\nsetup = make build # warm it up\n",
        )
        .unwrap();
        assert_eq!(load(&dir).lifecycle.setup.as_deref(), Some("make build"));
        assert!(load_checked(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

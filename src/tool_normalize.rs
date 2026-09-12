// Canonical-operation normalization for agent tool calls (AUDIT-SEC-03).
//
// Every agent surface names the same operation differently: Claude Code says
// `Bash` + `command`, Codex says `exec_command`/`shell` with a command ARRAY,
// Gemini says `run_shell_command`, Cursor says `run_terminal_cmd`, and shell
// wrappers (`sudo rm`, `env X=1 rm`, `/bin/rm`, `bash -c "rm …"`) dress the
// same destructive binary in prefixes that defeat `^`-anchored policy regexes
// and head-token classification.
//
// This module folds all of that into ONE [`CanonicalOperation`] BEFORE any
// policy decision runs, so the same destructive operation receives the same
// verdict no matter which surface proposed it:
//
//   - tool-name aliasing → [`CanonicalTool`]
//   - `command` vs `cmd` vs `script`, string vs array → one command string
//   - quote-aware splitting into pipeline/`&&`/`;` segments
//   - wrapper stripping per segment (sudo, doas, env, nohup, nice, ionice,
//     time, timeout, stdbuf, xargs, command, builtin, caffeinate) and
//     `bash -c "<inner>"` extraction, applied recursively
//   - absolute/relative binary paths basenamed (`/bin/rm` → `rm`)
//   - Codex `apply_patch` grammar parsed for touched/deleted files
//   - unknown tools with write-capable schemas flagged so the gate can
//     default them to "ask" instead of waving them through
//
// The normalizer never decides anything — it only reshapes. Classification
// and verdicts stay in `validate_tool`.

use serde_json::Value;

/// What kind of operation a tool call canonically is, across every surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalTool {
    /// A shell command (Bash, exec_command, shell_command, run_terminal_cmd…).
    Shell,
    /// A wholesale file write (Write, write_file, create_file…).
    FileWrite,
    /// A scoped in-place edit (Edit, MultiEdit, replace, edit_file…).
    FileEdit,
    /// A notebook cell edit.
    NotebookEdit,
    /// An explicit file deletion tool.
    FileDelete,
    /// Codex-style `apply_patch` — patch grammar carrying its own file ops.
    ApplyPatch,
    /// A known read-only tool (Read, Grep, Glob, WebFetch…).
    ReadOnly,
    /// Unknown tool whose schema looks write-capable (path + content fields,
    /// or a mutating name). The gate must NOT default these to allow.
    UnknownWriteCapable,
    /// Unknown tool with no write signals — treated as benign.
    Unknown,
}

/// One pipeline/`&&`/`;` segment of a shell command after wrapper stripping.
#[derive(Debug, Clone)]
pub struct CommandSegment {
    /// Normalized tokens: head basenamed, wrappers removed, quotes resolved.
    pub tokens: Vec<String>,
    /// The tokens re-joined for display and for policy-regex matching.
    pub text: String,
}

/// The one canonical shape every agent tool call is folded into.
#[derive(Debug, Clone)]
pub struct CanonicalOperation {
    pub tool: CanonicalTool,
    /// The command line exactly as the agent sent it (array forms joined).
    pub raw_command: Option<String>,
    /// Normalized segments — what classification and policy should look at.
    pub segments: Vec<CommandSegment>,
    /// First path-ish field from the payload, if any.
    pub path: Option<String>,
    /// apply_patch only: files the patch deletes outright.
    pub patch_deleted_paths: Vec<String>,
    /// apply_patch only: files the patch adds or updates.
    pub patch_touched_paths: Vec<String>,
    /// Which payload fields made an unknown tool look write-capable.
    pub write_signals: Vec<String>,
}

/// Fold a raw (tool_name, tool_input) pair into a [`CanonicalOperation`].
pub fn normalize(tool_name: &str, input: &Value) -> CanonicalOperation {
    let name = tool_name.to_lowercase();
    let path = first_path_field(input);

    // 1. Shell-ish tools by name — or ANY tool carrying a command-ish string
    //    field, so a new agent's shell tool is classified by its command
    //    rather than waved through on an unrecognized name.
    if is_shell_tool(&name) || command_field(input).is_some() {
        let raw = command_field(input);
        let segments = raw
            .as_deref()
            .map(normalize_command)
            .unwrap_or_default();
        return CanonicalOperation {
            tool: CanonicalTool::Shell,
            raw_command: raw,
            segments,
            path,
            patch_deleted_paths: vec![],
            patch_touched_paths: vec![],
            write_signals: vec![],
        };
    }

    // 2. apply_patch (Codex): the patch text carries its own file operations.
    if name == "apply_patch" || name == "applypatch" {
        let (deleted, touched) = parse_apply_patch(input);
        return CanonicalOperation {
            tool: CanonicalTool::ApplyPatch,
            raw_command: None,
            segments: vec![],
            path,
            patch_deleted_paths: deleted,
            patch_touched_paths: touched,
            write_signals: vec![],
        };
    }

    let tool = if is_delete_tool(&name) {
        CanonicalTool::FileDelete
    } else if is_write_tool(&name) {
        CanonicalTool::FileWrite
    } else if name == "notebookedit" || name == "notebook_edit" {
        CanonicalTool::NotebookEdit
    } else if is_edit_tool(&name) {
        CanonicalTool::FileEdit
    } else if is_read_only_tool(&name) {
        CanonicalTool::ReadOnly
    } else {
        // Unknown tool: write-capable schema ⇒ the gate must ask, not allow.
        let signals = write_signals(&name, input, path.is_some());
        if signals.is_empty() {
            CanonicalTool::Unknown
        } else {
            return CanonicalOperation {
                tool: CanonicalTool::UnknownWriteCapable,
                raw_command: None,
                segments: vec![],
                path,
                patch_deleted_paths: vec![],
                patch_touched_paths: vec![],
                write_signals: signals,
            };
        }
    };

    CanonicalOperation {
        tool,
        raw_command: None,
        segments: vec![],
        path,
        patch_deleted_paths: vec![],
        patch_touched_paths: vec![],
        write_signals: vec![],
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-name aliasing
// ─────────────────────────────────────────────────────────────────────────────

fn is_shell_tool(name: &str) -> bool {
    matches!(
        name,
        "bash"
            | "shell"
            | "run"
            | "terminal"
            | "cmd"
            | "exec"
            | "exec_command"
            | "shell_command"
            | "run_shell_command"
            | "execute_command"
            | "execute_bash"
            | "run_command"
            | "run_terminal_cmd"
            | "run_in_terminal"
    )
}

fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        "write" | "create" | "write_file" | "create_file" | "save_file" | "write_to_file"
    )
}

fn is_edit_tool(name: &str) -> bool {
    matches!(
        name,
        "edit" | "multiedit" | "multi_edit" | "replace" | "edit_file" | "str_replace_editor"
    )
}

fn is_delete_tool(name: &str) -> bool {
    name == "rm"
        || name == "remove"
        || name == "delete_file"
        || name == "remove_file"
        || name.contains("delete")
}

fn is_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "read"
            | "read_file"
            | "read_many_files"
            | "cat"
            | "grep"
            | "glob"
            | "ls"
            | "list"
            | "list_dir"
            | "list_directory"
            | "search"
            | "codebase_search"
            | "file_search"
            | "web_search"
            | "websearch"
            | "webfetch"
            | "web_fetch"
            | "fetch"
            | "google_web_search"
            | "task"
            | "agent"
            | "todoread"
            | "todowrite"
            | "notebookread"
            | "lsp"
            | "toolsearch"
    )
}

/// Field names whose presence (alongside a path) marks a payload as carrying
/// new file content — i.e. the tool can mutate state.
const CONTENT_FIELDS: &[&str] = &[
    "content", "contents", "new_string", "new_str", "edits", "text", "data", "body", "diff",
    "patch",
];

/// Substrings in a tool NAME that imply mutation even without content fields.
const MUTATING_NAME_HINTS: &[&str] = &[
    "write", "edit", "patch", "creat", "delet", "remov", "move", "copy", "mkdir", "upload",
    "install", "apply", "save", "format", "migrate", "chmod", "rename",
];

/// Why an unknown tool looks write-capable: mutating name hints and/or
/// path+content payload fields. Empty ⇒ no write signals.
fn write_signals(name: &str, input: &Value, has_path: bool) -> Vec<String> {
    let mut out = Vec::new();
    for hint in MUTATING_NAME_HINTS {
        if name.contains(hint) {
            out.push(format!("name contains \"{hint}\""));
            break;
        }
    }
    if has_path {
        for f in CONTENT_FIELDS {
            if input.get(*f).is_some() {
                out.push(format!("payload has path + `{f}`"));
                break;
            }
        }
    }
    out
}

/// The command line, from whichever field this surface uses. Codex sends the
/// command as a JSON ARRAY of argv tokens — join it back into one line.
fn command_field(input: &Value) -> Option<String> {
    for key in ["command", "cmd", "script", "command_line"] {
        match input.get(key) {
            Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            Some(Value::Array(arr)) if !arr.is_empty() => {
                let joined = arr
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                if !joined.is_empty() {
                    return Some(joined);
                }
            }
            _ => {}
        }
    }
    None
}

/// First path-ish field from a tool_input object.
pub fn first_path_field(input: &Value) -> Option<String> {
    for key in ["file_path", "path", "file", "notebook_path", "target"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Command normalization
// ─────────────────────────────────────────────────────────────────────────────

/// Binaries that merely wrap the real command. Dropping them (plus their
/// leading flags) exposes the head the destructive checks care about.
const WRAPPERS: &[&str] = &[
    "sudo",
    "doas",
    "env",
    "command",
    "builtin",
    "nohup",
    "nice",
    "ionice",
    "time",
    "timeout",
    "stdbuf",
    "xargs",
    "caffeinate",
];

/// Wrappers that take one bare (non-flag) argument before the real command
/// — `timeout 5`, `nice 10` — which must be dropped too.
const WRAPPERS_WITH_ARG: &[&str] = &["timeout", "nice"];

const SHELLS: &[&str] = &["bash", "sh", "zsh", "dash", "ksh", "fish"];

/// Split a raw command line into normalized segments: quote-aware splitting
/// on `&&`/`||`/`;`/`|`/newline, then per-segment wrapper stripping,
/// `shell -c` extraction (recursive), and head basenaming.
pub fn normalize_command(raw: &str) -> Vec<CommandSegment> {
    let mut out = Vec::new();
    for tokens in split_segments(raw) {
        strip_into(tokens, &mut out, 0);
    }
    out
}

/// Strip wrappers from one segment's tokens, splicing in the inner segments
/// of a `bash -c "…"` when found. Depth-capped so a hostile payload can't
/// recurse forever.
fn strip_into(mut tokens: Vec<String>, out: &mut Vec<CommandSegment>, depth: u8) {
    if depth > 8 {
        push_segment(tokens, out);
        return;
    }
    loop {
        // Leading VAR=val environment assignments.
        while tokens
            .first()
            .is_some_and(|t| is_env_assignment(t))
        {
            tokens.remove(0);
        }
        let Some(head_raw) = tokens.first().cloned() else {
            return;
        };
        let head = basename(&head_raw).to_lowercase();

        if WRAPPERS.contains(&head.as_str()) {
            tokens.remove(0);
            // Drop the wrapper's own flags — and the VALUE of flags that
            // take one (`sudo -u root`, `xargs -n 1`), so the value isn't
            // mistaken for the real binary.
            while let Some(flag) = tokens.first().filter(|t| t.starts_with('-')).cloned() {
                tokens.remove(0);
                if wrapper_flag_takes_value(&head, &flag) && !tokens.is_empty() {
                    tokens.remove(0);
                }
            }
            // `timeout 5 …` / `nice 10 …`: drop one bare duration/priority.
            if WRAPPERS_WITH_ARG.contains(&head.as_str())
                && tokens.first().is_some_and(|t| is_duration_like(t))
            {
                tokens.remove(0);
            }
            continue;
        }

        if SHELLS.contains(&head.as_str()) {
            // Look for `-c <inner>` — including combined forms like `-lc`.
            let mut i = 1;
            while i < tokens.len() && tokens[i].starts_with('-') {
                let t = &tokens[i];
                if t == "-c" || (!t.starts_with("--") && t.ends_with('c')) {
                    if let Some(inner) = tokens.get(i + 1) {
                        let inner = inner.clone();
                        for seg in split_segments(&inner) {
                            strip_into(seg, out, depth + 1);
                        }
                        return;
                    }
                }
                i += 1;
            }
            // A shell running a script file — nothing more to unwrap.
        }

        // Basename the head so `/bin/rm` classifies as `rm`.
        tokens[0] = basename(&head_raw).to_string();
        push_segment(tokens, out);
        return;
    }
}

fn push_segment(tokens: Vec<String>, out: &mut Vec<CommandSegment>) {
    if tokens.is_empty() {
        return;
    }
    let text = tokens.join(" ");
    out.push(CommandSegment { tokens, text });
}

fn basename(tok: &str) -> &str {
    tok.rsplit('/').next().unwrap_or(tok)
}

/// Wrapper flags that consume the NEXT token as their value.
fn wrapper_flag_takes_value(wrapper: &str, flag: &str) -> bool {
    match wrapper {
        "sudo" | "doas" => matches!(flag, "-u" | "-g" | "-p" | "-h" | "-U" | "-R" | "-D" | "-T"),
        "env" => flag == "-u" || flag == "-C" || flag == "-S",
        "xargs" => matches!(flag, "-n" | "-L" | "-P" | "-s" | "-I" | "-d" | "-E" | "-a"),
        "timeout" => matches!(flag, "-k" | "-s" | "--kill-after" | "--signal"),
        "nice" | "ionice" => matches!(flag, "-n" | "-c" | "-p"),
        "stdbuf" => matches!(flag, "-i" | "-o" | "-e"),
        _ => false,
    }
}

/// `FOO=bar` before the binary — a name of [A-Za-z_][A-Za-z0-9_]* then `=`.
fn is_env_assignment(tok: &str) -> bool {
    let Some(eq) = tok.find('=') else { return false };
    if eq == 0 {
        return false;
    }
    tok[..eq]
        .chars()
        .enumerate()
        .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

/// `5`, `10s`, `2m`, `1.5h` — the bare argument of timeout/nice.
fn is_duration_like(tok: &str) -> bool {
    let core = tok.trim_end_matches(['s', 'm', 'h', 'd']);
    !core.is_empty() && core.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Quote-aware tokenizer + segment splitter. Splits on unquoted `&&`, `||`,
/// `;`, `|`, `&` and newlines; resolves single/double quotes and backslash
/// escapes; emits redirects as their own tokens (`>`, `>>`, `2>`, `&>`) so
/// classification can spot a bare truncating `>`.
fn split_segments(raw: &str) -> Vec<Vec<String>> {
    let mut segments: Vec<Vec<String>> = Vec::new();
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = raw.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;

    macro_rules! flush_token {
        () => {{
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
        }};
    }
    macro_rules! flush_segment {
        () => {{
            flush_token!();
            if !tokens.is_empty() {
                segments.push(std::mem::take(&mut tokens));
            }
        }};
    }

    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                cur.push(c);
            }
            continue;
        }
        if in_double {
            match c {
                '"' => in_double = false,
                '\\' => {
                    if let Some(&n) = chars.peek() {
                        chars.next();
                        cur.push(n);
                    }
                }
                _ => cur.push(c),
            }
            continue;
        }
        match c {
            '\'' => in_single = true,
            '"' => in_double = true,
            '\\' => {
                if let Some(&n) = chars.peek() {
                    chars.next();
                    cur.push(n);
                }
            }
            ' ' | '\t' => flush_token!(),
            '\n' | ';' => flush_segment!(),
            '&' => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    flush_segment!();
                } else if chars.peek() == Some(&'>') {
                    // `&>` redirect token.
                    chars.next();
                    flush_token!();
                    tokens.push("&>".to_string());
                } else {
                    flush_segment!();
                }
            }
            '|' => {
                if chars.peek() == Some(&'|') {
                    chars.next();
                }
                flush_segment!();
            }
            '>' => {
                // Attach a preceding fd digit (`2>`, `1>`) to the redirect.
                let fd = if cur == "2" || cur == "1" {
                    std::mem::take(&mut cur)
                } else {
                    flush_token!();
                    String::new()
                };
                let mut redir = fd;
                redir.push('>');
                if chars.peek() == Some(&'>') {
                    chars.next();
                    redir.push('>');
                }
                tokens.push(redir);
            }
            _ => cur.push(c),
        }
    }
    flush_segment!();
    segments
}

// ─────────────────────────────────────────────────────────────────────────────
// apply_patch parsing (Codex patch grammar)
// ─────────────────────────────────────────────────────────────────────────────

/// Extract the file operations from a Codex `apply_patch` payload:
/// `*** Delete File: p` / `*** Update File: p` / `*** Add File: p`.
/// Returns (deleted, touched). Both empty ⇒ the patch didn't parse.
fn parse_apply_patch(input: &Value) -> (Vec<String>, Vec<String>) {
    let mut deleted = Vec::new();
    let mut touched = Vec::new();
    for key in ["input", "patch", "content"] {
        let Some(text) = input.get(key).and_then(|v| v.as_str()) else {
            continue;
        };
        if !text.contains("*** Begin Patch") {
            continue;
        }
        for line in text.lines() {
            let line = line.trim();
            if let Some(p) = line.strip_prefix("*** Delete File: ") {
                deleted.push(p.trim().to_string());
            } else if let Some(p) = line
                .strip_prefix("*** Update File: ")
                .or_else(|| line.strip_prefix("*** Add File: "))
            {
                touched.push(p.trim().to_string());
            }
        }
        break;
    }
    (deleted, touched)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn heads(raw: &str) -> Vec<String> {
        normalize_command(raw)
            .iter()
            .map(|s| s.tokens[0].clone())
            .collect()
    }

    /// The core bypass class: prefixes that used to defeat head-token checks
    /// all reduce to the same bare binary.
    #[test]
    fn wrappers_strip_to_the_real_binary() {
        assert_eq!(heads("rm -rf build"), vec!["rm"]);
        assert_eq!(heads("sudo rm -rf build"), vec!["rm"]);
        assert_eq!(heads("/bin/rm -rf build"), vec!["rm"]);
        assert_eq!(heads("env FOO=1 rm -rf build"), vec!["rm"]);
        assert_eq!(heads("FOO=1 BAR=2 rm -rf build"), vec!["rm"]);
        assert_eq!(heads("nice -n 10 timeout 5 rm build"), vec!["rm"]);
        assert_eq!(heads("sudo -u root /usr/bin/rm x"), vec!["rm"]);
        assert_eq!(heads("command rm x"), vec!["rm"]);
        assert_eq!(heads(r"\rm -rf build"), vec!["rm"]);
    }

    /// `bash -c "…"` runs its argument — the inner command is what must be
    /// classified, including its own `&&` chains.
    #[test]
    fn shell_dash_c_is_unwrapped_recursively() {
        assert_eq!(heads(r#"bash -c "rm -rf build""#), vec!["rm"]);
        assert_eq!(
            heads(r#"sh -c "echo hi && sudo rm -rf /tmp/x""#),
            vec!["echo", "rm"]
        );
        assert_eq!(heads(r#"bash -lc "git push -f""#), vec!["git"]);
    }

    /// Multi-command lines split into segments; each is normalized alone.
    #[test]
    fn segments_split_on_unquoted_operators_only() {
        assert_eq!(heads("echo ok && rm -rf x"), vec!["echo", "rm"]);
        assert_eq!(heads("echo a; sudo rm b"), vec!["echo", "rm"]);
        assert_eq!(heads("cat f | xargs rm"), vec!["cat", "rm"]);
        // Quoted operators are data, not separators.
        assert_eq!(heads("echo 'a && rm x'"), vec!["echo"]);
        assert_eq!(heads(r#"grep "a|b" f"#), vec!["grep"]);
    }

    /// Redirect tokens keep their fd prefix so `2>` is distinguishable from
    /// a bare truncating `>`.
    #[test]
    fn redirects_tokenize_with_fd_attached() {
        let segs = normalize_command("cmd 2>/dev/null");
        assert!(segs[0].tokens.contains(&"2>".to_string()));
        assert!(!segs[0].tokens.contains(&">".to_string()));
        let segs = normalize_command("echo x > file.txt");
        assert!(segs[0].tokens.contains(&">".to_string()));
        let segs = normalize_command("echo x >> file.txt");
        assert!(segs[0].tokens.contains(&">>".to_string()));
        assert!(!segs[0].tokens.contains(&">".to_string()));
    }

    /// Codex sends command as an argv array; it must classify like a string.
    #[test]
    fn array_command_joins_like_a_string() {
        let op = normalize("exec_command", &json!({"command": ["sudo", "rm", "-rf", "build"]}));
        assert_eq!(op.tool, CanonicalTool::Shell);
        assert_eq!(op.segments[0].tokens[0], "rm");
        assert_eq!(op.raw_command.as_deref(), Some("sudo rm -rf build"));
    }

    /// The same operation through every surface's tool name lands on the
    /// same canonical tool.
    #[test]
    fn tool_names_alias_across_surfaces() {
        for name in ["Bash", "exec_command", "shell_command", "run_shell_command", "run_terminal_cmd"] {
            let op = normalize(name, &json!({"command": "rm -rf x"}));
            assert_eq!(op.tool, CanonicalTool::Shell, "{name}");
            assert_eq!(op.segments[0].tokens[0], "rm", "{name}");
        }
        for name in ["Write", "write_file", "create_file", "save_file"] {
            let op = normalize(name, &json!({"file_path": "a.rs", "content": "x"}));
            assert_eq!(op.tool, CanonicalTool::FileWrite, "{name}");
        }
        for name in ["Edit", "replace", "edit_file", "str_replace_editor"] {
            let op = normalize(name, &json!({"file_path": "a.rs", "old_string": "a", "new_string": "b"}));
            assert_eq!(op.tool, CanonicalTool::FileEdit, "{name}");
        }
    }

    /// An unknown tool with a command field is a shell tool; with path +
    /// content it is write-capable (gate must ask); bare it is benign.
    #[test]
    fn unknown_tools_classify_by_schema_not_by_name() {
        let op = normalize("brand_new_runner", &json!({"command": "rm -rf x"}));
        assert_eq!(op.tool, CanonicalTool::Shell);

        let op = normalize("filesystem_sync", &json!({"path": "a.rs", "content": "x"}));
        assert_eq!(op.tool, CanonicalTool::UnknownWriteCapable);
        assert!(!op.write_signals.is_empty());

        let op = normalize("mystery_probe", &json!({"query": "how"}));
        assert_eq!(op.tool, CanonicalTool::Unknown);
    }

    /// apply_patch's own grammar names the files it deletes and touches.
    #[test]
    fn apply_patch_grammar_is_parsed() {
        let patch = "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new\n*** Delete File: src/gone.rs\n*** End Patch";
        let op = normalize("apply_patch", &json!({"input": patch}));
        assert_eq!(op.tool, CanonicalTool::ApplyPatch);
        assert_eq!(op.patch_deleted_paths, vec!["src/gone.rs"]);
        assert_eq!(op.patch_touched_paths, vec!["src/a.rs"]);

        // No parseable grammar ⇒ nothing extracted; the gate treats it as
        // unknown-write-capable downstream.
        let op = normalize("apply_patch", &json!({"input": "garbage"}));
        assert!(op.patch_deleted_paths.is_empty() && op.patch_touched_paths.is_empty());
    }
}

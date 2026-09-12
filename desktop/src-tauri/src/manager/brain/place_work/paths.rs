//! Paths crossing the seam between the frontend's spelling of a project and
//! the box's, and the two checks a name must pass before it is spliced into
//! a line a shell will read.

/// A path under the local root, cut down to the project-relative one.
///
/// `.` is the root itself. A path already relative is taken as such — the
/// git twins accept either, as their local counterparts always have. An
/// absolute path *outside* the root is refused: over there it would name
/// something on the box nobody asked about.
pub(crate) fn rel_of(root: &str, path: &str) -> Result<String, String> {
    let root = root.trim_end_matches('/');
    let p = path.trim();
    let rel = if p == root {
        "."
    } else if let Some(r) = p.strip_prefix(root).and_then(|r| r.strip_prefix('/')) {
        r
    } else if p.starts_with('/') {
        return Err(format!("{p} isn't inside the project."));
    } else {
        p
    };
    let rel = rel.trim_start_matches("./").trim_end_matches('/');
    let rel = if rel.is_empty() { "." } else { rel };
    check(rel)?;
    Ok(rel.to_string())
}

/// What a project-relative path may not carry into a command line.
///
/// A quote, a newline or a NUL would end the quoting and start a second
/// command; `..` would leave the project. A path the frontend produced from
/// a directory listing never has any of these, so refusing them costs
/// nothing and closes the hole for one that did not.
pub(crate) fn check(rel: &str) -> Result<(), String> {
    if rel.len() > 4096 || rel.contains(['\'', '\n', '\0']) {
        return Err(format!("{rel:?} isn't a path this can reach."));
    }
    if rel.split('/').any(|seg| seg == "..") {
        return Err(format!("{rel} isn't inside the project."));
    }
    Ok(())
}

/// `root/rel`, or `root` when `rel` is the root itself.
pub(crate) fn joined(root: &str, rel: &str) -> String {
    let root = root.trim_end_matches('/');
    if rel == "." || rel.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{rel}")
    }
}

/// A branch name, a commit, a ref — one word git will read as a name.
///
/// Git's own rules for a refname are looser and longer than this; what
/// matters here is that the word cannot end the quoting it travels in and
/// cannot be read as an option by the command it is handed to.
pub(crate) fn refname_ok(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("A branch needs a name.".to_string());
    }
    if n.len() > 512
        || n.starts_with('-')
        || n.contains(['\'', '\n', '\0', ' ', '\t'])
        || n.split('/').any(|seg| seg == "..")
    {
        return Err(format!("{n:?} isn't a name git will take."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_path_becomes_a_project_relative_one() {
        let root = "/Users/me/naridon";
        assert_eq!(rel_of(root, "/Users/me/naridon/src/a.rs").unwrap(), "src/a.rs");
        assert_eq!(rel_of(root, "/Users/me/naridon").unwrap(), ".");
        assert_eq!(rel_of(root, "/Users/me/naridon/").unwrap(), ".");
        assert_eq!(rel_of("/Users/me/naridon/", "/Users/me/naridon/x").unwrap(), "x");
        assert_eq!(rel_of(root, "src/a.rs").unwrap(), "src/a.rs");
        assert_eq!(rel_of(root, "./src/a.rs").unwrap(), "src/a.rs");
        assert_eq!(rel_of(root, "").unwrap(), ".");
    }

    #[test]
    fn a_sibling_that_shares_a_prefix_is_not_inside() {
        // `/Users/me/naridon-2` starts with the root's text and is not in it.
        assert!(rel_of("/Users/me/naridon", "/Users/me/naridon-2/x").is_err());
        assert!(rel_of("/Users/me/naridon", "/etc/hosts").is_err());
    }

    #[test]
    fn a_path_that_would_leave_or_end_the_command_is_refused() {
        for bad in ["../x", "a/../../x", "a'b", "a\nb", "a\0"] {
            assert!(rel_of("/r", bad).is_err(), "{bad:?}");
        }
        // A dot in a name is not a climb.
        assert_eq!(rel_of("/r", "a..b/..c").unwrap(), "a..b/..c");
    }

    #[test]
    fn the_answer_is_spelled_back_under_the_root() {
        assert_eq!(joined("/home/u/p", "src/a.rs"), "/home/u/p/src/a.rs");
        assert_eq!(joined("/home/u/p/", "."), "/home/u/p");
        assert_eq!(joined("/home/u/p", ""), "/home/u/p");
    }

    #[test]
    fn a_ref_is_one_word_and_not_an_option() {
        assert!(refname_ok("feat/x").is_ok());
        assert!(refname_ok("origin/feat/x").is_ok());
        assert!(refname_ok("abc123").is_ok());
        for bad in ["", "-D", "a b", "a'b", "a\nb", "../x"] {
            assert!(refname_ok(bad).is_err(), "{bad:?}");
        }
    }
}

//! Gemini's extension.
//!
//! Simpler than Claude's: Gemini reads its own `extensions/` directory at
//! startup, so staging the files there is the whole installation — there is no
//! settings file to merge into, and nothing per-repo. That also makes it safe
//! to stamp on a machine that has never installed Gemini: it leaves a
//! directory nothing reads, and costs one write.

/// The aura-gemini extension, compiled in — same reason as the Claude
/// scripts: the app has to be able to wire a machine that downloaded nothing.
pub const AURA_GEMINI_FILES: &[(&str, &str)] = &[
    (
        "gemini-extension.json",
        include_str!("../plugins/aura-gemini/gemini-extension.json"),
    ),
    (
        "hooks/hooks.json",
        include_str!("../plugins/aura-gemini/hooks/hooks.json"),
    ),
    (
        "scripts/should-use-structured.sh",
        include_str!("../plugins/aura-gemini/scripts/should-use-structured.sh"),
    ),
    (
        "scripts/aura-notify.sh",
        include_str!("../plugins/aura-gemini/scripts/aura-notify.sh"),
    ),
    (
        "scripts/build-payload.sh",
        include_str!("../plugins/aura-gemini/scripts/build-payload.sh"),
    ),
    (
        "scripts/on-session-start.sh",
        include_str!("../plugins/aura-gemini/scripts/on-session-start.sh"),
    ),
    (
        "scripts/on-stop.sh",
        include_str!("../plugins/aura-gemini/scripts/on-stop.sh"),
    ),
    (
        "scripts/on-prompt-submit.sh",
        include_str!("../plugins/aura-gemini/scripts/on-prompt-submit.sh"),
    ),
    (
        "scripts/on-post-tool-use.sh",
        include_str!("../plugins/aura-gemini/scripts/on-post-tool-use.sh"),
    ),
    (
        "scripts/on-notification.sh",
        include_str!("../plugins/aura-gemini/scripts/on-notification.sh"),
    ),
];

/// Stage the extension under `~/.gemini/extensions/aura-gemini/`, where Gemini
/// discovers it on its next start. Idempotent; overwrites, so an Aura upgrade
/// upgrades the extension.
pub fn stamp_gemini_extension() -> Option<()> {
    let home = std::env::var_os("HOME")?;
    let mut ext_root = std::path::PathBuf::from(home);
    ext_root.push(".gemini");
    ext_root.push("extensions");
    ext_root.push("aura-gemini");
    std::fs::create_dir_all(&ext_root).ok()?;
    for (rel, body) in AURA_GEMINI_FILES {
        crate::write_script(&ext_root.join(rel), body)?;
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_and_the_hooks_file_are_both_staged() {
        // Gemini finds the extension by its manifest and its hooks by the
        // hooks file; either one missing makes the other inert.
        for required in ["gemini-extension.json", "hooks/hooks.json"] {
            assert!(
                AURA_GEMINI_FILES.iter().any(|(rel, _)| *rel == required),
                "{required} is not compiled in",
            );
        }
    }

    #[test]
    fn every_script_the_hooks_file_names_is_compiled_in() {
        // The hooks file is data, and it can name a script that no longer
        // ships. That fails at run time, once per event, in Gemini's own log —
        // so check the two agree here instead.
        let hooks = AURA_GEMINI_FILES
            .iter()
            .find(|(rel, _)| *rel == "hooks/hooks.json")
            .map(|(_, body)| *body)
            .expect("the hooks file is staged");
        for (rel, _) in AURA_GEMINI_FILES {
            let Some(name) = rel.strip_prefix("scripts/") else {
                continue;
            };
            // `should-use-structured.sh` and the notify/payload helpers are
            // sourced by the event scripts rather than named by the manifest.
            if !name.starts_with("on-") {
                continue;
            }
            assert!(
                hooks.contains(name),
                "{name} ships but no hook references it",
            );
        }
    }
}

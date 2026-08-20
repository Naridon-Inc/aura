//! How each manager is asked whether something is there, and told to put it there.
//!
//! A declared package is two shell commands: one that exits 0 when the place
//! already has it, and one that makes it so. Writing both out per project would
//! defeat the point — the whole value of declaring `ripgrep` instead of running
//! `brew install ripgrep` is that the declaration is portable — so the pair is
//! derived from the manager's name.
//!
//! ## Why check-then-install rather than install-always
//!
//! Every place is asked to bring itself to spec repeatedly: a fresh worktree
//! today, the same box tomorrow, a crew agent's throwaway tree fifty times an
//! hour. `brew install ripgrep` on a machine that has ripgrep is thirty wasted
//! seconds; `apt-get update && apt-get install` is rather more, and needs the
//! network. So convergence is the model: ask first, act only on a no, and a
//! place already at spec costs one cheap query per entry.
//!
//! It is also the honest way to report. "Already there" and "I installed it"
//! are different facts about a machine, and a run that says which is which
//! tells you whether your fresh-box story actually works.
//!
//! ## Why the derived commands are conservative
//!
//! Each check below is the cheapest question that manager can answer without
//! extra tooling — no `jq`, no `--json` parsing, nothing that assumes a version
//! of the manager newer than what a long-lived box is likely to have. Where a
//! manager cannot be asked cleanly, the entry may always carry its own `check`
//! and `install`, which win over anything here. The table is a convenience, not
//! a gate: an unrecognised manager is a perfectly legal spec as long as it
//! spells out both commands.

use crate::spec::{Package, Tool};

/// The pair of commands that realise one declared thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Derived {
    /// Exits 0 when the place is already at spec for this entry.
    pub check: Option<String>,
    /// Brings it to spec. `None` means the spec pins a version but says nothing
    /// about how to obtain it — the entry is then check-only, and a place that
    /// falls short reports it rather than pretending.
    pub apply: Option<String>,
    /// A binary that must exist before `apply` can work. Surfaces as its own
    /// preflight step so "mise is not installed on this box" is the message,
    /// rather than `sh: mise: not found` buried in a failed install.
    pub needs: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownManager {
    pub manager: String,
    pub entry: String,
}

impl std::fmt::Display for UnknownManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: Aura doesn't know the `{}` manager — give the entry its own `check` and `install`",
            self.entry, self.manager
        )
    }
}

/// PURE: single-quote a value for `sh`.
///
/// These strings come out of a signed, committed file, so this is not the
/// security boundary — the boundary is the signature. It is here because a
/// package name with a `+` or a version with a space would otherwise be
/// silently mangled into a different command than the one that was reviewed.
pub fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Prefix that defines `$S` as `sudo` unless we are already root. A fresh
/// container runs as root and a developer's box does not; the same declared
/// package has to install on both without the spec knowing which it is on.
const SUDO: &str = r#"S=; [ "$(id -u)" = 0 ] || S=sudo; "#;

/// PURE: the check/install pair for one declared package.
pub fn package_commands(p: &Package) -> Result<Derived, UnknownManager> {
    // An entry that spells out both is complete on its own — the manager name
    // is then only a label, and may be anything.
    if let (Some(check), Some(install)) = (p.check.as_deref(), p.install.as_deref()) {
        return Ok(Derived {
            check: Some(check.to_string()),
            apply: Some(install.to_string()),
            needs: None,
        });
    }

    let n = sq(&p.name);
    let v = p.version.as_deref();
    let derived = match p.manager.as_str() {
        "brew" => Derived {
            check: Some(match v {
                Some(v) => format!("brew list --versions {n} 2>/dev/null | grep -qF {}", sq(v)),
                None => format!("brew list --versions {n} >/dev/null 2>&1"),
            }),
            apply: Some(match v {
                Some(v) => format!("brew install {}", sq(&format!("{}@{}", p.name, v))),
                None => format!("brew install {n}"),
            }),
            needs: Some("brew".into()),
        },
        "apt" | "apt-get" => Derived {
            check: Some(match v {
                Some(v) => format!("dpkg -s {n} 2>/dev/null | grep -qx {}", sq(&format!("Version: {v}"))),
                None => format!("dpkg -s {n} >/dev/null 2>&1"),
            }),
            apply: Some(format!(
                "{SUDO}$S apt-get update && $S apt-get install -y {}",
                match v {
                    Some(v) => sq(&format!("{}={}", p.name, v)),
                    None => n.clone(),
                }
            )),
            needs: Some("apt-get".into()),
        },
        "dnf" | "yum" => Derived {
            check: Some(format!("rpm -q {n} >/dev/null 2>&1")),
            apply: Some(format!(
                "{SUDO}$S dnf install -y {}",
                match v {
                    Some(v) => sq(&format!("{}-{}", p.name, v)),
                    None => n.clone(),
                }
            )),
            needs: Some("dnf".into()),
        },
        "apk" => Derived {
            check: Some(format!("apk info -e {n} >/dev/null 2>&1")),
            apply: Some(format!(
                "{SUDO}$S apk add --no-cache {}",
                match v {
                    Some(v) => sq(&format!("{}={}", p.name, v)),
                    None => n.clone(),
                }
            )),
            needs: Some("apk".into()),
        },
        "cargo" => Derived {
            // `cargo install --list` prints `cargo-nextest v0.9.72:` per crate,
            // so the version is right there and costs no network.
            check: Some(format!(
                "cargo install --list 2>/dev/null | grep -qF {}",
                sq(&match v {
                    Some(v) => format!("{} v{}", p.name, v),
                    None => format!("{} v", p.name),
                })
            )),
            apply: Some(match v {
                Some(v) => format!("cargo install {n} --version {} --locked", sq(v)),
                None => format!("cargo install {n} --locked"),
            }),
            needs: Some("cargo".into()),
        },
        // `npm ls <spec>` exits non-zero when the spec is unmet, which handles
        // scoped names and versions without parsing a tree.
        "npm" => node_style("npm", "npm ls", "npm install", p, v),
        "pnpm" => Derived {
            check: Some(format!(
                "pnpm ls {} --depth 0 2>/dev/null | grep -qF {}",
                scope_flag(p.global, "-g"),
                sq(&match v {
                    Some(v) => format!("{} {}", p.name, v),
                    None => format!("{} ", p.name),
                })
            )),
            apply: Some(format!(
                "pnpm add {} {}",
                scope_flag(p.global, "-g"),
                sq(&spec_at(&p.name, v))
            )),
            needs: Some("pnpm".into()),
        },
        "bun" => Derived {
            check: Some(format!(
                "bun pm ls {} 2>/dev/null | grep -qF {}",
                scope_flag(p.global, "-g"),
                sq(&match v {
                    Some(v) => format!("{}@{}", p.name, v),
                    None => format!("{}@", p.name),
                })
            )),
            apply: Some(format!(
                "bun add {} {}",
                scope_flag(p.global, "-g"),
                sq(&spec_at(&p.name, v))
            )),
            needs: Some("bun".into()),
        },
        "pip" | "pip3" | "python" => Derived {
            check: Some(match v {
                Some(v) => format!(
                    "python3 -m pip show {n} 2>/dev/null | grep -qx {}",
                    sq(&format!("Version: {v}"))
                ),
                None => format!("python3 -m pip show {n} >/dev/null 2>&1"),
            }),
            apply: Some(format!(
                "python3 -m pip install {}",
                match v {
                    Some(v) => sq(&format!("{}=={}", p.name, v)),
                    None => n.clone(),
                }
            )),
            needs: Some("python3".into()),
        },
        "go" => {
            // `go install example.com/cmd/foo@v1` leaves a binary called `foo`;
            // a trailing `/v2` module-major suffix is not part of that name.
            let bin = go_binary(&p.name);
            Derived {
                check: Some(match v {
                    Some(v) => format!(
                        "go version -m \"$(command -v {})\" 2>/dev/null | grep -qF {}",
                        sq(&bin),
                        sq(v)
                    ),
                    None => format!("command -v {} >/dev/null 2>&1", sq(&bin)),
                }),
                apply: Some(format!(
                    "go install {}",
                    sq(&format!("{}@{}", p.name, v.unwrap_or("latest")))
                )),
                needs: Some("go".into()),
            }
        }
        "gem" => Derived {
            check: Some(match v {
                Some(v) => format!("gem list -i {} -v {} >/dev/null 2>&1", sq(&format!("^{}$", p.name)), sq(v)),
                None => format!("gem list -i {} >/dev/null 2>&1", sq(&format!("^{}$", p.name))),
            }),
            apply: Some(match v {
                Some(v) => format!("gem install {n} -v {}", sq(v)),
                None => format!("gem install {n}"),
            }),
            needs: Some("gem".into()),
        },
        other => {
            return Err(UnknownManager {
                manager: other.to_string(),
                entry: format!("package {}", p.name),
            })
        }
    };

    // A hand-written half wins over the derived half, so a project can correct
    // one side of a pair without restating the other.
    Ok(Derived {
        check: p.check.clone().or(derived.check),
        apply: p.install.clone().or(derived.apply),
        needs: derived.needs,
    })
}

fn node_style(
    bin: &str,
    list: &str,
    add: &str,
    p: &Package,
    v: Option<&str>,
) -> Derived {
    let scope = scope_flag(p.global, "-g");
    Derived {
        check: Some(format!(
            "{list} {scope} --depth=0 {} >/dev/null 2>&1",
            sq(&spec_at(&p.name, v))
        )),
        apply: Some(format!("{add} {scope} {}", sq(&spec_at(&p.name, v)))),
        needs: Some(bin.to_string()),
    }
}

fn scope_flag(global: bool, flag: &str) -> &str {
    if global {
        flag
    } else {
        ""
    }
}

fn spec_at(name: &str, version: Option<&str>) -> String {
    match version {
        Some(v) => format!("{name}@{v}"),
        None => name.to_string(),
    }
}

/// PURE: the binary `go install <module>` leaves behind.
fn go_binary(module: &str) -> String {
    let head = module.split('@').next().unwrap_or(module);
    let mut parts = head.rsplit('/').filter(|s| !s.is_empty());
    let last = parts.next().unwrap_or(head);
    // `.../foo/v2` installs `foo`, not `v2`.
    let is_major = last.len() > 1
        && last.starts_with('v')
        && last[1..].chars().all(|c| c.is_ascii_digit());
    if is_major {
        parts.next().unwrap_or(last).to_string()
    } else {
        last.to_string()
    }
}

/// PURE: the check/install pair for one pinned toolchain entry.
///
/// With a manager declared, both sides go through it — asking `mise` what it has
/// installed is reliable in a non-interactive shell, where asking `node
/// --version` is not, because the manager's shims may not be on a
/// non-login `PATH`.
///
/// Without one, the tool is asked directly and there is nothing to install: the
/// spec pinned a version without saying where it comes from, and the honest
/// outcome is a place that reports which version it actually has.
pub fn toolchain_commands(manager: Option<&str>, t: &Tool) -> Result<Derived, UnknownManager> {
    if let (Some(check), Some(install)) = (t.check.as_deref(), t.install.as_deref()) {
        return Ok(Derived {
            check: Some(check.to_string()),
            apply: Some(install.to_string()),
            needs: None,
        });
    }

    let name = sq(&t.name);
    let ver = sq(&t.version);
    let at = sq(&format!("{}@{}", t.name, t.version));

    let derived = match manager {
        None => Derived {
            check: Some(probe_check(&t.name, &t.version)),
            apply: None,
            needs: None,
        },
        Some("mise") => Derived {
            check: Some(format!(
                "mise ls --installed {name} 2>/dev/null | grep -qF {ver}"
            )),
            apply: Some(format!("mise install {at} && mise use -g {at}")),
            needs: Some("mise".into()),
        },
        Some("asdf") => Derived {
            check: Some(format!("asdf list {name} 2>/dev/null | grep -qF {ver}")),
            apply: Some(format!(
                "asdf plugin add {name} >/dev/null 2>&1 || true; asdf install {name} {ver} && asdf global {name} {ver}"
            )),
            needs: Some("asdf".into()),
        },
        Some("proto") => Derived {
            check: Some(format!("proto list {name} 2>/dev/null | grep -qF {ver}")),
            apply: Some(format!("proto install {name} {ver} --pin global")),
            needs: Some("proto".into()),
        },
        Some(other) => {
            return Err(UnknownManager {
                manager: other.to_string(),
                entry: format!("toolchain {}", t.name),
            })
        }
    };

    Ok(Derived {
        check: t.check.clone().or(derived.check),
        apply: t.install.clone().or(derived.apply),
        needs: derived.needs,
    })
}

/// PURE: ask a tool its own version and look for the pinned one in the answer.
///
/// `grep -F` rather than an equality test because every one of these prints its
/// version wrapped in something — `v20.11.0`, `go version go1.22.0 darwin/arm64`,
/// `rustc 1.79.0 (129f3b996 2024-06-10)` — and a spec that pins `20.11.0` means
/// that version, not a particular vendor's way of announcing it.
pub fn probe_check(tool: &str, version: &str) -> String {
    format!("{{ {} ; }} 2>&1 | grep -qF {}", probe(tool), sq(version))
}

fn probe(tool: &str) -> String {
    match tool {
        "node" | "nodejs" => "node --version".into(),
        "rust" | "rustc" => "rustc --version".into(),
        "go" | "golang" => "go version".into(),
        "python" | "python3" => "python3 --version".into(),
        "java" | "jdk" => "java -version".into(),
        "zig" => "zig version".into(),
        "erlang" => "erl -noshell -eval 'io:format(erlang:system_info(otp_release)),halt().'".into(),
        other => format!("{} --version", sq(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkg(manager: &str, name: &str, version: Option<&str>) -> Package {
        Package {
            manager: manager.into(),
            name: name.into(),
            version: version.map(str::to_string),
            global: true,
            check: None,
            install: None,
        }
    }

    #[test]
    fn quoting_survives_an_apostrophe() {
        assert_eq!(sq("it's"), r"'it'\''s'");
    }

    #[test]
    fn every_known_manager_derives_both_halves() {
        for m in [
            "brew", "apt", "dnf", "apk", "cargo", "npm", "pnpm", "bun", "pip", "go", "gem",
        ] {
            let d = package_commands(&pkg(m, "ripgrep", None)).expect(m);
            assert!(d.check.is_some(), "{m} has no check");
            assert!(d.apply.is_some(), "{m} has no install");
            assert!(d.needs.is_some(), "{m} names no binary to preflight");
        }
    }

    #[test]
    fn a_version_reaches_both_halves() {
        let d = package_commands(&pkg("cargo", "cargo-nextest", Some("0.9.72"))).unwrap();
        assert!(d.check.unwrap().contains("cargo-nextest v0.9.72"));
        assert!(d.apply.unwrap().contains("--version '0.9.72'"));
    }

    #[test]
    fn an_unknown_manager_is_an_error_unless_it_brings_its_own_commands() {
        let bare = pkg("nix", "ripgrep", None);
        assert!(package_commands(&bare).is_err());

        let mut spelled = bare.clone();
        spelled.check = Some("which rg".into());
        spelled.install = Some("nix profile install nixpkgs#ripgrep".into());
        let d = package_commands(&spelled).unwrap();
        assert_eq!(d.check.as_deref(), Some("which rg"));
        assert!(d.needs.is_none(), "a self-describing entry needs no preflight");
    }

    #[test]
    fn a_hand_written_half_overrides_only_that_half() {
        let mut p = pkg("brew", "ripgrep", None);
        p.check = Some("command -v rg".into());
        let d = package_commands(&p).unwrap();
        assert_eq!(d.check.as_deref(), Some("command -v rg"));
        assert!(d.apply.unwrap().contains("brew install"));
    }

    #[test]
    fn system_installs_reach_for_sudo_only_when_not_root() {
        let d = package_commands(&pkg("apt", "ripgrep", None)).unwrap();
        let apply = d.apply.unwrap();
        assert!(apply.contains(r#"[ "$(id -u)" = 0 ] || S=sudo"#), "{apply}");
        assert!(apply.contains("$S apt-get install -y 'ripgrep'"), "{apply}");
    }

    #[test]
    fn project_scope_drops_the_global_flag() {
        let mut p = pkg("npm", "vite", None);
        p.global = false;
        let d = package_commands(&p).unwrap();
        assert!(!d.apply.unwrap().contains("-g"));
    }

    #[test]
    fn go_module_paths_reduce_to_the_binary_they_install() {
        assert_eq!(go_binary("github.com/x/y/cmd/foo"), "foo");
        assert_eq!(go_binary("github.com/x/y/v2"), "y");
        assert_eq!(go_binary("foo"), "foo");
        assert_eq!(go_binary("github.com/x/y@v1.2.3"), "y");
    }

    #[test]
    fn a_pinned_tool_without_a_manager_is_check_only() {
        let t = Tool {
            name: "node".into(),
            version: "20.11.0".into(),
            check: None,
            install: None,
        };
        let d = toolchain_commands(None, &t).unwrap();
        assert!(d.apply.is_none(), "nothing said how to obtain it");
        let check = d.check.unwrap();
        assert!(check.contains("node --version"), "{check}");
        assert!(check.contains("grep -qF '20.11.0'"), "{check}");
    }

    #[test]
    fn a_declared_manager_owns_both_halves_and_names_its_binary() {
        let t = Tool {
            name: "node".into(),
            version: "20.11.0".into(),
            check: None,
            install: None,
        };
        for (m, bin) in [("mise", "mise"), ("asdf", "asdf"), ("proto", "proto")] {
            let d = toolchain_commands(Some(m), &t).unwrap();
            assert!(d.check.unwrap().starts_with(m));
            assert!(d.apply.is_some(), "{m}");
            assert_eq!(d.needs.as_deref(), Some(bin));
        }
    }

    #[test]
    fn an_unknown_toolchain_manager_is_an_error() {
        let t = Tool {
            name: "node".into(),
            version: "20".into(),
            check: None,
            install: None,
        };
        assert!(toolchain_commands(Some("nvm"), &t).is_err());
    }

    #[test]
    fn probes_know_the_tools_that_do_not_take_dash_dash_version() {
        assert!(probe_check("go", "1.22").contains("go version"));
        assert!(probe_check("rust", "1.79.0").contains("rustc --version"));
        assert!(probe_check("java", "21").contains("java -version"));
        assert!(probe_check("zig", "0.13").contains("zig version"));
        // Anything unrecognised gets the overwhelmingly common spelling.
        assert!(probe_check("terraform", "1.8").contains("'terraform' --version"));
    }
}

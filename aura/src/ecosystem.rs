use std::fs;
use std::path::Path;
use std::process::Command;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub enum Ecosystem {
    Python,
    Node,
    Rust,
    Unknown,
}

impl Ecosystem {
    /// Detects the primary programming language ecosystem of the current directory.
    pub fn detect() -> Self {
        if Path::new("requirements.txt").exists() || Path::new("pyproject.toml").exists() || Path::new("setup.py").exists() {
            return Ecosystem::Python;
        }
        if Path::new("package.json").exists() {
            return Ecosystem::Node;
        }
        if Path::new("Cargo.toml").exists() {
            return Ecosystem::Rust;
        }
        
        // Fallback: Check for common file extensions if no manifest is found
        if let Ok(entries) = fs::read_dir(".") {
            for entry in entries.flatten() {
                if let Some(ext) = entry.path().extension() {
                    if ext == "py" { return Ecosystem::Python; }
                    if ext == "js" || ext == "ts" { return Ecosystem::Node; }
                    if ext == "rs" { return Ecosystem::Rust; }
                }
            }
        }

        Ecosystem::Unknown
    }

    /// Executes the correct package manager to generate a cryptographic hash of the environment.
    pub fn fingerprint() -> Option<String> {
        // KILL SHOT FIX: Stop using transitive tree commands (npm list, pip freeze) because they are noisy.
        // Hash the stable lockfiles or toolchain versions instead.
        let mut hasher = DefaultHasher::new();
        
        let file_to_hash = match Self::detect() {
            Ecosystem::Python => "poetry.lock", // Assume poetry/uv for stable lockfiles, fallback to pyproject
            Ecosystem::Node => "package-lock.json",
            Ecosystem::Rust => "Cargo.lock",
            Ecosystem::Unknown => return None,
        };

        if let Ok(content) = fs::read_to_string(file_to_hash) {
            content.hash(&mut hasher);
            return Some(format!("env_{:x}", hasher.finish()));
        } else {
             // Fallback: Hash the toolchain version if no lockfile exists
             let cmd = match Self::detect() {
                 Ecosystem::Python => "python3",
                 Ecosystem::Node => "node",
                 Ecosystem::Rust => "rustc",
                 Ecosystem::Unknown => return None,
             };
             
             if let Ok(output) = Command::new(cmd).arg("-V").output() {
                 if output.status.success() {
                     String::from_utf8_lossy(&output.stdout).hash(&mut hasher);
                     return Some(format!("env_{:x}", hasher.finish()));
                 }
             }
        }
        None
    }
}

//! What Aura needs to know before it can make a machine for somebody.
//!
//! Managed mode spends a real cloud account, and which account — which region,
//! which image, which network, which key — is an operator's decision, not a
//! default this file gets to invent. So the settings are read from disk
//! (`~/.aura/managed-cloud.json`) and their ABSENCE is the switch: no file
//! means Aura is not set up to make machines here, which is a true and
//! actionable thing to tell someone, and it is why the desktop can ship this
//! driver turned off without shipping a hole.
//!
//! ## What is not in here
//!
//! No secret. The file holds names and ids; the credential that spends the
//! account comes from the process environment (see [`super::aws`]), so the one
//! thing worth stealing is never written to a path a backup tool walks. The
//! same reasoning as the machine book next door, one step further: that file is
//! `0600` because it names your servers, and this one holds nothing that would
//! matter if it leaked.
//!
//! `key_ref` gets the same treatment the runner registry gives its column — a
//! reference, never a key — and is checked for it here rather than trusted,
//! because a hand-edited config is exactly where somebody pastes a `.pem` to
//! see if it works.

use serde::{Deserialize, Serialize};

/// The longest a key reference may be. A reference — a keychain item, a
/// managed-key id — fits in far less; key material does not. The same cap the
/// cloud's own column uses, for the same reason.
const KEY_REF_MAX_LEN: usize = 256;

/// Everything the driver needs, resolved and checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedSettings {
    /// Which cloud. The one field that decides which driver is built.
    pub substrate: String,
    /// Where the machine is made.
    pub region: String,
    /// The image it boots. Paired with the machine classes in
    /// [`super::plan`] — those are 64-bit ARM sizes, so this has to be an ARM
    /// image, and an operator who changes one changes both.
    pub image_id: String,
    /// The login the work runs as on the box. `ubuntu` on the images the
    /// existing recipe uses.
    pub ssh_user: String,
    /// The key pair the substrate is told to launch with.
    pub key_pair: String,
    /// What gets written on the machine's row — a reference to the key Aura
    /// holds, never the key.
    pub key_ref: String,
    /// The network the machine sits in, by the substrate's name for it.
    pub security_group: String,
    /// Where checkouts live on the box. A project's directory is made under
    /// this, so a shell lands in the repo rather than in an empty home.
    pub home: String,
    /// Disk, in gigabytes.
    pub disk_gb: u32,
}

/// The file as it is written, before anything is checked.
///
/// Separate from [`ManagedSettings`] so the optional-with-a-default fields are
/// optional in exactly one place. A config that omits `ssh_user` is not broken
/// — it is a config for the ordinary image, and the ordinary image's login is
/// `ubuntu`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredSettings {
    #[serde(default)]
    pub substrate: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub image_id: Option<String>,
    #[serde(default)]
    pub ssh_user: Option<String>,
    #[serde(default)]
    pub key_pair: Option<String>,
    #[serde(default)]
    pub key_ref: Option<String>,
    #[serde(default)]
    pub security_group: Option<String>,
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default)]
    pub disk_gb: Option<u32>,
}

/// The one substrate wired today. Named as a constant so the settings file, the
/// driver factory and the error message that lists what is available all say
/// the same word.
pub const AWS_EC2: &str = "aws-ec2";

/// The login on the images the existing recipe builds against.
const DEFAULT_SSH_USER: &str = "ubuntu";

/// Disk for a managed box. Matches the recipe's `VOLUME_GB` — a cold Rust build
/// does not fit in the image's own 8 GB, and a box that runs out of disk
/// halfway through its first build looks like a broken product.
const DEFAULT_DISK_GB: u32 = 40;

/// What we found when we looked for a setup.
///
/// Three answers, not two, because "there is no setup" and "the setup is wrong"
/// send a person to different places. Folding them together is how a typo in a
/// region name comes out as "managed machines aren't available yet" and nobody
/// ever finds the file.
#[derive(Debug)]
pub enum Configured {
    /// No setup at all. Managed mode is simply off on this install.
    Absent,
    /// A setup that does not add up, and what is wrong with it.
    Broken(String),
    Ready(Box<ManagedSettings>),
}

/// Where the setup is kept, next to the credentials and the machine book.
fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::cloud_session_sync::aura_dir()?.join("managed-cloud.json"))
}

/// Read the setup, if there is one.
pub fn configured() -> Configured {
    let path = match settings_path() {
        Ok(p) => p,
        // No home directory to look in is not a broken setup — it is no setup.
        Err(_) => return Configured::Absent,
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return Configured::Absent,
    };
    from_json(&raw)
}

/// The same decision, from the file's text. Split out so every rule below can
/// be asserted without writing into somebody's home directory.
pub fn from_json(raw: &str) -> Configured {
    // A blank file is somebody who made the file and has not filled it in yet.
    // Telling them fourteen fields are missing is less useful than telling them
    // managed mode is off, which is what an empty file means.
    if raw.trim().is_empty() {
        return Configured::Absent;
    }
    let stored: StoredSettings = match serde_json::from_str(raw) {
        Ok(s) => s,
        Err(e) => {
            return Configured::Broken(format!(
                "the setup file for Aura-made machines can't be read: {e}"
            ))
        }
    };
    match resolve(stored) {
        Ok(s) => Configured::Ready(Box::new(s)),
        Err(why) => Configured::Broken(why),
    }
}

/// Turn a written setup into a usable one, or say what is missing.
///
/// Every message names the field as it is spelled in the file, because the
/// person reading it has that file open.
fn resolve(stored: StoredSettings) -> Result<ManagedSettings, String> {
    let substrate = required(stored.substrate, "substrate")?;
    if substrate != AWS_EC2 {
        return Err(format!(
            "the setup names a cloud called {substrate:?}, and the only one Aura can make \
             machines in is {AWS_EC2:?}"
        ));
    }
    let ssh_user = optional(stored.ssh_user).unwrap_or_else(|| DEFAULT_SSH_USER.to_string());
    let home = match optional(stored.home) {
        Some(home) => home,
        // Derived from the login rather than fixed, so a config that changes
        // one and forgets the other still lands the checkout in a directory
        // that login owns.
        None => format!("/home/{ssh_user}"),
    };
    if !home.starts_with('/') {
        return Err(format!(
            "\"home\" is {home:?}, which is not a full path — a machine needs to be told \
             where its projects live, starting from /"
        ));
    }

    let key_ref = required(stored.key_ref, "key_ref")?;
    check_is_a_reference(&key_ref)?;

    Ok(ManagedSettings {
        substrate,
        region: required(stored.region, "region")?,
        image_id: required(stored.image_id, "image_id")?,
        key_pair: required(stored.key_pair, "key_pair")?,
        key_ref,
        security_group: required(stored.security_group, "security_group")?,
        ssh_user,
        home,
        disk_gb: stored.disk_gb.filter(|gb| *gb > 0).unwrap_or(DEFAULT_DISK_GB),
    })
}

fn optional(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn required(value: Option<String>, field: &str) -> Result<String, String> {
    optional(value).ok_or_else(|| {
        format!("the setup for Aura-made machines has no {field:?} — nothing can be made without it")
    })
}

/// Refuse a `key_ref` that is a key rather than a name for one.
///
/// The cloud's own column is guarded twice — at its handler and by a database
/// constraint — because that column is shared and durable. This one is neither,
/// and it is still guarded, because the file is hand-edited and pasting the
/// `.pem` in to see if it works is the obvious thing to try. What is at stake is
/// the same either way: the reference travels, and anything that travels must
/// not be the secret.
fn check_is_a_reference(key_ref: &str) -> Result<(), String> {
    let complaint = "\"key_ref\" must be a NAME for a key — a keychain item, or a managed key \
                     id like \"managed:<id>\". Aura never wants the key itself here";
    if key_ref.len() > KEY_REF_MAX_LEN {
        return Err(format!("{complaint} (this one is far too long to be a name)"));
    }
    if key_ref.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{complaint} (this one has spaces or line breaks in it)"));
    }
    let upper = key_ref.to_ascii_uppercase();
    if upper.contains("-----BEGIN") || upper.contains("PRIVATE KEY") {
        return Err(format!("{complaint} (this one looks like the key)"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> serde_json::Value {
        serde_json::json!({
            "substrate": AWS_EC2,
            "region": "eu-central-1",
            "image_id": "ami-0123456789abcdef0",
            "key_pair": "aura-managed",
            "key_ref": "managed:2f9c1f8e-0b2a-4d55-9a44-1c2d3e4f5a6b",
            "security_group": "aura-managed",
        })
    }

    fn ready(v: serde_json::Value) -> ManagedSettings {
        match from_json(&v.to_string()) {
            Configured::Ready(s) => *s,
            other => panic!("expected a usable setup, got {other:?}"),
        }
    }

    fn broken(v: serde_json::Value) -> String {
        match from_json(&v.to_string()) {
            Configured::Broken(why) => why,
            other => panic!("expected a complaint, got {other:?}"),
        }
    }

    #[test]
    fn no_file_is_not_a_broken_file() {
        // The distinction the whole enum exists for. An install that never set
        // managed mode up is told managed mode is off; an install that set it
        // up wrong is told what is wrong. Collapsing these hides every typo
        // behind "not available yet".
        assert!(matches!(from_json(""), Configured::Absent));
        assert!(matches!(from_json("   \n"), Configured::Absent));
        assert!(matches!(from_json("{ not json"), Configured::Broken(_)));
    }

    #[test]
    fn a_field_that_is_missing_is_named_in_the_complaint() {
        // The person reading this has the file open. "Invalid configuration"
        // sends them to a search engine; the field's own spelling sends them to
        // the line.
        for field in ["region", "image_id", "key_pair", "key_ref", "security_group"] {
            let mut v = full();
            v.as_object_mut().expect("an object").remove(field);
            let why = broken(v);
            assert!(why.contains(field), "{field} was missing and the complaint was: {why}");
        }
    }

    #[test]
    fn a_blank_field_is_a_missing_field() {
        // A key left as `"region": ""` is somebody who meant to come back to
        // it. Accepting it produces a request to a region that does not exist
        // and an error from the far side that names none of this.
        let mut v = full();
        v["region"] = serde_json::json!("   ");
        assert!(broken(v).contains("region"));
    }

    #[test]
    fn the_login_and_its_home_move_together() {
        // Left out, both come from the image the recipe builds against.
        let s = ready(full());
        assert_eq!(s.ssh_user, "ubuntu");
        assert_eq!(s.home, "/home/ubuntu");

        // Changed, the home follows — otherwise the checkout lands in a
        // directory the login does not own and every write on the box fails
        // with a permission error nobody can connect back to this file.
        let mut v = full();
        v["ssh_user"] = serde_json::json!("aura");
        assert_eq!(ready(v).home, "/home/aura");

        // Said explicitly, what was said wins.
        let mut v = full();
        v["home"] = serde_json::json!("/srv/projects");
        assert_eq!(ready(v).home, "/srv/projects");
    }

    #[test]
    fn a_home_that_is_not_a_full_path_is_refused() {
        // Every path this produces is used on the far side of a connection,
        // where "relative to what" has no answer we control.
        let mut v = full();
        v["home"] = serde_json::json!("projects");
        assert!(broken(v).contains("full path"));
    }

    #[test]
    fn a_disk_of_zero_is_not_a_disk() {
        let mut v = full();
        v["disk_gb"] = serde_json::json!(0);
        assert_eq!(ready(v).disk_gb, DEFAULT_DISK_GB);
        let mut v = full();
        v["disk_gb"] = serde_json::json!(200);
        assert_eq!(ready(v).disk_gb, 200);
    }

    #[test]
    fn a_cloud_aura_cannot_make_machines_in_is_refused_by_name() {
        // The swap point, guarded. A setup naming a substrate we have no driver
        // for must not fall through to the one we do have — that would make a
        // machine in the wrong cloud and bill somebody for it.
        let mut v = full();
        v["substrate"] = serde_json::json!("fly");
        let why = broken(v);
        assert!(why.contains("fly"), "{why}");
        assert!(why.contains(AWS_EC2), "{why}");
    }

    #[test]
    fn a_pasted_key_is_refused_where_a_name_belongs() {
        // The failure this guard is really about: somebody with the file open
        // pastes the `.pem` to see if it works, and from then on the secret is
        // in whatever the reference is copied into.
        for pasted in [
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----begin rsa private key-----",
            "my private key",
        ] {
            let mut v = full();
            v["key_ref"] = serde_json::json!(pasted);
            let why = broken(v);
            assert!(why.contains("NAME for a key"), "{pasted:?} was accepted: {why}");
        }

        // A reference with a line break in it is armour that lost its header.
        let mut v = full();
        v["key_ref"] = serde_json::json!("managed:abc\ndef");
        assert!(broken(v).contains("line breaks"));

        // And length alone puts every real private key out of reach.
        let mut v = full();
        v["key_ref"] = serde_json::json!("m".repeat(KEY_REF_MAX_LEN + 1));
        assert!(broken(v).contains("too long"));
    }

    #[test]
    fn an_ordinary_reference_passes() {
        for name in [
            "managed:2f9c1f8e-0b2a-4d55-9a44-1c2d3e4f5a6b",
            "keychain:aura-managed-eu",
            "SHA256:0123456789abcdef0123456789abcdef01234567",
        ] {
            let mut v = full();
            v["key_ref"] = serde_json::json!(name);
            assert_eq!(ready(v).key_ref, name);
        }
    }
}

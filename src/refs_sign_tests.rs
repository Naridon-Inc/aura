// Hermetic tests for `aura refs sign/verify/push/pull` (M4b slice 1).
// Everything runs in tmp dirs against a LOCAL bare repo standing in for
// "origin" — zero network. Library functions are called directly; the
// `git` binary is shelled out only for transport (clone/push/fetch on
// local paths), mirroring exactly what the commands do.

use super::{
    load_repo_identity, merge_incoming_sigs, parse_sig_line, render_sig_line, sign_ref,
    signing_payload, union_sig_lines, verify_ref, write_sig_note, LineStatus, RefStatus, SigLine,
    SIGS_INCOMING_REF, SIGS_REF,
};
use aura_attestation::SigningKey;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use git2::{Repository, Signature, Time};
use std::path::Path;
use std::process::Command;

// ---------- helpers ----------

fn sh_git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {:?} failed in {:?}: {}",
        args,
        dir,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn commit_file(repo: &Repository, name: &str, content: &str, msg: &str) -> git2::Oid {
    let workdir = repo.workdir().expect("non-bare");
    std::fs::write(workdir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = Signature::new("Dev", "dev@x.com", &Time::new(1_700_000_000, 0)).unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
        .unwrap()
}

/// Fresh non-bare repo on branch `canon` with one commit.
fn repo_with_commit(dir: &Path) -> Repository {
    sh_git(dir, &["init", "-b", "canon", "."]);
    let repo = Repository::open(dir).unwrap();
    commit_file(&repo, "a.txt", "a", "feat: first");
    repo
}

/// Create the repo-local identity EXACTLY where `aura identity` puts it.
fn fixture_identity(repo: &Repository) -> SigningKey {
    let path = repo
        .workdir()
        .unwrap()
        .join(".aura")
        .join("awareness")
        .join("identity.key");
    aura_attestation::load_or_create(&path).unwrap()
}

// ---------- unit: payload + line ser/de ----------

#[test]
fn payload_format_is_byte_exact() {
    // Verifiers reproduce this string byte-for-byte; pin it.
    assert_eq!(
        signing_payload("refs/heads/main", "abc123", 42),
        "aura-ref-sig\nrefs/heads/main\nabc123\n42"
    );
}

#[test]
fn sig_line_render_parse_roundtrips_and_field_order_is_fixed() {
    let line = SigLine {
        ref_name: "refs/heads/main".into(),
        oid: "deadbeef".into(),
        signer: "Owner".into(),
        key_id: "did:aura:key/AAAAAAAAAAA".into(),
        pubkey: Some("cGs".into()),
        sig: "c2ln".into(),
        ts: 7,
    };
    let rendered = render_sig_line(&line);
    assert_eq!(
        rendered,
        r#"{"ref":"refs/heads/main","oid":"deadbeef","signer":"Owner","key_id":"did:aura:key/AAAAAAAAAAA","pubkey":"cGs","sig":"c2ln","ts":7}"#
    );
    assert_eq!(parse_sig_line(&rendered).unwrap(), line);
}

#[test]
fn parse_sig_line_tolerates_missing_pubkey_and_rejects_garbage() {
    let no_pubkey =
        r#"{"ref":"refs/heads/x","oid":"o","signer":"s","key_id":"k","sig":"g","ts":1}"#;
    let parsed = parse_sig_line(no_pubkey).unwrap();
    assert_eq!(parsed.pubkey, None);

    assert!(parse_sig_line("").is_none());
    assert!(parse_sig_line("not json").is_none());
    // Structurally incomplete: no sig.
    assert!(parse_sig_line(r#"{"ref":"r","oid":"o","key_id":"k","ts":1}"#).is_none());
}

// ---------- unit: union merge ----------

fn line_with(key_id: &str, oid: &str, ts: u64) -> String {
    render_sig_line(&SigLine {
        ref_name: "refs/heads/canon".into(),
        oid: oid.into(),
        signer: "s".into(),
        key_id: key_id.into(),
        pubkey: None,
        sig: "g".into(),
        ts,
    })
}

#[test]
fn union_dedupes_on_ref_oid_key_and_newest_ts_wins() {
    let old = line_with("k1", "o1", 100);
    let newer = line_with("k1", "o1", 200);
    let other_key = line_with("k2", "o1", 150);

    let (body, changed) = union_sig_lines(Some(&format!("{}\n", old)), &[newer.clone()]);
    assert_eq!(changed, 1, "newer ts replaces");
    assert_eq!(body, format!("{}\n", newer));

    // Older addition does NOT replace a newer existing line.
    let (body2, changed2) = union_sig_lines(Some(&body), &[old.clone()]);
    assert_eq!(changed2, 0);
    assert_eq!(body2, body);

    // A different key_id on the same (ref, oid) coexists — that is the
    // reserved room for future delegate quorum.
    let (body3, changed3) = union_sig_lines(Some(&body), &[other_key.clone()]);
    assert_eq!(changed3, 1);
    assert_eq!(body3, format!("{}\n{}\n", newer, other_key));
}

#[test]
fn union_is_idempotent_and_preserves_foreign_lines() {
    let mine = line_with("k1", "o1", 100);
    let foreign = "some future format we cannot parse".to_string();
    let (first, c1) = union_sig_lines(None, &[mine.clone(), foreign.clone()]);
    assert_eq!(c1, 2);
    let (second, c2) = union_sig_lines(Some(&first), &[mine, foreign]);
    assert_eq!(c2, 0);
    assert_eq!(first, second);
}

// ---------- identity guidance ----------

#[test]
fn sign_without_identity_fails_with_create_guidance() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let err = load_repo_identity(&repo).unwrap_err();
    assert!(
        err.contains("aura identity"),
        "must point at the existing creation command, got: {}",
        err
    );
    assert!(
        err.contains("never generates keys silently"),
        "must state the no-silent-keys policy, got: {}",
        err
    );
}

// ---------- sign → verify ----------

#[test]
fn sign_then_verify_valid_on_current_branch_default_ref() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let sk = fixture_identity(&repo);

    let report = sign_ref(&repo, None, &sk, "Owner", 1_000).unwrap();
    assert_eq!(report.ref_name, "refs/heads/canon");
    assert_eq!(report.key_id, sk.key_id());
    assert!(report.updated);

    // Verify WITHOUT a local key: the embedded pubkey self-certifies.
    let v = verify_ref(&repo, None, None, 1_060).unwrap();
    assert_eq!(v.status, RefStatus::Valid);
    assert_eq!(v.signatures.len(), 1);
    assert_eq!(v.signatures[0].status, LineStatus::Valid);
    assert_eq!(v.signatures[0].signer, "Owner");
    assert_eq!(v.signatures[0].key_id, sk.key_id());
    assert_eq!(v.signatures[0].age_secs, 60);
}

#[test]
fn resign_same_tip_is_idempotent_and_newest_ts_wins() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let sk = fixture_identity(&repo);

    let first = sign_ref(&repo, Some("canon"), &sk, "Owner", 100).unwrap();
    assert!(first.updated);
    // Same second: identical line (ed25519 is deterministic) → no-op.
    let same = sign_ref(&repo, Some("canon"), &sk, "Owner", 100).unwrap();
    assert!(!same.updated);
    // Later second: replaced in place, still exactly one line.
    let later = sign_ref(&repo, Some("canon"), &sk, "Owner", 200).unwrap();
    assert!(later.updated);

    let tip = repo.head().unwrap().peel_to_commit().unwrap().id();
    let body = crate::meta_refs::notes::note_body(&repo, SIGS_REF, tip).unwrap();
    let lines: Vec<SigLine> = body.lines().filter_map(parse_sig_line).collect();
    assert_eq!(lines.len(), 1, "deduped on (ref, oid, key_id): {}", body);
    assert_eq!(lines[0].ts, 200);

    let v = verify_ref(&repo, Some("canon"), None, 200).unwrap();
    assert_eq!(v.status, RefStatus::Valid);
}

#[test]
fn branch_moved_since_signing_reads_unsigned() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let sk = fixture_identity(&repo);

    sign_ref(&repo, None, &sk, "Owner", 100).unwrap();
    // The branch moves: the endorsement stays on the OLD tip.
    commit_file(&repo, "b.txt", "b", "feat: second");

    let v = verify_ref(&repo, None, None, 200).unwrap();
    assert_eq!(v.status, RefStatus::Unsigned);
    assert!(v.signatures.is_empty());
}

#[test]
fn tampered_oid_reads_invalid() {
    // Attack: re-point a signed endorsement at a DIFFERENT commit — take
    // the line signed for C1, rewrite its oid to C2, attach it as the
    // note on C2. The sig was computed over C1's payload → INVALID.
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let sk = fixture_identity(&repo);

    let c1 = repo.head().unwrap().peel_to_commit().unwrap().id();
    sign_ref(&repo, None, &sk, "Owner", 100).unwrap();
    let c2 = commit_file(&repo, "b.txt", "b", "feat: second");

    let signed_body = crate::meta_refs::notes::note_body(&repo, SIGS_REF, c1).unwrap();
    let tampered = signed_body.replace(&c1.to_string(), &c2.to_string());
    assert_ne!(signed_body, tampered, "tamper must actually change the line");
    write_sig_note(&repo, c2, &[tampered.trim().to_string()]).unwrap();

    let v = verify_ref(&repo, None, None, 200).unwrap();
    assert_eq!(v.status, RefStatus::Invalid);
    assert_eq!(v.signatures.len(), 1);
    assert_eq!(v.signatures[0].status, LineStatus::Invalid);
    assert!(v.signatures[0]
        .reason
        .as_deref()
        .unwrap()
        .contains("does not verify"));
}

#[test]
fn forged_key_id_binding_reads_invalid() {
    // A line whose embedded pubkey does NOT derive the claimed key_id is
    // a forged identity binding — INVALID, not unknown.
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let sk = fixture_identity(&repo);
    let other = SigningKey::from_seed([9u8; 32]);

    let tip = repo.head().unwrap().peel_to_commit().unwrap().id();
    let payload = signing_payload("refs/heads/canon", &tip.to_string(), 100);
    let line = SigLine {
        ref_name: "refs/heads/canon".into(),
        oid: tip.to_string(),
        signer: "Mallory".into(),
        // Claims sk's identity…
        key_id: sk.key_id(),
        // …but embeds other's pubkey (which signed the payload).
        pubkey: Some(B64URL.encode(other.verifying_key().to_bytes())),
        sig: other.sign(payload.as_bytes()).to_b64(),
        ts: 100,
    };
    write_sig_note(&repo, tip, &[render_sig_line(&line)]).unwrap();

    let v = verify_ref(&repo, None, None, 200).unwrap();
    assert_eq!(v.status, RefStatus::Invalid);
    assert!(v.signatures[0]
        .reason
        .as_deref()
        .unwrap()
        .contains("but the line claims"));
}

#[test]
fn unresolvable_key_reads_unknown_key_not_invalid() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let local = fixture_identity(&repo);

    let tip = repo.head().unwrap().peel_to_commit().unwrap().id();
    // A peer's line WITHOUT an embedded pubkey, key_id ≠ local identity:
    // nothing failed cryptographically — we simply cannot check it.
    let line = SigLine {
        ref_name: "refs/heads/canon".into(),
        oid: tip.to_string(),
        signer: "peer".into(),
        key_id: "did:aura:key/zzzzzzzzzzz".into(),
        pubkey: None,
        sig: SigningKey::from_seed([3u8; 32])
            .sign(b"whatever")
            .to_b64(),
        ts: 100,
    };
    write_sig_note(&repo, tip, &[render_sig_line(&line)]).unwrap();

    let v = verify_ref(&repo, None, Some(&local), 200).unwrap();
    assert_eq!(v.status, RefStatus::UnknownKey);
    assert_eq!(v.signatures[0].status, LineStatus::UnknownKey);
    assert!(v.signatures[0]
        .reason
        .as_deref()
        .unwrap()
        .contains("does not match the local identity"));
}

#[test]
fn local_identity_resolves_lines_without_embedded_pubkey() {
    // The "existing identity path": a line that carries only key_id (no
    // pubkey) still verifies when the key_id matches the LOCAL keyfile —
    // the same place `aura identity` / radar signing keep the key.
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let sk = fixture_identity(&repo);

    let tip = repo.head().unwrap().peel_to_commit().unwrap().id();
    let payload = signing_payload("refs/heads/canon", &tip.to_string(), 100);
    let line = SigLine {
        ref_name: "refs/heads/canon".into(),
        oid: tip.to_string(),
        signer: "Owner".into(),
        key_id: sk.key_id(),
        pubkey: None,
        sig: sk.sign(payload.as_bytes()).to_b64(),
        ts: 100,
    };
    write_sig_note(&repo, tip, &[render_sig_line(&line)]).unwrap();

    // Without the local key it is unknown…
    let without = verify_ref(&repo, None, None, 200).unwrap();
    assert_eq!(without.status, RefStatus::UnknownKey);
    // …with it, valid.
    let with = verify_ref(&repo, None, Some(&sk), 200).unwrap();
    assert_eq!(with.status, RefStatus::Valid);
}

#[test]
fn one_valid_line_outranks_a_bad_neighbour() {
    // Slice-1 semantics: ≥1 good sig ⇒ VALID even when another line on
    // the same tip is junk (the junk stays visible in the line reports).
    let tmp = tempfile::tempdir().unwrap();
    let repo = repo_with_commit(tmp.path());
    let sk = fixture_identity(&repo);

    sign_ref(&repo, None, &sk, "Owner", 100).unwrap();
    let tip = repo.head().unwrap().peel_to_commit().unwrap().id();
    let junk = SigLine {
        ref_name: "refs/heads/canon".into(),
        oid: tip.to_string(),
        signer: "Mallory".into(),
        key_id: "did:aura:key/badbadbadba".into(),
        pubkey: Some(B64URL.encode([7u8; 32])),
        sig: SigningKey::from_seed([4u8; 32]).sign(b"junk").to_b64(),
        ts: 150,
    };
    write_sig_note(&repo, tip, &[render_sig_line(&junk)]).unwrap();

    let v = verify_ref(&repo, None, None, 200).unwrap();
    assert_eq!(v.status, RefStatus::Valid);
    assert_eq!(v.signatures.len(), 2);
    assert!(v.signatures.iter().any(|l| l.status == LineStatus::Valid));
    assert!(v
        .signatures
        .iter()
        .any(|l| l.status != LineStatus::Valid));
}

// ---------- round-trip through a local bare origin ----------

#[test]
fn round_trip_through_local_bare_origin() {
    // A signs its branch tip and pushes the aura-sigs notes ref; B
    // clones, pulls the ref (fetch into staging + union merge — exactly
    // what `aura refs pull` does) and verifies VALID.
    //
    // Key distribution, the real story: B never needs a key fixture or a
    // side channel. A's full Ed25519 pubkey travels INSIDE the signature
    // line; B checks the pubkey derives the claimed key_id and that the
    // signature verifies. What stays out-of-band is only TRUST in the
    // key_id (B compares it with what A's `aura identity` prints).
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    let a_dir = tmp.path().join("a");
    let b_dir = tmp.path().join("b");

    sh_git(tmp.path(), &["init", "--bare", origin.to_str().unwrap()]);
    sh_git(
        tmp.path(),
        &["clone", origin.to_str().unwrap(), a_dir.to_str().unwrap()],
    );
    sh_git(&a_dir, &["checkout", "-b", "canon"]);

    let repo_a = Repository::open(&a_dir).unwrap();
    commit_file(&repo_a, "f.txt", "f", "feat: shared");
    sh_git(&a_dir, &["push", "origin", "canon"]);

    let sk_a = fixture_identity(&repo_a);
    let signed = sign_ref(&repo_a, Some("canon"), &sk_a, "Alice", 1_000).unwrap();
    assert_eq!(signed.ref_name, "refs/heads/canon");
    sh_git(&a_dir, &["push", "origin", SIGS_REF]);

    // The plane is plain git: the bare origin itself carries the ref.
    let ls = sh_git(&origin, &["for-each-ref", "refs/notes"]);
    assert!(ls.contains("refs/notes/aura-sigs"), "origin holds: {}", ls);

    // --- B's side ---
    sh_git(
        tmp.path(),
        &[
            "clone",
            "-b",
            "canon",
            origin.to_str().unwrap(),
            b_dir.to_str().unwrap(),
        ],
    );
    let repo_b = Repository::open(&b_dir).unwrap();
    let refspec = format!("+{}:{}", SIGS_REF, SIGS_INCOMING_REF);
    sh_git(&b_dir, &["fetch", "origin", &refspec]);

    let pull = merge_incoming_sigs(&repo_b).unwrap();
    assert!(pull.incoming_present);
    assert_eq!(pull.commits_seen, 1);
    assert_eq!(pull.commits_updated, 1);
    assert_eq!(pull.lines_changed, 1);
    assert!(repo_b.find_reference(SIGS_INCOMING_REF).is_err());
    assert!(repo_b.find_reference(SIGS_REF).is_ok());

    // B has NO identity of its own — verification rests purely on the
    // self-certifying line.
    let v = verify_ref(&repo_b, Some("canon"), None, 2_000).unwrap();
    assert_eq!(v.status, RefStatus::Valid);
    assert_eq!(v.signatures.len(), 1);
    assert_eq!(v.signatures[0].key_id, sk_a.key_id());
    assert_eq!(v.signatures[0].signer, "Alice");

    // Pulling again is a no-op (union semantics).
    sh_git(&b_dir, &["fetch", "origin", &refspec]);
    let pull2 = merge_incoming_sigs(&repo_b).unwrap();
    assert!(pull2.incoming_present);
    assert_eq!(pull2.lines_changed, 0);
    assert_eq!(pull2.commits_updated, 0);

    // B endorses the same tip with ITS OWN identity: both lines coexist
    // on the note — the reserved room for future delegate quorum.
    let sk_b = fixture_identity(&repo_b);
    assert_ne!(sk_b.key_id(), sk_a.key_id());
    sign_ref(&repo_b, Some("canon"), &sk_b, "Bob", 2_100).unwrap();
    let v2 = verify_ref(&repo_b, Some("canon"), None, 2_200).unwrap();
    assert_eq!(v2.status, RefStatus::Valid);
    assert_eq!(v2.signatures.len(), 2);
    assert!(v2.signatures.iter().all(|l| l.status == LineStatus::Valid));
}

# aura-shell release process

This is the source of truth for cutting an aura-shell release across
macOS, Linux, and Windows. There are two CI workflows in play:

| Workflow | File | Triggers | Platforms |
| --- | --- | --- | --- |
| Cross-platform release | `.github/workflows/aura-shell-release.yml` | tag `aura-shell-v*` | macOS (arm64 + Intel), Linux, Windows |
| Windows-only release | `.github/workflows/aura-shell-release-windows.yml` | tag `v*` | Windows x86_64 |
| Dev build | `.github/workflows/aura-shell-dev-build.yml` | `workflow_dispatch`, push to `dev-build/**` | All four (unsigned) |

The Windows-only workflow (JJ.1, task #326) exists so we can ship a
signed Windows MSI on a `v*` tag without having to coordinate macOS
notarization in the same job. It runs in parallel with the
cross-platform workflow on tags that match both patterns.

---

## Cutting a release

### 1. Bump the version

Edit all three in lockstep:

- `aura-shell/package.json` → `version`
- `aura-shell/src-tauri/tauri.conf.json` → `version`
- `aura-shell/src-tauri/Cargo.toml` → `[package].version`

Commit with the message `chore(shell): bump version to <x.y.z> for ship`.

### 2. Push the tag

For the cross-platform release (recommended for normal ships):

```sh
git tag aura-shell-v0.2.31
git push origin aura-shell-v0.2.31
```

For a Windows-only re-ship (e.g. you only need to patch the Windows
bundle without rebuilding macOS):

```sh
git tag v0.2.31
git push origin v0.2.31
```

The Windows-only workflow listens to `v*`, so any release-style tag
will trigger it.

### 3. Wait for green checks

Both workflows publish to the same GitHub Release for the pushed
tag — `softprops/action-gh-release` upserts. Expected artifacts on a
fully-signed Windows run:

- `Aura_<version>_x64_en-US.msi`
- `Aura_<version>_x64-setup.exe` (NSIS installer)
- `latest.json` (updater manifest, only when `TAURI_SIGNING_PRIVATE_KEY` is set)

---

## Windows signing

### Signed path (preferred)

The Windows-only workflow signs MSI + NSIS artifacts with `signtool.exe`
when **both** of these repo secrets are configured at
`github.com/MHASK/aura-sovereign/settings/secrets/actions`:

| Secret | Contents |
| --- | --- |
| `WINDOWS_SIGN_CERT_BASE64` | Base64-encoded `.pfx` from your code-signing CA (DigiCert, SSL.com, Sectigo, etc.) |
| `WINDOWS_SIGN_PASSWORD` | Password set when the `.pfx` was exported |

Encode the cert with:

```sh
base64 -i aura-codesign.pfx | pbcopy   # macOS
base64 -w0 aura-codesign.pfx           # Linux
```

The workflow uses `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256`
so the timestamp survives cert rotation.

### Unsigned path (current default — no secrets configured)

As of this commit, the `WINDOWS_SIGN_CERT_BASE64` and
`WINDOWS_SIGN_PASSWORD` secrets are **not** present in the repo. The
workflow detects this and finishes the run with unsigned `.msi` /
`.exe` artifacts. The build still succeeds and the bundles still
install — but every Windows user will see a Microsoft SmartScreen
warning on first launch.

#### SmartScreen disclaimer (paste into release notes when unsigned)

> **Windows users — first-launch warning is expected.**
>
> This build of Aura is not yet signed by a Microsoft-trusted code-
> signing certificate, so Windows will show a blue
> **"Windows protected your PC"** dialog the first time you run the
> installer. The bundle is safe — Aura is built from source by GitHub
> Actions and published from a public release.
>
> To proceed: click **More info**, then **Run anyway**. Once Aura is
> installed you will not see the warning again on this machine. The
> next release will be signed once our code-signing cert lands.

Keep this disclaimer in the GitHub Release body until the signing
secrets are configured. Drop it once a signed build is shipped.

---

## Updater notes

The in-app updater fetches `https://auravcs.com/updates/latest.json`.
That JSON is produced by tauri-action in the cross-platform workflow
when `TAURI_SIGNING_PRIVATE_KEY` is set; the Windows-only workflow
copies any `latest.json` it finds into the upload bundle as well. Make
sure the auravcs.com publish step (separate from these CI workflows)
pulls the freshest `latest.json` from the GitHub Release after the
tag completes.

---

## Manual re-runs

Both workflows expose `workflow_dispatch`. Pick the branch (usually
`master` for a re-ship of the latest tag), hit **Run workflow**, and
the artifacts will appear in the workflow summary even though they
are not attached to a Release.

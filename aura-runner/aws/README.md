# Aura Runner on AWS — laptop-free execution

An always-on box that drains the **cloud a2a backlog**: work you start from the
phone (the `+` launcher → *Start on cloud*) lands as a `submitted` a2a task; this
box pulls it, runs the coding agent against the repo, commits, and reports the
result back — all with your laptop shut.

This is the missing operational half of the runner. The code path already
exists end to end (`aura runner serve` → `crew cloud-sync --pull` → `crew run`
spawns `claude -p …` → `crew cloud-sync --push`); what was missing was a box
actually running it. These scripts stand that box up.

## What it runs each cycle

```
aura runner serve   (systemd, restart=always)
 ├─ crew cloud-sync --pull   pull + claim submitted a2a tasks for this repo
 ├─ crew run --max 0         spawn the agent headless, do the work, commit
 ├─ crew cloud-sync --push   report status + commit + result to the cloud/app
 └─ git push                 best-effort durability, then sleep & heartbeat
```

## One-command provision

From your Mac (needs your AWS CLI, local `aura cloud login`, and `gh auth`):

```bash
cd aura-runner/aws
REPO_SLUG=owner/name ANTHROPIC_API_KEY=sk-ant-… ./provision.sh
```

It launches an Ubuntu 24.04 arm64 box next to prod in `eu-central-1`, reusing the
`AuraKey` pair; builds `aura` on the box (the OSS mirror doesn't carry
`runner serve` yet); installs the `claude` CLI; transplants the three credentials
the runner needs (your cloud token for a2a, a minted runner token for liveness,
your gh token for the repo); and starts the service. Secrets go over SSH stdin —
never argv, never printed.

Override any input via env: `REGION`, `INSTANCE_TYPE`, `VOLUME_GB`, `AGENT`,
`BRANCH`, `POLL_SECS`, `NAME`, `ALL_PROJECTS` (drain every project — see below).

## Cost (eu-central-1, on-demand)

| Instance | vCPU / RAM | Compute/mo | + 40 GB gp3 | + IPv4 | **Total/mo** | Fits |
|----------|-----------|-----------|-------------|--------|-------------|------|
| t4g.medium | 2 / 4 GB | ~$27 | $3.8 | $3.7 | **~$34** | light repos; too tight for Rust builds |
| **t4g.large** ⭐ | **2 / 8 GB** | **~$54** | **$3.8** | **$3.7** | **~$61** | **recommended — matches prod** |
| t4g.xlarge | 4 / 16 GB | ~$108 | $5.7 | $3.7 | **~$117** | if tasks build/test the aura Rust workspace |
| t3.large (x86) | 2 / 8 GB | ~$63 | $3.8 | $3.7 | **~$70** | only if an agent needs x86 |

Levers:
- **1-yr Compute Savings Plan** (no upfront): ~30 % off compute → t4g.large ≈ **$45/mo**.
- **Spot**: t4g.large ≈ **$24/mo compute, ~$28/mo all-in** (eu-central-1, measured over a
  real run — not the headline discount, which assumes a quieter capacity pool than we saw).
  Interruptible, and safe here: a killed task's lease expires and the next cycle reclaims it.
  Start on-demand, move to spot once proven.
- **Stop when idle**: `aws ec2 stop-instances` bills only storage (~$4/mo) while off.

### The real cost driver is agent usage, not the VM

Headless `claude` spends tokens per task. Two auth modes (`provision.sh` supports both):

- **API key** (`ANTHROPIC_API_KEY`): metered per token. Depending on task size and
  volume this can exceed the VM cost. Cap it with a spend limit in the Anthropic console.
- **Subscription** (`claude setup-token` on the box): rides your existing Pro/Max
  plan flat, subject to its rate limits. Usually the cheaper, more predictable choice
  if you already pay for Max.

## One box, all your projects

By default the box is pinned to one repo (`REPO_SLUG`). To make a single box run
**every** project you own, provision it with `ALL_PROJECTS=1`:

```bash
cd aura-runner/aws
REPO_SLUG=owner/home-repo ALL_PROJECTS=1 ./provision.sh
```

In this mode each cycle the box asks the cloud — over plain HTTP, no checkout
needed — which projects currently have pending work
(`GET /api/v2/a2a/tasks?status=submitted`, mapped through `/api/v2/repos` to
`owner/name`), then for each one it:

1. lazily clones a **per-project workspace** under `/opt/aura-runner/workspaces/<owner>__<name>/`
   (full clone on first sight, `git fetch` after), sets the runner git identity,
   and runs `aura enable` so the agent's commits there carry intent + provenance;
2. runs the exact same drain pipeline (`crew cloud-sync --pull --repo owner/name`
   → `crew run` → `crew cloud-sync --push` → `git push`) scoped to that workspace.

So work started from the phone against *any* of your repos runs on the one box —
`REPO_SLUG` is just its home checkout + build anchor. Nothing else changes: the
same gh token (stored host-wide) clones each repo, and the same cloud token scopes
task visibility to what you can access. Workspaces are cloned on demand, so a repo
you never send work to is never cloned.

Prefer one repo per box instead? Omit `ALL_PROJECTS` (the default) — the service
stays scoped with `--repo owner/name` and drains only that project.

- **Push durability** needs the gh token (installed by `provision.sh`). Even without
  a successful `git push`, the result + commit sha still reach the app via
  `crew cloud-sync --push`, so the phone always sees the outcome.

## Operate

```bash
ssh -i AuraKey.pem ubuntu@<ip> "sudo journalctl -u aura-runner -f"   # live log
ssh -i AuraKey.pem ubuntu@<ip> "aura runner status"                  # registry record
ssh -i AuraKey.pem ubuntu@<ip> "sudo systemctl restart aura-runner"  # bounce
aws ec2 terminate-instances --region eu-central-1 --instance-ids <id> # tear down
```

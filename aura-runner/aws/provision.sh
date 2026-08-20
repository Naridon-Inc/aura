#!/usr/bin/env bash
#
# aura-runner/aws/provision.sh — stand up an always-on Aura runner on AWS EC2.
#
# Run from your Mac (it needs your AWS CLI, your local `aura` login, and `gh`).
# It launches an Ubuntu 24.04 arm64 box in the same account/region as prod,
# builds `aura` on it, installs the coding agent, transplants the credentials
# the runner needs, and starts a systemd service that drains the cloud a2a
# backlog — so work you start from the phone runs with the laptop shut.
#
# Secrets are resolved locally and piped to the box over SSH stdin; they are
# never passed as argv and never printed. Nothing is launched until the inputs
# below are set.
#
#   REPO_SLUG=owner/name  ANTHROPIC_API_KEY=sk-ant-…  ./provision.sh
#
set -euo pipefail

# ---- inputs (env-overridable) ----------------------------------------------
REGION="${REGION:-eu-central-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.large}"
VOLUME_GB="${VOLUME_GB:-40}"
KEY_NAME="${KEY_NAME:-AuraKey}"
KEY_PATH="${KEY_PATH:-$HOME/.ssh/$KEY_NAME.pem}"
NAME="${NAME:-aura-runner}"
SG_NAME="${SG_NAME:-aura-runner-sg}"
MARKET="${MARKET:-on-demand}"                          # on-demand | spot
# Resume an existing box instead of launching a new one. Set RESUME_IP (and
# optionally RESUME_IID for the teardown hints) when a prior run launched the
# instance but couldn't finish — e.g. your public IP churned mid-provision and
# the /32 SSH rule went stale. Skips SG-create + run-instances; still (re)opens
# SSH from your *current* IP, rsyncs, bootstraps, writes env, and starts.
RESUME_IP="${RESUME_IP:-}"
RESUME_IID="${RESUME_IID:-}"
AGENT="${AGENT:-claude}"
LEASE_SECS="${LEASE_SECS:-1800}"
POLL_SECS="${POLL_SECS:-20}"
SRC="${SRC:-$(cd "$(dirname "$0")/../.." && pwd)}"     # dev tree root (holds aura-cli/)
REPO_SLUG="${REPO_SLUG:?set REPO_SLUG=owner/name — home checkout for the box (and the repo it drains unless ALL_PROJECTS=1)}"
BRANCH="${BRANCH:-}"
# ALL_PROJECTS=1 → the box drains EVERY project in your org that has pending
# cloud work, each in its own auto-cloned workspace (one box, all your projects).
# REPO_SLUG is still used as the box's home checkout + build anchor. Default
# (empty) keeps the historical one-repo behaviour, pinned to REPO_SLUG.
ALL_PROJECTS="${ALL_PROJECTS:-}"
case "$ALL_PROJECTS" in 1|true|yes|on) ALL_PROJECTS=1 ;; *) ALL_PROJECTS="" ;; esac

export AWS_PAGER=""

# The key that opens the box. There is no default that exists on somebody
# else's laptop, so name the missing file here rather than letting the copy
# below, or ssh forty lines later, fail with an error that reads like AWS's
# fault. This runs before the space-safe copy, which would otherwise be the
# thing that reports it.
if [ ! -f "$KEY_PATH" ]; then
  printf '\n\033[1;31m✗ no ssh key at %s — set KEY_PATH to the .pem for EC2 key pair '\''%s'\''\033[0m\n' "$KEY_PATH" "$KEY_NAME" >&2
  exit 1
fi
# rsync's -e takes a single string and word-splits it, so a key path with spaces
# (e.g. ".../New Git/AuraKey.pem") breaks the remote-shell parse. Copy to a
# space-free temp path for all SSH/rsync here; keep the original for display.
ORIG_KEY_PATH="$KEY_PATH"
if [[ "$KEY_PATH" == *" "* ]]; then
  KEY_COPY="${TMPDIR:-/tmp}/aura-runner-key.pem"
  cp "$KEY_PATH" "$KEY_COPY" && chmod 600 "$KEY_COPY"
  KEY_PATH="$KEY_COPY"
  trap 'rm -f "$KEY_COPY"' EXIT
fi
SSH_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- resolve secrets locally (never printed) -------------------------------
say "resolving credentials from this Mac"
CLOUD_TOKEN="$(jq -r '.cloud_api_token // empty' "$HOME/.aura/credentials.json" 2>/dev/null || true)"
[ -n "$CLOUD_TOKEN" ] || die "no cloud token in ~/.aura/credentials.json — run 'aura cloud login' first"
CLOUD_URL="$(jq -r '.cloud_url // "https://api.auravcs.com"' "$HOME/.aura/credentials.json" 2>/dev/null || echo https://api.auravcs.com)"
GH_TOKEN="$(gh auth token 2>/dev/null || true)"
[ -n "$GH_TOKEN" ] || die "no gh token — run 'gh auth login' so the runner can clone/push $REPO_SLUG"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"   # empty ⇒ you'll drive claude via subscription login on the box

# ---- mint a runner-registry token so the box shows online in the app -------
say "registering the runner (mints its liveness token)"
# All-projects mode registers an org-wide runner (no --repo scope); single-repo
# mode scopes the runner to REPO_SLUG. Serve mode string mirrors this.
if [ -n "$ALL_PROJECTS" ]; then
  REG_SCOPE=()
  RUNNER_MODE="--all-projects"
else
  REG_SCOPE=(--repo "$REPO_SLUG")
  RUNNER_MODE="--repo $REPO_SLUG"
fi
if [ -n "${AURA_RUNNER_TOKEN:-}" ]; then
  RUNNER_TOKEN="$AURA_RUNNER_TOKEN"; echo "   using AURA_RUNNER_TOKEN from env (no re-register)"
else
  RUNNER_TOKEN="$(aura runner register --name "$NAME" ${REG_SCOPE[@]+"${REG_SCOPE[@]}"} --agents "$AGENT" 2>&1 \
    | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'aura_[A-Za-z0-9_]{16,}' | head -1 || true)"
fi
if [ -n "$RUNNER_TOKEN" ]; then echo "  ok runner token ready"; else echo "  ! registry unavailable - box will run unregistered (still drains)"; fi

# ---- security group: egress all, SSH only from this Mac's IP ----------------
say "ensuring security group $SG_NAME in $REGION"
VPC_ID="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG_ID="$(aws ec2 describe-security-groups --region "$REGION" --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID="$(aws ec2 create-security-group --region "$REGION" --group-name "$SG_NAME" \
    --description "Aura runner - outbound only, SSH from operator" --vpc-id "$VPC_ID" --query GroupId --output text)"
fi
MYIP="$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')"
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "${MYIP}/32" >/dev/null 2>&1 || true
echo "  sg=$SG_ID  ssh-from=${MYIP}/32"

# ---- launch the instance (or resume an existing one) ------------------------
if [ -n "$RESUME_IP" ]; then
  IP="$RESUME_IP"
  IID="${RESUME_IID:-<existing>}"
  SIR="None"
  echo "  resuming existing box  ip=$IP  instance=$IID"
else
  say "resolving latest Ubuntu 24.04 arm64 AMI"
  AMI="$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" "Name=state,Values=available" \
    --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text)"
  echo "  ami=$AMI  type=$INSTANCE_TYPE  disk=${VOLUME_GB}GB gp3"

  say "launching $NAME ($MARKET)"
  RUN_ARGS=(--region "$REGION"
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME"
    --security-group-ids "$SG_ID"
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${VOLUME_GB},VolumeType=gp3,DeleteOnTermination=true}"
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=role,Value=aura-runner},{Key=drains,Value=$REPO_SLUG}]"
    --count 1)
  if [ "$MARKET" = "spot" ]; then
    # Persistent + stop-on-interruption: if AWS reclaims capacity the box (and its
    # EBS) is stopped, not destroyed, and relaunched automatically when capacity
    # returns — systemd Restart=always resumes the drain. An in-flight task's lease
    # expires and the next cycle reclaims it, so interruptions cost only a pause.
    RUN_ARGS+=(--instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=persistent,InstanceInterruptionBehavior=stop}')
  fi
  IID="$(aws ec2 run-instances "${RUN_ARGS[@]}" --query 'Instances[0].InstanceId' --output text)"
  echo "  instance=$IID"
  SIR="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" --query 'Reservations[0].Instances[0].SpotInstanceRequestId' --output text 2>/dev/null || echo None)"
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
  IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
  echo "  ip=$IP"
fi

say "waiting for SSH (re-opening SG for current IP first)"
# IP churn is the top failure mode here: the SG's /32 SSH rule can go stale
# between a launch and this step. Re-detect and re-authorize the *current* IP
# right before we depend on SSH, so a resume (or a mid-run IP change) still gets in.
NOWIP="$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')"
if [ -n "$NOWIP" ] && [ "$NOWIP" != "$MYIP" ]; then
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr "${NOWIP}/32" >/dev/null 2>&1 || true
  echo "  re-authorized ssh-from=${NOWIP}/32 (was ${MYIP}/32)"
fi
for i in $(seq 1 30); do
  ssh "${SSH_OPTS[@]}" "ubuntu@$IP" true 2>/dev/null && break
  sleep 10; [ "$i" = 30 ] && die "SSH never came up on $IP"
done

# ---- ship source + git credential, then bootstrap ---------------------------
say "rsyncing Aura source to the box (this builds the runner-capable aura)"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.git' --exclude 'target' --exclude 'node_modules' \
  --exclude '*.pem' --exclude '.env' --exclude '*.env' \
  --exclude '.aura' --exclude '.claude' --exclude '*.log' \
  --exclude 'aura-mobile' --exclude 'aura-web' --exclude 'aura-shell' --exclude 'aura-cloud' \
  --exclude 'aura-sandbox' --exclude 'aura-test-repo' --exclude '/aura' --exclude 'dist' --exclude 'build' \
  "$SRC/" "ubuntu@$IP:/home/ubuntu/aura-src/"

say "installing the repo git credential (for clone + push of $REPO_SLUG)"
printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" | \
  ssh "${SSH_OPTS[@]}" "ubuntu@$IP" 'cat > ~/.git-credentials && chmod 600 ~/.git-credentials && git config --global credential.helper store'

say "running on-box bootstrap (toolchain + build + agent + systemd) — ~15-30 min cold"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" \
  "AGENT='$AGENT' SRC_DIR=/home/ubuntu/aura-src REPO_SLUG='$REPO_SLUG' BRANCH='$BRANCH' bash /home/ubuntu/aura-src/aura-runner/aws/bootstrap.sh"

# ---- write secret env files (piped over stdin, never argv) ------------------
say "writing runner env"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "sudo mkdir -p /etc/aura-runner"
{
  echo "AURA_RUNNER_AGENT=$AGENT"
  echo "AURA_RUNNER_REPO=$REPO_SLUG"
  echo "AURA_RUNNER_MODE=$RUNNER_MODE"
  echo "AURA_RUNNER_LEASE_SECS=$LEASE_SECS"
  echo "AURA_RUNNER_POLL_SECS=$POLL_SECS"
  echo "AURA_RUNNER_NAME=$NAME"
  echo "AURA_CLOUD_URL=$CLOUD_URL"
  echo "AURA_CLOUD_TOKEN=$CLOUD_TOKEN"
  # `if` (not `&& echo`) so an empty token doesn't make this group's last
  # command exit non-zero → set -o pipefail + set -e would abort here even
  # though the env was already piped to tee.
  if [ -n "$RUNNER_TOKEN" ]; then echo "AURA_RUNNER_TOKEN=$RUNNER_TOKEN"; fi
} | ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "sudo tee /etc/aura-runner/runner.env >/dev/null && sudo chmod 600 /etc/aura-runner/runner.env"

if [ -n "$ANTHROPIC_API_KEY" ]; then
  printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" | \
    ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "sudo tee /etc/aura-runner/agent.env >/dev/null && sudo chmod 600 /etc/aura-runner/agent.env"
  say "starting the runner"
  ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "sudo systemctl restart aura-runner && sleep 3 && systemctl is-active aura-runner && sudo journalctl -u aura-runner -n 15 --no-pager"
else
  say "no ANTHROPIC_API_KEY provided"
  cat <<EOF
The box is built and the service is installed but NOT started (no agent key).
Finish with EITHER:

  # metered API key:
  ssh -i "$ORIG_KEY_PATH" ubuntu@$IP "printf 'ANTHROPIC_API_KEY=sk-ant-...\\n' | sudo tee /etc/aura-runner/agent.env >/dev/null && sudo chmod 600 /etc/aura-runner/agent.env && sudo systemctl restart aura-runner"

  # OR ride your Claude subscription (flat): log in once as ubuntu, then start:
  ssh -i "$ORIG_KEY_PATH" ubuntu@$IP "claude setup-token"   # follow the prompt, then:
  ssh -i "$ORIG_KEY_PATH" ubuntu@$IP "sudo systemctl restart aura-runner"
EOF
fi

# Spot-cancel hint for the teardown block. Built here, not inline in the heredoc:
# a single-quoted printf inside $(...) inside an unquoted heredoc trips bash's
# parser (it never sees the closing quote → "unexpected EOF").
SPOT_CANCEL_HINT=""
if [ "$SIR" != "None" ] && [ -n "$SIR" ]; then
  SPOT_CANCEL_HINT="              aws ec2 cancel-spot-instance-requests --region $REGION --spot-instance-request-ids $SIR   # spot: cancel too, or it relaunches"
fi

cat <<EOF

────────────────────────────────────────────────────────────
 Aura runner is up.
   instance   $IID  ($INSTANCE_TYPE, $REGION)
   ip         $IP
   drains     $( [ -n "$ALL_PROJECTS" ] && echo "ALL your projects with pending work (workspaces under /opt/aura-runner/workspaces)" || echo "$REPO_SLUG" )   (a2a tasks started from the phone)
   ssh        ssh -i "$ORIG_KEY_PATH" ubuntu@$IP
   logs       ssh … "sudo journalctl -u aura-runner -f"
   tear down  aws ec2 terminate-instances --region $REGION --instance-ids $IID
$SPOT_CANCEL_HINT
────────────────────────────────────────────────────────────
EOF

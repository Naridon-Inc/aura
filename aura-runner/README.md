# Aura Runner — remote compute for the crew loop

Run Aura's autonomous **Crew loop** on a box that's always on, so work continues
while your laptop is off — and you can kick off new work from anywhere by pushing
a task to the branch.

Point a runner at a repo; it claims ready tasks, dispatches a coding agent,
verifies, commits, and pushes the results back — on a loop, unattended.

Tracked on the Crew board: **AURA-86** (epic), **AURA-87** (scaffold),
**AURA-88** (task delivery — done).

## How tasks reach the runner (AURA-88)

Tasks live as JSON in `.aura/a2a/` and flow over **git**, via `aura loop sync`:

```
aura loop add "fix the flaky retry test"   # mint a task (laptop, CI, anywhere)
aura loop sync                             # commit the task graph + push
```

The runner pulls it on its next cycle, works it, and pushes progress back —
`aura loop sync --pull-only` on your laptop shows it move to `completed`.

The durable graph (`.aura/a2a/*.json`) is committed and synced; the **ephemeral
working lease** (`*.lease.json`) is gitignored and stays local, so there's no
commit churn and no cross-machine lease conflict. A node a runner left `working`
when it died arrives at a peer with no lease and is automatically reclaimed into
the ready set.

## One cycle

```
aura loop sync --pull-only   # pick up tasks/commits initiated from anywhere
aura loop run --max 0        # drain ready set: claim → dispatch agent → gate → commit
aura loop sync               # commit task-graph progress + push commits back
sleep, repeat
```

## Run it

**Locally / on your own server (Docker Compose):**

```sh
cp aura-runner/runner.env.example aura-runner/runner.env   # set REPO + ANTHROPIC_API_KEY
docker compose -f aura-runner/docker-compose.yml up -d --build
docker compose -f aura-runner/docker-compose.yml logs -f
```

**On a fresh cloud VM (one paste):** put `aura-runner/cloud-init.yaml` in the
VM's user-data (EC2 "User data", DigitalOcean/Hetzner/GCP cloud-init). It
installs Docker, builds the runner, and starts it on boot. Fill the three
`FILL-ME` values first.

**Bare:**

```sh
docker build -f aura-runner/Dockerfile -t aura-runner .
docker run --env-file aura-runner/runner.env aura-runner
```

All config is environment-driven — see `runner.env.example` for every
`AURA_RUNNER_*` var. Secrets are injected at runtime, never baked into the image.

## Proven

- `cargo test -p aura-loop` — **20/20** (DAG, ready-set, deps, cycle rejection,
  lease claim/expiry/reclaim, and the lease-sidecar split).
- **End-to-end, no cloud/key/microVM:** a stub agent shadowing `claude`, the real
  `entrypoint.sh`, a throwaway bare-remote → a task minted with `aura loop add` +
  `aura loop sync` on the "laptop" side flows to the runner, gets worked, and the
  result + `completed` status flow back — with **zero lease files leaked into
  git**.

## What's substrate-agnostic vs. what's next

The image runs the same on your own box, AWS Fargate, or a machine0 VM — picking
one (**AURA-92**) is a deploy choice, not a code change.

Still open:

- **AURA-89** — secrets. A real agent key must live on the box. Deliberately not
  automated: put keys only on infrastructure you control.
- **AURA-90** — mobile initiate. Today you can mint a task from any git client;
  a small PWA on `app.auravcs.com` to do it from a phone in one tap is next (it
  mints a task that then flows via AURA-88).
- **AURA-91** — reconvergence. The merge/rebase story when the runner pushes
  while you also worked locally. `aura loop sync` already rebases task-graph
  updates; richer code-side reconvergence is the follow-up.
- **Hosted fleet (productization).** This README is the **self-host** path: you
  bring the compute. "Aura *provisions* the box for you" (one-click managed
  runners + billing + a secrets vault) is a separate control-plane build, gated
  on infra and product decisions.

## Why this is Aura's, not a commodity VM

Every commit the runner makes carries Aura's signed, attested provenance — what
changed, why, by which agent, where it ran. `aura enable` is wired on first boot
so the runner's work is captured exactly like a human's.

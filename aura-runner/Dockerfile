# Aura Runner image — packages the headless Crew loop (entrypoint.sh) so the
# autonomous loop can run on a detached box while your laptop is off.
#
# Build from the repo ROOT (the build context must see aura-cli/ and its crates):
#   docker build -f aura-runner/Dockerfile -t aura-runner .
# Run (secrets via --env-file, never baked into the image):
#   docker run --env-file aura-runner/runner.env aura-runner
#
# Substrate-agnostic: the same image runs on your own box, AWS Fargate, or a
# machine0 VM — only the surrounding deploy differs.

# ---- stage 1: build the aura CLI from source --------------------------------
FROM rust:1.85-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev libsqlite3-dev git cmake clang \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# aura-cli is workspace-EXCLUDED (package "aura", its own target dir) — so it is
# built through its own manifest, not the workspace root.
RUN cargo build --release --manifest-path aura-cli/Cargo.toml \
    && cp aura-cli/target/release/aura /usr/local/bin/aura

# ---- stage 2: runtime -------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 libsqlite3-0 git curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # The loop dispatches a coding-agent CLI. Claude Code is the default agent
    # (AURA_RUNNER_AGENT); swap/add others (codex, gemini, cursor) as needed.
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/aura /usr/local/bin/aura
COPY aura-runner/entrypoint.sh /usr/local/bin/aura-runner-entrypoint.sh
RUN chmod +x /usr/local/bin/aura-runner-entrypoint.sh

# Secrets (ANTHROPIC_API_KEY, git credentials) are injected at runtime via
# --env-file / orchestrator secret store — NEVER baked here. See runner.env.example
# and AURA-89 (gated on user).
ENV AURA_RUNNER_WORKDIR=/workspace
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/aura-runner-entrypoint.sh"]

FROM rust:1.85-slim as builder

# Install system dependencies for git2 and other crates
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    libsqlite3-dev \
    git \
    cmake \
    clang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Build the release binary
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    libsqlite3-0 \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/aura /usr/local/bin/aura

# Port for the dashboard
EXPOSE 8090

# We need the git repo to be available for the dashboard to read checkpoints
# In App Runner, we'll mount the code if using code-based deployment, 
# but here we're using image-based. The image contains the code snapshot.
COPY . .

ENTRYPOINT ["aura", "dashboard"]

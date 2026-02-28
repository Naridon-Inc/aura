# Entire Core Concepts

A **session** represents a complete interaction with an AI coding agent.
A **checkpoint** is a snapshot you can rewind to.
**Shadow Branches** (`entire/<hash>`) store local temporary checkpoints.
**Checkpoints Branch** (`entire/checkpoints/v1`) stores permanent metadata.
**Git Trailers** link commits to checkpoints (e.g., `Entire-Checkpoint: 8a513f56ed70`).

# How to Onboard Your Engineering Team to Aura

Transitioning your team from standard Git to the **Aura AI-Native Semantic Engine** requires zero downtime and zero platform lock-in. Because Aura acts as a "Parasitic Gatekeeper" on top of standard Git, your team can start using it in under 5 minutes without changing where they host their code.

Here is the exact step-by-step process.

---

### Step 1: The Global Installation
Tell every developer on your team to run the universal installation script in their terminal. This downloads the pre-compiled Aura Rust binary for their OS (macOS/Windows/Linux).

```bash
curl -fsSL https://aura.vcs/install.sh | bash
```

### Step 2: Initialize the Repository (One-Time Setup)
Navigate to any existing Git repository on your machine. You do not need to create a new repo or migrate from GitHub.

Run the onboarding wizard:
```bash
aura init
```

The beautiful interactive wizard will ask you three things:
1.  **Which Agents?** Select the AI tools your team uses (Cursor, Claude, Aider). Aura will automatically configure the correct zero-friction scrapers or MCP hooks for your machine.
2.  **API Key:** Provide a Gemini/Anthropic API key. This is saved securely to your global OS keychain (`~/.config/AuraLabs`). It enables Semantic RAG and the Autonomous Arbitrator for free.
3.  **Tethering:** Choose `No` for a purely local setup, or `Yes` if your company pays for the Aura Cloud SaaS to enable Cross-Repo tracing.

### Step 3: Code Normally (The Magic)
Tell your team to go back to work. **They do not need to learn any new commands.**
They just use Cursor or Claude as usual, and when they are done, they type:

```bash
git commit -m "Added the new billing module"
```

Aura instantly intercepts the `git commit` command. In less than 10 milliseconds, it:
*   Parses the AST logic to ensure it doesn't break production (`verify-env`).
*   Scans the code to ensure no AI hallucinated an API key (`Semantic Sentinel`).
*   Extracts the chat logs from Cursor and scrubs PII (`Neural Redaction`).
*   Links it all to the Git commit using a cryptographic Trailer.

### Step 4: The Continuous DVR (Optional, but Recommended)
If your team wants "Sledgehammer Restores" and sub-commit time travel, tell them to open a second terminal window and run:

```bash
aura daemon
```
This runs silently in the background, tracking every `CMD+S` keystroke and silently backing up logic changes.

### Step 5: Multiplayer Collaboration
Because Aura stores its RAG database inside a hidden Git branch (`aura/checkpoints/v1`), your team shares memory automatically.

When Alice finishes her feature, she runs:
```bash
git push
```

When Bob starts his day, he runs:
```bash
git pull
```
Bob now possesses the exact mathematical intent behind everything Alice's AI just wrote. If Bob's AI is confused about Alice's code, Bob simply types:
```bash
aura ask "Why did Alice change the database schema?"
```

### Step 6: The Team Dashboard
Your Engineering Manager doesn't want to look at the terminal.
They open `aura-team-dashboard.html` in their browser, type in your `owner/repo` name, and the React app securely fetches the hidden Git branch directly from GitHub via their REST API, displaying a gorgeous feed of every AI decision made by the team today.

---
**Welcome to the Age of Agentic Engineering.**

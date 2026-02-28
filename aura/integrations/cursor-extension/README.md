# Aura Semantic VCS for Cursor/VS Code

> **"Seamlessly Capture Architectural Intent"**

The Aura extension integrates the power of **Semantic Version Control** directly into your editor. It passively monitors your code changes and captures the *why* behind every save, ensuring your project's history is a rich narrative of intent, not just a series of diffs.

**Copyright © 2026 Naridon, Inc.**

## 🌟 Key Features

### 1. Auto-Prompt on Save
When you save a file, Aura detects the change and prompts you for the **Architectural Intent**.
*   **Context-Aware**: Uses the file name and content to suggest relevant context.
*   **Frictionless**: Quickly type your reasoning and press Enter. The intent is instantly bound to the AST changes.

### 2. Manual Intent Logging
Invoke the **Command Palette** (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type `Aura: Log Semantic Intent`.
*   Capture reasoning for complex refactors or multi-file changes.

### 3. Real-Time Feedback
Receive instant confirmation that your intent has been successfully logged and processed by the Aura Core engine.

---

## 🚀 Installation

### Prerequisites
*   **Aura Core (CLI)**: Ensure the `aura` binary is installed and available in your PATH (or `~/.cargo/bin/aura`).
*   **VS Code / Cursor**: Version 1.80.0 or higher.

### Steps

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/your-org/aura.git
    cd aura/aura-integration/cursor-extension
    ```

2.  **Package the Extension**:
    ```bash
    npm install -g vsce
    vsce package
    ```
    This will generate a `.vsix` file (e.g., `aura-semantic-vcs-1.0.0.vsix`).

3.  **Install in Editor**:
    *   Open VS Code or Cursor.
    *   Go to the Extensions view (`Ctrl+Shift+X`).
    *   Click the `...` menu (Views and More Actions).
    *   Select **Install from VSIX...**.
    *   Choose the generated `.vsix` file.

---

## 🛠️ Usage

### Workflow
1.  **Edit Code**: Make changes to any file in your project.
2.  **Save File**: Press `Ctrl+S` (or `Cmd+S`).
3.  **Provide Intent**: An input box will appear at the top of the editor.
    > "Aura: What is the architectural intent behind saving src/auth/login.ts?"
4.  **Confirm**: Type your reason (e.g., "Added JWT expiration check") and press Enter.
5.  **Done**: Aura logs the intent, updates the local vector database, and links it to the file's AST hash.

### Commands
*   `aura.logIntent`: Manually trigger the intent input box.

---

## ⚙️ Configuration

No complex configuration is required. The extension automatically detects the `aura` binary in your standard Cargo bin directory (`~/.cargo/bin/aura`).

---

## 🤝 Contributing

We welcome contributions to improve the extension's capabilities!

1.  Fork the repository.
2.  Create a feature branch.
3.  Submit a Pull Request.

**License**: MIT

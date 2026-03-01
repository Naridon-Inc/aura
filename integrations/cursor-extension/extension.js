const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Aura Semantic VCS is now active.');

    // Find the Aura binary dynamically
    const homeDir = os.homedir();
    // In a real prod environment, we would check PATH. For MVP, we assume cargo bin.
    const auraPath = path.join(homeDir, '.cargo', 'bin', 'aura');

    // 1. The Implicit Tracker: Listen for File Saves
    let saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
        // Ignore git files, logs, and aura's own internal files
        if (document.fileName.includes('.git') || document.fileName.includes('aura_daemon.log')) {
            return;
        }

        // We know a file was saved. We assume an AI (or human) made a change.
        // We will prompt the user (or extract from the active chat) for their intent.
        
        // MVP: Pop up an input box for the developer to quickly type intent.
        // In a V2, this reads the internal `cursor.chat` SQLite DB directly from the extension context.
        const intent = await vscode.window.showInputBox({
            prompt: `Aura: What is the architectural intent behind saving ${path.basename(document.fileName)}?`,
            placeHolder: "e.g., Added type safety to math functions"
        });

        if (intent) {
            logToAuraMCP(auraPath, intent, vscode.workspace.workspaceFolders[0].uri.fsPath);
        }
    });

    context.subscriptions.push(saveListener);

    // 2. The Explicit Tracker: Command Palette
    let disposable = vscode.commands.registerCommand('aura.logIntent', async function () {
        const intent = await vscode.window.showInputBox({
            prompt: "Aura: Log your architectural intent",
            placeHolder: "e.g., Refactored the database connection pool"
        });

        if (intent) {
            logToAuraMCP(auraPath, intent, vscode.workspace.workspaceFolders[0].uri.fsPath);
        }
    });

    context.subscriptions.push(disposable);
}

function logToAuraMCP(auraPath, intent, cwd) {
    // We communicate with the Aura MCP Server using standard JSON-RPC over stdio
    const mcpRequest = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
            name: "aura_log_intent",
            arguments: {
                intent: `[Cursor IDE Plugin] ${intent}`
            }
        }
    };

    const auraProcess = spawn(auraPath, ['mcp'], { cwd });

    auraProcess.stdout.on('data', (data) => {
        console.log(`Aura Response: ${data}`);
        vscode.window.showInformationMessage("Aura: Intent successfully mathematically bound to AST.");
        auraProcess.kill(); // Terminate after successful log
    });

    auraProcess.stderr.on('data', (data) => {
        console.error(`Aura Error: ${data}`);
    });

    // Send the JSON-RPC request to the running Aura process
    auraProcess.stdin.write(JSON.stringify(mcpRequest) + '
');
    auraProcess.stdin.end();
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}

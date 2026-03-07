import * as vscode from 'vscode';
import { execFile, spawn, ChildProcess } from 'child_process';

let statusBarItem: vscode.StatusBarItem;
let daemonProcess: ChildProcess | null = null;

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('aura');
    const aura = config.get<string>('binaryPath', 'aura');

    // Status bar
    if (config.get<boolean>('showStatusBar', true)) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        statusBarItem.command = 'aura.sessions';
        statusBarItem.text = '$(shield) Aura';
        statusBarItem.tooltip = 'Aura Semantic Engine';
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);
        refreshStatus(aura);
    }

    // Auto-start daemon
    if (config.get<boolean>('autoStartDaemon', true)) {
        startDaemon(aura);
    }

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('aura.snapshot', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No active file.'); return; }
            const filePath = editor.document.uri.fsPath;
            runAura(aura, ['snapshot', filePath], `Snapshot taken: ${filePath}`);
        }),

        vscode.commands.registerCommand('aura.status', () => {
            const terminal = vscode.window.createTerminal('Aura Status');
            terminal.sendText(`${aura} status`);
            terminal.show();
        }),

        vscode.commands.registerCommand('aura.sessions', () => {
            const terminal = vscode.window.createTerminal('Aura Sessions');
            terminal.sendText(`${aura} sessions`);
            terminal.show();
        }),

        vscode.commands.registerCommand('aura.explain', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No active file.'); return; }

            const selection = editor.selection;
            const word = editor.document.getText(selection.isEmpty
                ? editor.document.getWordRangeAtPosition(selection.active)
                : selection);

            if (!word) { vscode.window.showWarningMessage('Select a function or identifier.'); return; }

            const filePath = vscode.workspace.asRelativePath(editor.document.uri);
            const terminal = vscode.window.createTerminal('Aura Explain');
            terminal.sendText(`${aura} explain "${word}" "${filePath}"`);
            terminal.show();
        }),

        vscode.commands.registerCommand('aura.prReview', () => {
            const terminal = vscode.window.createTerminal('Aura PR Review');
            terminal.sendText(`${aura} pr-review --base main`);
            terminal.show();
        }),

        vscode.commands.registerCommand('aura.init', () => {
            const terminal = vscode.window.createTerminal('Aura Init');
            terminal.sendText(`${aura} init`);
            terminal.show();
        }),
    );

    // Track file saves as intent context
    vscode.workspace.onDidSaveTextDocument((doc) => {
        const relPath = vscode.workspace.asRelativePath(doc.uri);
        runAuraSilent(aura, ['mcp-internal-touch', relPath]);
    });
}

export function deactivate() {
    if (daemonProcess) {
        daemonProcess.kill();
        daemonProcess = null;
    }
}

function startDaemon(aura: string) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    daemonProcess = spawn(aura, ['daemon'], { cwd, detached: true, stdio: 'ignore' });
    daemonProcess.unref();
    daemonProcess.on('error', () => { /* daemon not found — ok */ });
}

function refreshStatus(aura: string) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    execFile(aura, ['sessions'], { cwd, timeout: 5000 }, (err, stdout) => {
        if (err || !statusBarItem) return;
        const activeMatch = stdout.match(/ACTIVE/);
        if (activeMatch) {
            statusBarItem.text = '$(shield) Aura: Active Session';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBarItem.text = '$(shield) Aura';
            statusBarItem.backgroundColor = undefined;
        }
    });

    // Refresh every 30 seconds
    setInterval(() => refreshStatus(aura), 30000);
}

function runAura(aura: string, args: string[], successMsg: string) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    execFile(aura, args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
            vscode.window.showErrorMessage(`Aura: ${stderr || err.message}`);
        } else {
            vscode.window.showInformationMessage(successMsg);
        }
    });
}

function runAuraSilent(aura: string, args: string[]) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    execFile(aura, args, { cwd, timeout: 5000 }, () => { /* silent */ });
}

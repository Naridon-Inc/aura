// CodeLens provider that places "Log intent" / "Prove" / "Snapshot"
// shortcuts above each top-level symbol in the active document.
//
// Symbols come from VS Code's built-in DocumentSymbolProvider so we don't
// need a parser per-language — the language extension already supplied
// one. We filter to top-level Function/Class/Method symbols and skip
// nested ones to keep the lens count manageable.

import * as vscode from "vscode";

export class IntentLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  refresh() { this._onDidChange.fire(); }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (doc.uri.scheme !== "file") return [];
    let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] = [];
    try {
      symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        doc.uri,
      )) ?? [];
    } catch {
      symbols = [];
    }
    const targets: { range: vscode.Range; name: string }[] = [];
    const collect = (s: vscode.DocumentSymbol) => {
      if (
        s.kind === vscode.SymbolKind.Function ||
        s.kind === vscode.SymbolKind.Method ||
        s.kind === vscode.SymbolKind.Class
      ) {
        targets.push({ range: s.range, name: s.name });
      }
      // Don't recurse: we want top-level + first-level, not the whole tree.
      // Methods of a class still surface because their parent's children
      // are listed. Limit to one level deep.
      for (const c of s.children ?? []) {
        if (
          c.kind === vscode.SymbolKind.Function ||
          c.kind === vscode.SymbolKind.Method
        ) {
          targets.push({ range: c.range, name: `${s.name}.${c.name}` });
        }
      }
    };
    for (const s of symbols as vscode.DocumentSymbol[]) collect(s);

    return targets.flatMap(({ range, name }) => [
      new vscode.CodeLens(range, {
        title: "$(book) Log intent",
        command: "aura.logIntent",
      }),
      new vscode.CodeLens(range, {
        title: "$(check) Prove",
        command: "aura.prove.symbol",
        arguments: [name],
      }),
      new vscode.CodeLens(range, {
        title: "$(history) Snapshot",
        command: "aura.snapshot",
      }),
    ]);
  }
}

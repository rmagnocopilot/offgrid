import * as vscode from 'vscode';
import type { PendingFileChange } from '../types/contracts';

export class ChangePreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly scheme = 'offgrid-diff';
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly registration: vscode.Disposable;

  constructor() { this.registration = vscode.workspace.registerTextDocumentContentProvider(this.scheme, this); }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? ''; }

  async open(change: PendingFileChange): Promise<void> {
    const key = encodeURIComponent(change.filePath);
    const original = vscode.Uri.parse(`${this.scheme}:original/${key}?t=${Date.now()}`);
    const proposed = vscode.Uri.parse(`${this.scheme}:proposed/${key}?t=${Date.now()}`);
    this.contents.set(original.toString(), change.originalContent);
    this.contents.set(proposed.toString(), change.proposedContent);
    await vscode.commands.executeCommand('vscode.diff', original, proposed, `Offgrid: ${change.filePath} — original ↔ proposta`, { preview: true });
  }
  dispose(): void { this.registration.dispose(); this.emitter.dispose(); this.contents.clear(); }
}

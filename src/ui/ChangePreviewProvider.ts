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
    const timestamp = String(Date.now());
    const normalized = change.filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const original = vscode.Uri.from({ scheme: this.scheme, path: `/original/${normalized}`, query: `t=${timestamp}` });
    const proposed = vscode.Uri.from({ scheme: this.scheme, path: `/proposed/${normalized}`, query: `t=${timestamp}` });
    this.contents.set(original.toString(), change.originalContent);
    this.contents.set(proposed.toString(), change.proposedContent);
    const label = change.kind === 'created' ? 'novo arquivo' : change.kind === 'deleted' ? 'exclusão' : 'alteração';
    await vscode.commands.executeCommand(
      'vscode.diff',
      original,
      proposed,
      `Offgrid: ${change.filePath} — ${label}`,
      { preview: true }
    );
  }
  dispose(): void { this.registration.dispose(); this.emitter.dispose(); this.contents.clear(); }
}

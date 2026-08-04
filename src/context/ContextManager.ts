import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildContextPriority } from '../agent/AgentContext';

export class ContextManager {
  private pinnedFile?: string;
  private autoFile?: string;
  private readonly additional = new Set<string>();

  constructor() { this.updateActive(); }

  private workspaceEditor(preferred?: vscode.TextEditor): vscode.TextEditor | undefined {
    const candidates = [
      preferred,
      vscode.window.activeTextEditor,
      ...vscode.window.visibleTextEditors
    ];
    const seen = new Set<string>();

    return candidates.find((editor): editor is vscode.TextEditor => {
      if (!editor || editor.document.uri.scheme !== 'file') return false;
      const key = editor.document.uri.fsPath.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);

      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) return true;

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return false;
      const relative = path.relative(root, editor.document.uri.fsPath);
      return relative !== ''
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
    });
  }

  updateActive(editor?: vscode.TextEditor): void {
    const workspaceEditor = this.workspaceEditor(editor);
    if (!workspaceEditor) return;
    this.autoFile = vscode.workspace.asRelativePath(workspaceEditor.document.uri, false);
  }

  pinActive(): string | undefined {
    this.updateActive();
    this.pinnedFile = this.autoFile;
    return this.pinnedFile;
  }

  useAuto(): void { this.pinnedFile = undefined; }

  addCurrent(): string | undefined {
    this.updateActive();
    if (this.autoFile) this.additional.add(this.autoFile);
    return this.autoFile;
  }

  addSelection(): string | undefined {
    const editor = this.workspaceEditor();
    if (!editor || editor.selection.isEmpty) return undefined;
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
    const value = `${relative}#L${editor.selection.start.line + 1}-L${editor.selection.end.line + 1}`;
    this.additional.add(value);
    return value;
  }

  clear(): void { this.additional.clear(); }

  get currentFile(): string | undefined { return this.pinnedFile ?? this.autoFile; }

  get state(): { pinnedFile?: string; autoFile?: string; items: string[] } {
    return {
      pinnedFile: this.pinnedFile,
      autoFile: this.autoFile,
      items: [...this.additional]
    };
  }

  priority(prompt: string): string[] {
    this.updateActive();
    const editor = this.workspaceEditor();
    const selectionFile = editor && !editor.selection.isEmpty
      ? vscode.workspace.asRelativePath(editor.document.uri, false)
      : undefined;
    return buildContextPriority({
      prompt,
      selectionFile,
      pinnedFile: this.pinnedFile,
      relatedFiles: [this.autoFile, ...this.additional].filter((value): value is string => Boolean(value))
    });
  }
}

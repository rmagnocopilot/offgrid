import * as vscode from 'vscode';
import { buildContextPriority } from '../agent/AgentContext';

export class ContextManager {
  private pinnedFile?: string;
  private autoFile?: string;
  private readonly additional = new Set<string>();
  constructor() { this.updateActive(); }
  updateActive(editor = vscode.window.activeTextEditor): void {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    this.autoFile = vscode.workspace.asRelativePath(editor.document.uri, false);
  }
  pinActive(): string | undefined { this.updateActive(); this.pinnedFile = this.autoFile; return this.pinnedFile; }
  useAuto(): void { this.pinnedFile = undefined; }
  addCurrent(): string | undefined { this.updateActive(); if (this.autoFile) this.additional.add(this.autoFile); return this.autoFile; }
  addSelection(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return undefined;
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
    const value = `${relative}#L${editor.selection.start.line + 1}-L${editor.selection.end.line + 1}`;
    this.additional.add(value); return value;
  }
  clear(): void { this.additional.clear(); }
  get currentFile(): string | undefined { return this.pinnedFile ?? this.autoFile; }
  get state(): { pinnedFile?: string; autoFile?: string; items: string[] } { return { pinnedFile: this.pinnedFile, autoFile: this.autoFile, items: [...this.additional] }; }
  priority(prompt: string): string[] {
    const editor = vscode.window.activeTextEditor;
    const selectionFile = editor && !editor.selection.isEmpty ? vscode.workspace.asRelativePath(editor.document.uri, false) : undefined;
    return buildContextPriority({ prompt, selectionFile, pinnedFile: this.pinnedFile, relatedFiles: [this.autoFile, ...this.additional].filter((x): x is string => Boolean(x)) });
  }
}

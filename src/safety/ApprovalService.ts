import * as vscode from 'vscode';
import type { ApprovalMode } from '../types/contracts';

export class ApprovalService {
  constructor(private readonly mode: () => ApprovalMode) {}
  async confirmWrite(summary: string, details: string): Promise<boolean> {
    void summary; void details;
    return this.mode() !== 'readOnly';
  }
  async confirmPersistentWrite(summary: string, details: string): Promise<boolean> {
    if (this.mode() === 'full') return true;
    if (this.mode() === 'readOnly') return false;
    const choice = await vscode.window.showWarningMessage(`${summary}\n${details}`, { modal: true }, 'Confirmar');
    return choice === 'Confirmar';
  }

  async confirmTerminal(command: string): Promise<boolean> {
    if (this.mode() !== 'full') {
      const choice = await vscode.window.showWarningMessage(
        `O Agente solicitou executar um comando no terminal:\n\n${command}`,
        { modal: true },
        'Executar'
      );
      return choice === 'Executar';
    }
    return true;
  }
}

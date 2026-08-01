import * as vscode from 'vscode';
import type { AgentAutonomy, ApprovalMode } from '../types/contracts';

export class ApprovalService {
  constructor(private readonly mode: () => ApprovalMode) {}

  async confirmWrite(summary: string, details: string): Promise<boolean> {
    void summary; void details;
    return this.mode() !== 'readOnly';
  }

  async confirmFileCreation(filePath: string, reason: string, autonomy: AgentAutonomy): Promise<boolean> {
    if (this.mode() === 'readOnly') return false;
    if (autonomy === 'autonomous') return true;
    const message = [
      'O Agente recomenda criar um novo arquivo:',
      '',
      filePath,
      reason ? `\nMotivo:\n${reason}` : '',
      '',
      'O arquivo ainda passará pela revisão de diff antes de ser salvo.'
    ].filter(Boolean).join('\n');
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Criar arquivo', 'Continuar sem criar');
    return choice === 'Criar arquivo';
  }

  async confirmFileDeletion(filePath: string, reason: string, autonomy: AgentAutonomy): Promise<boolean> {
    if (this.mode() === 'readOnly') return false;
    if (autonomy === 'autonomous') return true;
    const message = [
      'O Agente recomenda excluir um arquivo:',
      '',
      filePath,
      reason ? `\nMotivo:\n${reason}` : '',
      '',
      'A exclusão ainda passará pela revisão de diff antes de ser aplicada.'
    ].filter(Boolean).join('\n');
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Preparar exclusão', 'Manter arquivo');
    return choice === 'Preparar exclusão';
  }

  async confirmPersistentWrite(summary: string, details: string): Promise<boolean> {
    if (this.mode() === 'full') return true;
    if (this.mode() === 'readOnly') return false;
    const choice = await vscode.window.showWarningMessage(`${summary}\n${details}`, { modal: true }, 'Confirmar');
    return choice === 'Confirmar';
  }

  async confirmTerminal(command: string): Promise<boolean> {
    if (this.mode() === 'readOnly') return false;
    const choice = await vscode.window.showWarningMessage(
      `O Agente solicitou executar um comando no terminal:\n\n${command}`,
      { modal: true },
      'Executar'
    );
    return choice === 'Executar';
  }
}

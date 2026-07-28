'use strict';

const path = require('node:path');
const vscode = require('vscode');

class ChangePreviewProvider {
  constructor() {
    this.contents = new Map();
  }

  provideTextDocumentContent(uri) {
    return this.contents.get(uri.toString()) || '';
  }

  async open(change) {
    const safePath = String(change.filePath || 'arquivo.txt').replaceAll('\\', '/');
    const extension = path.extname(safePath) || '.txt';
    const encoded = safePath.split('/').map(encodeURIComponent).join('/');
    const originalUri = vscode.Uri.parse(`offgrid-diff://original/${encoded}${extension ? '' : '.txt'}`);
    const proposedUri = vscode.Uri.parse(`offgrid-diff://proposed/${encoded}${extension ? '' : '.txt'}`);

    this.contents.set(originalUri.toString(), change.existed ? change.originalContent : '');
    this.contents.set(proposedUri.toString(), change.proposedContent);

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `${safePath} — Offgrid: original ↔ proposta`,
      { preview: true }
    );
  }

  clear() {
    this.contents.clear();
  }
}

module.exports = { ChangePreviewProvider };

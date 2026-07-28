'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {
  normalizeRelativePath,
  isWriteProtectedPath,
  resolveInsideRoot,
  assertNoSymlinkEscape
} = require('./agent-safety');

const DEFAULT_SOURCE_GLOB = '**/*.{js,cjs,mjs,jsx,ts,tsx,json,jsonc,css,scss,html,md,py,java,cs,go,rs,php,vue,svelte,yml,yaml,xml,sql,sh,ps1}';
const WORKSPACE_EXCLUDE = '**/{node_modules,.git,out,dist,build,coverage,.next,.nuxt,.cache,.venv,venv,target}/**';
const MAX_READ_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 50000;

class WorkspaceAgent {
  constructor(context, onActivity = () => {}) {
    this.context = context;
    this.onActivity = onActivity;
    this.staged = new Map();
    this.appliedFiles = [];
    this.reviewSummary = '';
  }

  reset() {
    this.staged.clear();
    this.appliedFiles = [];
    this.reviewSummary = '';
  }

  get hasPendingReview() {
    return this.staged.size > 0 && Boolean(this.reviewSummary);
  }

  get hasStagedChanges() {
    return this.staged.size > 0;
  }

  getPendingReview() {
    if (!this.staged.size) return null;
    return {
      summary: this.reviewSummary || 'Alterações propostas pelo agente',
      files: [...this.staged.keys()]
    };
  }

  getPendingChange(filePath) {
    const normalized = normalizeRelativePath(filePath);
    const entry = this.staged.get(normalized)
      || [...this.staged.entries()].find(([relative]) => relative === filePath)?.[1];
    const relative = this.staged.has(normalized) ? normalized : filePath;
    if (!entry) throw new Error(`Alteração pendente não encontrada: ${filePath}`);
    return {
      filePath: relative,
      originalContent: entry.originalContent,
      proposedContent: entry.content,
      existed: entry.existed
    };
  }

  async createFunctions() {
    const { defineChatSessionFunction } = await import('node-llama-cpp');

    return {
      listWorkspaceFiles: defineChatSessionFunction({
        description: 'Lista arquivos de código do workspace. Não inclui node_modules. Use um glob específico quando possível.',
        params: {
          type: 'object',
          properties: {
            pattern: { type: 'string' }
          },
          required: ['pattern']
        },
        handler: async ({ pattern }) => this.listWorkspaceFiles(pattern)
      }),

      searchWorkspaceText: defineChatSessionFunction({
        description: 'Pesquisa texto nos arquivos do workspace, excluindo node_modules e .git. Retorna caminhos, linhas e trechos.',
        params: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            pattern: { type: 'string' }
          },
          required: ['query', 'pattern']
        },
        handler: async ({ query, pattern }) => this.searchWorkspaceText(query, pattern)
      }),

      searchDependencySource: defineChatSessionFunction({
        description: 'Pesquisa somente dentro do pacote indicado em node_modules para entender APIs e comportamento. É estritamente somente leitura.',
        params: {
          type: 'object',
          properties: {
            packageName: { type: 'string' },
            query: { type: 'string' },
            pattern: { type: 'string' }
          },
          required: ['packageName', 'query', 'pattern']
        },
        handler: async ({ packageName, query, pattern }) => this.searchDependencySource(packageName, query, pattern)
      }),

      readFile: defineChatSessionFunction({
        description: 'Lê um arquivo texto do workspace por linhas. Pode ler node_modules, mas nunca modifica essa pasta.',
        params: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' }
          },
          required: ['filePath', 'startLine', 'endLine']
        },
        handler: async ({ filePath, startLine, endLine }) => this.readFile(filePath, startLine, endLine)
      }),

      stageReplace: defineChatSessionFunction({
        description: 'Prepara uma substituição exata em um arquivo do workspace. É proibido usar em node_modules ou .git. Não salva até applyChanges.',
        params: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
            replaceAll: { type: 'boolean' }
          },
          required: ['filePath', 'oldText', 'newText', 'replaceAll']
        },
        handler: async ({ filePath, oldText, newText, replaceAll }) => this.stageReplace(filePath, oldText, newText, replaceAll)
      }),

      stageFile: defineChatSessionFunction({
        description: 'Prepara o conteúdo completo de um arquivo novo ou existente. É proibido usar em node_modules ou .git. Prefira stageReplace em arquivos grandes.',
        params: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['filePath', 'content']
        },
        handler: async ({ filePath, content }) => this.stageFile(filePath, content)
      }),

      applyChanges: defineChatSessionFunction({
        description: 'Finaliza as alterações preparadas e envia para revisão do usuário. Não salva nada até o usuário aceitar no chat. Nunca grava em node_modules ou .git.',
        params: {
          type: 'object',
          properties: {
            summary: { type: 'string' }
          },
          required: ['summary']
        },
        handler: async ({ summary }) => this.applyChanges(summary)
      })
    };
  }

  async listWorkspaceFiles(pattern) {
    this.#requireWorkspace();
    const safePattern = this.#safeGlob(pattern || DEFAULT_SOURCE_GLOB);
    this.onActivity(`Listando arquivos: ${safePattern}`);
    const uris = await vscode.workspace.findFiles(safePattern, WORKSPACE_EXCLUDE, 240);
    const files = uris.map(uri => vscode.workspace.asRelativePath(uri, true)).sort();
    return this.#result({ count: files.length, files });
  }

  async searchWorkspaceText(query, pattern) {
    this.#requireWorkspace();
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return this.#result({ error: 'A pesquisa está vazia.' });
    const safePattern = this.#safeGlob(pattern || DEFAULT_SOURCE_GLOB);
    this.onActivity(`Pesquisando “${normalizedQuery}” no workspace`);
    const uris = await vscode.workspace.findFiles(safePattern, WORKSPACE_EXCLUDE, 220);
    const matches = await this.#searchUris(uris, normalizedQuery, 60);
    return this.#result({ query: normalizedQuery, count: matches.length, matches });
  }

  async searchDependencySource(packageName, query, pattern) {
    this.#requireWorkspace();
    const safePackage = this.#safePackageName(packageName);
    const safePattern = this.#safeDependencyPattern(pattern);
    const normalizedQuery = String(query || '').trim();
    this.onActivity(`Consultando node_modules/${safePackage} (somente leitura)`);

    const include = `**/node_modules/${safePackage}/${safePattern}`;
    const nestedExclude = `**/node_modules/${safePackage}/**/{node_modules,.git,.cache,coverage}/**`;
    const uris = await vscode.workspace.findFiles(include, nestedExclude, 180);

    if (!normalizedQuery) {
      const files = uris.map(uri => vscode.workspace.asRelativePath(uri, true)).sort();
      return this.#result({ packageName: safePackage, readOnly: true, count: files.length, files });
    }

    const matches = await this.#searchUris(uris, normalizedQuery, 60);
    return this.#result({ packageName: safePackage, readOnly: true, query: normalizedQuery, count: matches.length, matches });
  }

  async readFile(filePath, startLine = 1, endLine = 240) {
    this.#requireWorkspace();
    const target = this.#resolveWorkspaceFile(filePath);
    const relative = target.relative;
    this.onActivity(`Lendo ${relative}${isWriteProtectedPath(relative) ? ' (somente leitura)' : ''}`);

    const stat = await fsp.stat(target.absolute);
    if (!stat.isFile()) return this.#result({ error: 'O caminho não é um arquivo.', filePath: relative });
    if (stat.size > MAX_READ_BYTES) {
      return this.#result({ error: `Arquivo maior que ${MAX_READ_BYTES} bytes. Leia uma fonte menor ou mais específica.`, filePath: relative });
    }

    const content = await this.#currentContent(relative, target.absolute);
    if (content.includes('\0')) return this.#result({ error: 'Arquivo binário não suportado.', filePath: relative });
    const lines = content.split(/\r?\n/);
    const from = Math.max(1, Number(startLine) || 1);
    const to = Math.min(lines.length, Math.max(from, Number(endLine) || from + 239), from + 399);
    const excerpt = lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join('\n');
    return this.#result({ filePath: relative, readOnly: isWriteProtectedPath(relative), totalLines: lines.length, startLine: from, endLine: to, content: excerpt });
  }

  async stageReplace(filePath, oldText, newText, replaceAll = false) {
    const target = this.#resolveWritableFile(filePath);
    if (!oldText) return this.#result({ error: 'oldText não pode ser vazio.', filePath: target.relative });

    const previousStage = this.staged.get(target.relative);
    const content = previousStage?.content ?? await this.#sourceContent(target.absolute);
    const originalContent = previousStage?.originalContent ?? content;
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      return this.#result({ error: 'O trecho oldText não foi encontrado exatamente. Leia o arquivo novamente e use o texto exato.', filePath: target.relative });
    }
    if (!replaceAll && occurrences > 1) {
      return this.#result({ error: `O trecho aparece ${occurrences} vezes. Torne oldText mais específico ou use replaceAll.`, filePath: target.relative });
    }

    const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    this.staged.set(target.relative, { absolute: target.absolute, content: updated, originalContent, existed: fs.existsSync(target.absolute) });
    this.onActivity(`Alteração preparada: ${target.relative}`);
    return this.#result({ staged: true, filePath: target.relative, replacements: replaceAll ? occurrences : 1, stagedFiles: [...this.staged.keys()] });
  }

  async stageFile(filePath, content) {
    const target = this.#resolveWritableFile(filePath);
    if (typeof content !== 'string') return this.#result({ error: 'O conteúdo precisa ser texto.', filePath: target.relative });
    if (Buffer.byteLength(content) > MAX_READ_BYTES) {
      return this.#result({ error: `Conteúdo maior que ${MAX_READ_BYTES} bytes. Divida a alteração em partes menores.`, filePath: target.relative });
    }
    const previousStage = this.staged.get(target.relative);
    const existed = fs.existsSync(target.absolute);
    const originalContent = previousStage?.originalContent ?? (existed ? await this.#sourceContent(target.absolute) : '');
    if (originalContent.includes('\0')) return this.#result({ error: 'Arquivos binários não podem ser alterados.', filePath: target.relative });
    this.staged.set(target.relative, { absolute: target.absolute, content, originalContent, existed });
    this.onActivity(`Arquivo preparado: ${target.relative}`);
    return this.#result({ staged: true, filePath: target.relative, bytes: Buffer.byteLength(content), stagedFiles: [...this.staged.keys()] });
  }

  async applyChanges(summary) {
    this.#requireWorkspace();
    if (!vscode.workspace.isTrusted) {
      return this.#result({ error: 'O workspace não está marcado como confiável no VS Code.' });
    }
    if (this.staged.size === 0) return this.#result({ error: 'Nenhuma alteração foi preparada.' });

    for (const relative of this.staged.keys()) {
      if (isWriteProtectedPath(relative)) {
        return this.#result({ error: `Bloqueio de segurança: não é permitido modificar ${relative}.` });
      }
    }

    this.reviewSummary = String(summary || 'Alterações propostas pelo agente').trim();
    this.onActivity(`${this.staged.size} arquivo(s) aguardando revisão`);
    return this.#result({
      reviewRequired: true,
      summary: this.reviewSummary,
      files: [...this.staged.keys()],
      message: 'As alterações foram preparadas. Aguarde o usuário abrir os diffs e aceitar ou rejeitar no chat.'
    });
  }

  preparePendingReview(summary = 'Alterações propostas pelo agente') {
    if (!this.staged.size) return null;
    this.reviewSummary = String(summary || 'Alterações propostas pelo agente').trim();
    return this.getPendingReview();
  }

  async acceptPendingChanges() {
    this.#requireWorkspace();
    if (!vscode.workspace.isTrusted) throw new Error('O workspace não está marcado como confiável no VS Code.');
    if (!this.staged.size) throw new Error('Nenhuma alteração pendente para aceitar.');

    for (const relative of this.staged.keys()) {
      if (isWriteProtectedPath(relative)) throw new Error(`Bloqueio de segurança: não é permitido modificar ${relative}.`);
    }

    const summary = this.reviewSummary || 'Alterações aceitas pelo usuário';
    const backup = await this.#createBackup(summary);
    const edit = new vscode.WorkspaceEdit();
    const documentsToSave = [];

    for (const [, staged] of this.staged) {
      const uri = vscode.Uri.file(staged.absolute);
      if (staged.existed) {
        const document = await vscode.workspace.openTextDocument(uri);
        const lastLine = Math.max(0, document.lineCount - 1);
        const end = document.lineAt(lastLine).range.end;
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), staged.content);
        documentsToSave.push(uri);
      } else {
        edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
        edit.insert(uri, new vscode.Position(0, 0), staged.content);
        documentsToSave.push(uri);
      }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) throw new Error('O VS Code recusou a aplicação das alterações.');

    for (const uri of documentsToSave) {
      const document = await vscode.workspace.openTextDocument(uri);
      await document.save();
    }

    this.appliedFiles = [...this.staged.keys()];
    const files = [...this.appliedFiles];
    this.staged.clear();
    this.reviewSummary = '';
    await this.context.globalState.update('offgrid.lastAgentBackup', backup.manifestPath);
    this.onActivity(`${files.length} arquivo(s) aceito(s) e salvo(s)`);

    return { applied: true, summary, files, backup: backup.displayPath };
  }

  rejectPendingChanges() {
    const files = [...this.staged.keys()];
    this.staged.clear();
    this.reviewSummary = '';
    this.onActivity(`${files.length} alteração(ões) rejeitada(s)`);
    return files;
  }

  async undoLastChanges() {
    const manifestPath = this.context.globalState.get('offgrid.lastAgentBackup');
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw new Error('Nenhum backup recente do agente foi encontrado.');
    }
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    for (const entry of manifest.files) {
      const target = this.#resolveWritableFile(entry.relative);
      if (entry.existed) {
        const backupBytes = await fsp.readFile(path.join(path.dirname(manifestPath), entry.backupName));
        await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
        await fsp.writeFile(target.absolute, backupBytes);
      } else if (fs.existsSync(target.absolute)) {
        await fsp.rm(target.absolute, { force: true });
      }
    }
    await this.context.globalState.update('offgrid.lastAgentBackup', undefined);
    return manifest.files.map(entry => entry.relative);
  }

  async #createBackup(summary) {
    const backupRoot = path.join(this.context.globalStorageUri.fsPath, 'agent-backups');
    const id = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const directory = path.join(backupRoot, id);
    await fsp.mkdir(directory, { recursive: true });
    const files = [];
    let index = 0;

    for (const [relative, staged] of this.staged) {
      const backupName = `${String(index).padStart(3, '0')}.bak`;
      if (staged.existed) await fsp.writeFile(path.join(directory, backupName), staged.originalContent, 'utf8');
      files.push({ relative, existed: staged.existed, backupName });
      index += 1;
    }

    const manifestPath = path.join(directory, 'manifest.json');
    await fsp.writeFile(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), summary, files }, null, 2));
    return { manifestPath, displayPath: directory };
  }

  async #searchUris(uris, query, maxMatches) {
    const needle = query.toLowerCase();
    const matches = [];
    for (const uri of uris) {
      if (matches.length >= maxMatches) break;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 600000) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        if (content.includes('\0')) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            matches.push({
              filePath: vscode.workspace.asRelativePath(uri, true),
              line: index + 1,
              excerpt: lines[index].trim().slice(0, 360)
            });
          }
        }
      } catch {
        // Arquivos que mudam durante a pesquisa são ignorados.
      }
    }
    return matches;
  }

  async #currentContent(relative, absolute) {
    const staged = this.staged.get(relative);
    if (staged) return staged.content;
    return this.#sourceContent(absolute);
  }

  async #sourceContent(absolute) {
    if (!fs.existsSync(absolute)) return '';
    const normalized = path.resolve(absolute);
    const openDocument = vscode.workspace.textDocuments.find(document => path.resolve(document.uri.fsPath) === normalized);
    if (openDocument) return openDocument.getText();
    return fsp.readFile(absolute, 'utf8');
  }

  #requireWorkspace() {
    if (!vscode.workspace.workspaceFolders?.length) throw new Error('Abra uma pasta ou workspace no VS Code.');
  }

  #resolveWorkspaceFile(inputPath) {
    this.#requireWorkspace();
    const normalized = normalizeRelativePath(inputPath);
    const folders = vscode.workspace.workspaceFolders;
    let folder = folders[0];
    let relative = normalized;

    if (folders.length > 1) {
      const firstSegment = normalized.split('/')[0];
      const matched = folders.find(item => item.name === firstSegment);
      if (matched) {
        folder = matched;
        relative = normalized.split('/').slice(1).join('/');
      }
    }

    const absolute = resolveInsideRoot(folder.uri.fsPath, relative);
    const display = folders.length > 1 ? `${folder.name}/${relative}` : relative;
    return { folder, absolute, relative: display };
  }

  #resolveWritableFile(inputPath) {
    const target = this.#resolveWorkspaceFile(inputPath);
    if (isWriteProtectedPath(target.relative)) {
      throw new Error(`Bloqueio de segurança: ${target.relative} é somente leitura.`);
    }
    assertNoSymlinkEscape(target.folder.uri.fsPath, target.absolute);
    return target;
  }

  #safeGlob(pattern) {
    const value = String(pattern || DEFAULT_SOURCE_GLOB).trim();
    if (!value || value.includes('\0') || value.includes('..')) return DEFAULT_SOURCE_GLOB;
    if (value.toLowerCase().includes('node_modules') || value.toLowerCase().includes('.git')) return DEFAULT_SOURCE_GLOB;
    return value.slice(0, 240);
  }

  #safePackageName(packageName) {
    const value = String(packageName || '').trim();
    if (!/^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(value)) {
      throw new Error('Nome de pacote inválido. Use, por exemplo, express ou @scope/pacote.');
    }
    return value;
  }

  #safeDependencyPattern(pattern) {
    const value = String(pattern || '**/*.{js,cjs,mjs,ts,d.ts,json}').trim();
    if (!value || value.includes('\0') || value.includes('..') || value.toLowerCase().includes('node_modules')) {
      return '**/*.{js,cjs,mjs,ts,d.ts,json}';
    }
    return value.slice(0, 240);
  }

  #result(value) {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return value;
    return {
      truncated: true,
      message: 'Resultado truncado. Faça uma pesquisa mais específica.',
      preview: serialized.slice(0, MAX_TOOL_OUTPUT_CHARS)
    };
  }
}

module.exports = { WorkspaceAgent };

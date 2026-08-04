import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { AgentAutonomy, PendingFileChange, PendingReview, ToolCall, ToolResult } from '../types/contracts';
import { normalizeRelativePath, isWriteProtectedPath, resolveInsideRoot, assertNoSymlinkEscape } from '../safety/PathSafety';
import { ApprovalService } from '../safety/ApprovalService';
import type { FileLogger } from '../diagnostics/FileLogger';
import { validateContentAgainstProjectInstructions } from '../context/ProjectInstructions';

const execFileAsync = promisify(execFile);
const EXCLUDE = '**/{node_modules,.git,out,dist,build,coverage,.next,.nuxt,.cache,.venv,venv,target}/**';
const DEFAULT_GLOB = '**/*.{js,cjs,mjs,jsx,ts,tsx,json,jsonc,css,scss,html,md,py,java,kt,kts,cs,go,rs,php,vue,svelte,yml,yaml,xml,sql,sh,ps1}';

interface StagedEntry { content: string; original: string; existed: boolean; delete: boolean }

export class WorkspaceTools {
  private readonly staged = new Map<string, StagedEntry>();
  private reviewSummary = '';
  private memory: Array<{ title: string; content: string; type: string; date: string }> = [];
  private readonly memoryFile?: string;

  constructor(
    private readonly workspaceRoot: string | undefined,
    private readonly approval: ApprovalService,
    private readonly logger: FileLogger,
    private readonly autonomy: () => AgentAutonomy = () => 'assisted'
  ) {
    if (workspaceRoot) {
      this.memoryFile = path.join(workspaceRoot, '.offgrid', 'memory.json');
      this.loadMemory().catch(() => undefined);
    }
  }

  get pendingReview(): PendingReview | undefined {
    if (!this.staged.size) return undefined;
    return {
      summary: this.reviewSummary || 'Alterações propostas pelo Agente',
      files: [...this.staged.entries()].map(([filePath, entry]) => ({
        filePath,
        kind: entry.delete ? 'deleted' : entry.existed ? 'modified' : 'created'
      }))
    };
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const started = Date.now();
    this.logger.info('agent', `[Tool] ${call.name} ${JSON.stringify(call.arguments)}`);
    try {
      const content = await this.dispatch(call.name, call.arguments);
      const result: ToolResult = { callId: call.id, name: call.name, ok: true, content, durationMs: Date.now() - started };
      this.logger.debug('agent', `[Perf] tool.${call.name}: ${result.durationMs} ms`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('agent', `[Tool][ERRO] ${call.name}: ${message}`, error);
      return { callId: call.id, name: call.name, ok: false, content: null, error: message, durationMs: Date.now() - started };
    }
  }

  getChange(filePath: string): PendingFileChange {
    const relative = normalizeRelativePath(filePath);
    const entry = this.staged.get(relative);
    if (!entry) throw new Error(`Alteração não encontrada: ${relative}`);
    return {
      filePath: relative,
      originalContent: entry.original,
      proposedContent: entry.delete ? '' : entry.content,
      existed: entry.existed,
      kind: entry.delete ? 'deleted' : entry.existed ? 'modified' : 'created'
    };
  }

  async acceptChanges(): Promise<string[]> {
    const files = [...this.staged.keys()];
    for (const relative of files) await this.acceptChange(relative, false);
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    return files;
  }

  async acceptChange(filePath: string, saveAll = true): Promise<string> {
    this.requireWorkspace();
    const relative = normalizeRelativePath(filePath);
    const entry = this.staged.get(relative);
    if (!entry) throw new Error(`Alteração não encontrada: ${relative}`);
    await this.writeEntry(relative, entry);
    this.staged.delete(relative);
    if (!this.staged.size) this.reviewSummary = '';
    if (saveAll) await vscode.commands.executeCommand('workbench.action.files.saveAll');
    return relative;
  }

  rejectChange(filePath: string): string {
    const relative = normalizeRelativePath(filePath);
    if (!this.staged.delete(relative)) throw new Error(`Alteração não encontrada: ${relative}`);
    if (!this.staged.size) this.reviewSummary = '';
    return relative;
  }

  rejectChanges(): void { this.staged.clear(); this.reviewSummary = ''; }
  reset(): void { this.rejectChanges(); }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_active_file': return this.activeFile();
      case 'get_selection': return this.selection();
      case 'list_files': return this.listFiles(String(args.pattern ?? DEFAULT_GLOB));
      case 'list_directory_tree': return this.directoryTree(String(args.root ?? ''), Number(args.maxDepth ?? 4));
      case 'read_file': return this.readFile(String(args.filePath), Number(args.startLine ?? 1), Number(args.endLine ?? 240));
      case 'search_codebase': return this.search(String(args.query), String(args.pattern ?? DEFAULT_GLOB));
      case 'get_diagnostics': return this.diagnostics(args.filePath ? String(args.filePath) : undefined);
      case 'find_symbol': return this.symbols(String(args.query));
      case 'find_definition': return this.locationCommand('vscode.executeDefinitionProvider', args);
      case 'find_references': return this.locationCommand('vscode.executeReferenceProvider', args);
      case 'get_hover': return this.locationCommand('vscode.executeHoverProvider', args);
      case 'git_status': return this.git(['status','--short']);
      case 'git_diff': return this.git(['diff','--', ...(args.filePath ? [String(args.filePath)] : [])]);
      case 'get_memory': return this.getMemory(String(args.query ?? ''));
      case 'save_memory': return this.saveMemory(String(args.title), String(args.content), String(args.type ?? 'decision'));
      case 'apply_edit': return this.applyEdit(args);
      case 'create_file': return this.stageFile(String(args.filePath), String(args.content ?? ''), false, String(args.reason ?? ''));
      case 'delete_file': return this.stageDelete(String(args.filePath), String(args.reason ?? ''));
      case 'rename_file': return this.renameFile(String(args.filePath), String(args.newPath));
      case 'run_terminal': return this.runTerminal(String(args.command));
      case 'apply_changes': {
        if (!this.staged.size) throw new Error('Nenhuma alteração foi preparada para revisão.');
        this.reviewSummary = String(args.summary || 'Alterações propostas pelo Agente');
        return this.pendingReview;
      }
      default: throw new Error(`Ferramenta desconhecida: ${name}`);
    }
  }

  private workspaceEditor(): vscode.TextEditor | undefined {
    const editors = [
      vscode.window.activeTextEditor,
      ...vscode.window.visibleTextEditors
    ];

    return editors.find((editor): editor is vscode.TextEditor => {
      if (!editor || editor.document.uri.scheme !== 'file') {
        return false;
      }

      if (!this.workspaceRoot) {
        return true;
      }

      const relative = path.relative(
        this.workspaceRoot,
        editor.document.uri.fsPath
      );

      return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    });
  }

  private activeFile(): unknown {
    const editor = this.workspaceEditor();

    if (!editor) {
      return { filePath: null };
    }

    return {
      filePath: vscode.workspace.asRelativePath(
        editor.document.uri,
        false
      ),
      language: editor.document.languageId
    };
  }

  private selection(): unknown {
    const editor = this.workspaceEditor();

    if (!editor) {
      return {
        filePath: null,
        text: ''
      };
    }

    return {
      filePath: vscode.workspace.asRelativePath(
        editor.document.uri,
        false
      ),
      text: editor.document.getText(editor.selection),
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1
    };
  }
  private async listFiles(pattern: string): Promise<unknown> {
    const uris = await vscode.workspace.findFiles(pattern || DEFAULT_GLOB, EXCLUDE, 300);
    return { count: uris.length, files: uris.map((uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, true)).sort() };
  }
  private async directoryTree(root: string, maxDepth: number): Promise<unknown> {
    this.requireWorkspace();
    const start = root ? resolveInsideRoot(this.workspaceRoot!, root) : this.workspaceRoot!;
    const lines: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > Math.max(1, Math.min(8, maxDepth))) return;
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (['node_modules','.git','out','dist','build','.cache'].includes(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(this.workspaceRoot!, absolute).replace(/\\/g, '/');
        lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '📁' : '📄'} ${relative}`);
        if (entry.isDirectory() && lines.length < 500) await walk(absolute, depth + 1);
        if (lines.length >= 500) return;
      }
    };
    await walk(start, 0);
    return { tree: lines };
  }
  private async readFile(filePath: string, startLine: number, endLine: number): Promise<unknown> {
    this.requireWorkspace();
    const relative = normalizeRelativePath(filePath);
    const absolute = resolveInsideRoot(this.workspaceRoot!, relative);
    const staged = this.staged.get(relative);
    const content = staged ? staged.content : await fsp.readFile(absolute, 'utf8');
    const lines = content.split(/\r?\n/);
    const from = Math.max(1, startLine || 1), to = Math.min(lines.length, Math.max(from, endLine || from + 239));
    return { filePath: relative, startLine: from, endLine: to, totalLines: lines.length, content: lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join('\n') };
  }
  private async search(query: string, pattern: string): Promise<unknown> {
    const files = await vscode.workspace.findFiles(pattern || DEFAULT_GLOB, EXCLUDE, 220);
    const regex = safeRegex(query);
    const matches: unknown[] = [];
    for (const uri of files) {
      if (matches.length >= 80) break;
      let text = ''; try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { continue; }
      text.split(/\r?\n/).forEach((line, index) => { if (matches.length < 80 && regex.test(line)) matches.push({ filePath: vscode.workspace.asRelativePath(uri, true), line: index + 1, text: line.slice(0, 500) }); regex.lastIndex = 0; });
    }
    return { query, count: matches.length, matches };
  }
  private diagnostics(filePath?: string): unknown {
    if (filePath && this.workspaceRoot) {
      const entries = vscode.languages.getDiagnostics(vscode.Uri.file(resolveInsideRoot(this.workspaceRoot, filePath)));
      return entries.map(item => ({ severity: item.severity, message: item.message, line: item.range.start.line + 1 }));
    }
    const entries = vscode.languages.getDiagnostics();
    return entries.slice(0, 100).map(([uri, items]) => ({ filePath: vscode.workspace.asRelativePath(uri, true), diagnostics: items.slice(0, 20).map(item => ({ severity: item.severity, message: item.message, line: item.range.start.line + 1 })) }));
  }
  private async symbols(query: string): Promise<unknown> { return await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query); }
  private async locationCommand(command: string, args: Record<string, unknown>): Promise<unknown> {
    this.requireWorkspace();
    const uri = vscode.Uri.file(resolveInsideRoot(this.workspaceRoot!, String(args.filePath)));
    const position = new vscode.Position(Math.max(0, Number(args.line) - 1), Math.max(0, Number(args.character) - 1));
    return await vscode.commands.executeCommand(command, uri, position);
  }
  private async git(args: string[]): Promise<unknown> {
    this.requireWorkspace();
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: this.workspaceRoot, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    return { stdout, stderr };
  }
  private getMemory(query: string): unknown {
    const needle = query.toLowerCase();
    return this.memory.filter(item => !needle || `${item.title} ${item.content} ${item.type}`.toLowerCase().includes(needle)).slice(-30);
  }
  private async saveMemory(title: string, content: string, type: string): Promise<unknown> {
    if (!this.memoryFile) throw new Error('Abra um workspace para usar memória.');
    if (!await this.approval.confirmPersistentWrite('Salvar memória do projeto', title)) throw new Error('Memória rejeitada pelo usuário.');
    this.memory.push({ title, content, type, date: new Date().toISOString() });
    await fsp.mkdir(path.dirname(this.memoryFile), { recursive: true });
    await fsp.writeFile(this.memoryFile, JSON.stringify(this.memory, null, 2), 'utf8');
    return { saved: true, title };
  }
  private async applyEdit(args: Record<string, unknown>): Promise<unknown> {
    const filePath = requiredString(args.filePath, 'filePath');
    const oldText = requiredString(args.oldText, 'oldText');
    const newText = requiredString(args.newText, 'newText', true);
    const replaceAll = Boolean(args.replaceAll);
    const current = await this.currentContent(filePath);
    if (!current.includes(oldText)) throw new Error(`Texto original não encontrado em ${filePath}.`);
    const content = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
    return this.stageFile(filePath, content, true);
  }
  private async stageFile(filePath: string, content: string, existedExpected: boolean, reason = ''): Promise<unknown> {
    this.requireWorkspace();
    if (!filePath || filePath === 'undefined') throw new Error('Argumento filePath ausente.');
    const relative = normalizeRelativePath(filePath);
    if (isWriteProtectedPath(relative)) throw new Error(`Escrita bloqueada em ${relative}.`);
    const absolute = resolveInsideRoot(this.workspaceRoot!, relative);
    assertNoSymlinkEscape(this.workspaceRoot!, absolute);
    const previous = this.staged.get(relative);
    const existsOnDisk = fs.existsSync(absolute);
    if (existedExpected && !existsOnDisk && !previous) throw new Error(`Arquivo não encontrado: ${relative}`);
    if (!existedExpected && (existsOnDisk || previous)) throw new Error(`O arquivo já existe ou já foi preparado: ${relative}. Use apply_edit para modificá-lo.`);
    const existed = previous?.existed ?? existsOnDisk;
    const original = previous?.original ?? (existsOnDisk ? await fsp.readFile(absolute, 'utf8') : '');
    // OFFGRID_AGENTS_MD_VALIDATION: valida regras estruturadas antes da revisão.
    const projectValidation = await validateContentAgainstProjectInstructions({
      workspaceRoot: this.workspaceRoot,
      filePath: relative,
      content
    });
    if (projectValidation.instructions.files.length) {
      this.logger.debug('agent', `[AGENTS.md] Validando ${relative} com ${projectValidation.instructions.files.map(file => file.filePath).join(' → ')}.`);
    }
    if (projectValidation.violations.length) {
      const details = projectValidation.violations.map(item => `- ${item.line ? `linha ${item.line}: ` : ''}${item.message}`).join('\n');
      throw new Error(`Alteração bloqueada pelas regras do AGENTS.md em ${relative}:\n${details}`);
    }

    const serializedIssue = serializedCodeEnvelopeIssue(relative, content);
    if (serializedIssue) throw new Error(serializedIssue);

    const approved = previous
      ? true
      : existed
        ? await this.approval.confirmWrite('Preparar alteração', relative)
        : await this.approval.confirmFileCreation(relative, reason, this.autonomy());
    if (!approved) throw new Error('Alteração rejeitada pelo usuário.');
    this.staged.set(relative, { content, original, existed, delete: false });
    return { staged: true, filePath: relative, kind: existed ? 'modified' : 'created' };
  }
  private async stageDelete(filePath: string, reason: string): Promise<unknown> {
    const relative = normalizeRelativePath(filePath);
    if (isWriteProtectedPath(relative)) throw new Error(`Exclusão bloqueada em ${relative}.`);
    this.requireWorkspace();
    const absolute = resolveInsideRoot(this.workspaceRoot!, relative);
    assertNoSymlinkEscape(this.workspaceRoot!, absolute);
    const original = await this.currentContent(relative);
    const approved = await this.approval.confirmFileDeletion(relative, reason, this.autonomy());
    if (!approved) throw new Error('Exclusão rejeitada pelo usuário.');
    this.staged.set(relative, { content: '', original, existed: true, delete: true });
    return { staged: true, delete: true, filePath: relative };
  }
  private async renameFile(filePath: string, newPath: string): Promise<unknown> {
    const from = normalizeRelativePath(filePath);
    const to = normalizeRelativePath(newPath);
    if (from === to) throw new Error('O novo caminho é igual ao atual.');
    const content = await this.currentContent(from);
    await this.stageFile(to, content, false, `Renomeado de ${from}`);
    await this.stageDelete(from, `Renomeado para ${to}`);
    return { staged: true, renamed: true, from, to };
  }
  private async runTerminal(command: string): Promise<unknown> {
    this.requireWorkspace();
    if (!await this.approval.confirmTerminal(command)) throw new Error('Comando rejeitado pelo usuário.');
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoProfile','-Command',command] : ['-lc', command];
    const { stdout, stderr } = await execFileAsync(shell, args, { cwd: this.workspaceRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout, stderr };
  }
  private async currentContent(filePath: string): Promise<string> {
    this.requireWorkspace();
    const relative = normalizeRelativePath(filePath);
    const staged = this.staged.get(relative);
    if (staged) return staged.content;
    return fsp.readFile(resolveInsideRoot(this.workspaceRoot!, relative), 'utf8');
  }
  private async backup(relative: string, content: string): Promise<void> {
    const dir = path.join(this.workspaceRoot!, '.offgrid', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    const destination = path.join(dir, relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, content, 'utf8');
  }
  private async writeEntry(relative: string, entry: StagedEntry): Promise<void> {
    if (isWriteProtectedPath(relative)) throw new Error(`Escrita bloqueada: ${relative}`);
    const absolute = resolveInsideRoot(this.workspaceRoot!, relative);
    assertNoSymlinkEscape(this.workspaceRoot!, absolute);
    if (entry.existed) await this.backup(relative, entry.original);
    if (entry.delete) await fsp.rm(absolute, { force: true });
    else {
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, entry.content, 'utf8');
    }
  } 
  private async loadMemory(): Promise<void> { if (this.memoryFile) try { this.memory = JSON.parse(await fsp.readFile(this.memoryFile, 'utf8')); } catch { this.memory = []; } }
  private requireWorkspace(): void { if (!this.workspaceRoot) throw new Error('Nenhum workspace aberto.'); }
}

const SOURCE_CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.cjs', '.php', '.py', '.rs', '.ts', '.tsx'
]);

function serializedCodeEnvelopeIssue(
  filePath: string,
  content: string
): string | undefined {
  if (!SOURCE_CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return undefined;
  }

  const trimmed = content.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return [
        `O conteúdo de ${filePath} foi serializado como JSON em vez de código-fonte.`,
        'Envie somente o código completo do arquivo no argumento content.'
      ].join(' ');
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function safeRegex(query: string): RegExp { try { return new RegExp(query, 'i'); } catch { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`O argumento ${name} deve ser texto.`);
  if (!allowEmpty && !value.trim()) throw new Error(`Argumento obrigatório ausente: ${name}.`);
  return value;
}
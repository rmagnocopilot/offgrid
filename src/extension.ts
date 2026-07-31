import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { EngineClient } from './engine/EngineClient';
import { FileLogger } from './diagnostics/FileLogger';
import { ModelCatalog } from './models/ModelCatalog';
import { ModelInstaller } from './models/ModelInstaller';
import { SessionStore } from './sessions/SessionStore';
import { WorkspaceTools } from './tools/WorkspaceTools';
import { ApprovalService } from './safety/ApprovalService';
import { ChatViewProvider, type UiEvent } from './ui/ChatViewProvider';
import { ChangePreviewProvider } from './ui/ChangePreviewProvider';
import { ContextManager } from './context/ContextManager';
import { buildTemporalContext } from './context/TemporalContext';
import { schemasForMode } from './tools/ToolRegistry';
import type {
  ApprovalMode, ConversationMode, DiagnosticsPanelMode, EngineDiagnostics, EngineLoadOptions,
  LogLevel, ModelDefinition, ModelStatus, ToolCall, UiState
} from './types/contracts';

let services: Services | undefined;

type OffgridFolder = 'models' | 'data' | 'logs';

interface Services {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  logger: FileLogger;
  engine: EngineClient;
  catalog: ModelCatalog;
  installer: ModelInstaller;
  sessions: SessionStore;
  tools: WorkspaceTools;
  contextManager: ContextManager;
  view: ChatViewProvider;
  preview: ChangePreviewProvider;
  statusBar: vscode.StatusBarItem;
  controller?: AbortController;
  activeModelId?: string;
  mode: ConversationMode;
  diagnosticsPanel: DiagnosticsPanelMode;
  modelErrors: Record<string, string>;
  monitor?: NodeJS.Timeout;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Offgrid');
  const config = vscode.workspace.getConfiguration('offgrid');
  const logsPath = path.join(context.globalStorageUri.fsPath, 'logs');
  const logger = new FileLogger({
    directory: logsPath,
    level: config.get<LogLevel>('logLevel', 'debug'),
    output: line => output.appendLine(line)
  });
  logger.info('offgrid', `Offgrid ${context.extension.packageJSON.version} ativado. Plataforma=${process.platform}; TypeScript=sim; motor isolado=sim.`);

  const modelsDirectory = path.join(context.globalStorageUri.fsPath, 'models');
  await Promise.all([
    fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true }),
    fsp.mkdir(logsPath, { recursive: true }),
    fsp.mkdir(modelsDirectory, { recursive: true })
  ]);
  const catalog = new ModelCatalog(context.extensionUri.fsPath, modelsDirectory);
  const repository = repositoryUrl(context.extension.packageJSON.repository);
  const installer = new ModelInstaller(modelsDirectory, catalog.releaseBaseUrl(repository));
  const engine = new EngineClient(context.extensionUri.fsPath, context.globalStorageUri.fsPath, logger);
  await engine.init();
  const sessions = new SessionStore(context.globalStorageUri.fsPath);
  await sessions.init();
  // A conversa anterior permanece no histórico, mas cada nova abertura da
  // extensão começa em uma sessão vazia.
  sessions.archiveCurrent();
  const approval = new ApprovalService(() => vscode.workspace.getConfiguration('offgrid').get<ApprovalMode>('agentApprovalMode', 'ask'));
  const tools = new WorkspaceTools(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, approval, logger);
  const contextManager = new ContextManager();
  const view = new ChatViewProvider(context.extensionUri);
  const preview = new ChangePreviewProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'offgrid.openChat'; statusBar.tooltip = 'Abrir Offgrid'; statusBar.show();

  services = {
    context, output, logger, engine, catalog, installer, sessions, tools, contextManager, view, preview, statusBar,
    mode: 'chat', diagnosticsPanel: config.get<DiagnosticsPanelMode>('diagnosticsPanel', 'compact'), modelErrors: {}
  };

  context.subscriptions.push(
    output, view, preview, statusBar,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }),
    view.onEvent(event => safeHandleUiEvent(services!, event)),
    vscode.window.onDidChangeActiveTextEditor(editor => { services!.contextManager.updateActive(editor); void refreshUi(services!); }),
    vscode.workspace.onDidChangeConfiguration(event => onConfigurationChanged(services!, event)),
    { dispose: () => { if (services?.monitor) clearInterval(services.monitor); void services?.engine.dispose(); void services?.sessions.flush(); void services?.logger.flush(); } }
  );

  registerCommands(services);
  services.activeModelId = await restoreActiveModel(services);
  await refreshUi(services);
  startMonitoring(services);

  if (!context.globalState.get<boolean>('offgrid.welcomeShown')) {
    await context.globalState.update('offgrid.welcomeShown', true);
    await view.reveal();
    vscode.window.showInformationMessage('Bem-vindo ao Offgrid. Escolha um modelo no topo do painel.');
    await refreshUi(services);
  }

  if (config.get<boolean>('autoLoadModel', true) && services.activeModelId) {
    void loadModelById(services, services.activeModelId, false).catch(error => logger.warn('model', 'Carregamento automático falhou.', error));
  }
}

export async function deactivate(): Promise<void> {
  if (!services) return;
  if (services.monitor) clearInterval(services.monitor);
  await services.engine.dispose();
  await services.sessions.flush();
  await services.logger.flush();
  services = undefined;
}

function registerCommands(s: Services): void {
  const command = (id: string, fn: (...args: unknown[]) => unknown): void => {
    s.context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  command('offgrid.openChat', () => s.view.reveal());
  command('offgrid.manageModels', () => manageModels(s));
  command('offgrid.unloadModel', () => unloadModel(s));
  command('offgrid.reloadModel', () => s.activeModelId ? loadModelById(s, s.activeModelId, true) : manageModels(s));
  command('offgrid.restartEngine', () => restartEngine(s));
  command('offgrid.copyDiagnostics', () => copyDiagnostics(s));
  command('offgrid.openModelsFolder', () => openOffgridFolder(s, 'models'));
  command('offgrid.openDataFolder', () => openOffgridFolder(s, 'data'));
  command('offgrid.openLogsFolder', () => openOffgridFolder(s, 'logs'));
  command('offgrid.showResourceDiagnostics', async () => {
    await s.engine.refreshResources(true);
    await refreshUi(s);
    await s.view.reveal();
  });
  command('offgrid.clearHardwareProfile', async () => {
    await s.engine.clearHardwareProfiles();
    vscode.window.showInformationMessage('Perfis automáticos de hardware removidos.');
  });
  command('offgrid.newSession', () => { s.sessions.create(); void refreshUi(s); });
  command('offgrid.pinActiveFile', () => { s.contextManager.pinActive(); void refreshUi(s); });
  command('offgrid.useAutoFile', () => { s.contextManager.useAuto(); void refreshUi(s); });
  command('offgrid.toggleMock', async () => {
    const cfg = vscode.workspace.getConfiguration('offgrid');
    const next = !cfg.get<boolean>('developmentMock', false);
    await cfg.update('developmentMock', next, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Modo visual simulado ${next ? 'ativado' : 'desativado'}.`);
    await refreshUi(s);
  });
}

async function safeHandleUiEvent(s: Services, event: UiEvent): Promise<void> {
  try {
    await handleUiEvent(s, event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.logger.error('offgrid', `Falha ao processar ação da interface (${event.type}): ${message}`, error);
    const action = await vscode.window.showErrorMessage(`Offgrid: ${message}`, 'Abrir Output', 'Abrir logs');
    if (action === 'Abrir Output') s.output.show(true);
    if (action === 'Abrir logs') await openOffgridFolder(s, 'logs');
    await refreshUi(s).catch(() => undefined);
  }
}

async function handleUiEvent(s: Services, event: UiEvent): Promise<void> {
  switch (event.type) {
    case 'ready': await refreshUi(s); break;
    case 'submit': s.mode = event.mode; await submit(s, event.text, event.mode); break;
    case 'abort': s.controller?.abort(); break;
    case 'selectModel': await loadModelById(s, event.modelId, false); break;
    case 'modelAction': await manageModels(s, event.modelId); break;
    case 'unloadModel': await unloadModel(s); break;
    case 'restartEngine': await restartEngine(s); break;
    case 'newSession': s.sessions.create(); await refreshUi(s); break;
    case 'viewHidden':
      if (!s.controller && !s.engine.isBusy && s.sessions.archiveCurrent()) await refreshUi(s);
      break;
    case 'sessionAction': await sessionAction(s, event.action, event.sessionId, event.value); break;
    case 'pinActiveFile': s.contextManager.pinActive(); await refreshUi(s); break;
    case 'useAutoFile': s.contextManager.useAuto(); await refreshUi(s); break;
    case 'addCurrentFile': s.contextManager.addCurrent(); await refreshUi(s); break;
    case 'addSelection': s.contextManager.addSelection(); await refreshUi(s); break;
    case 'clearContext': s.contextManager.clear(); await refreshUi(s); break;
    case 'openContextItem': await openContextItem(event.value); break;
    case 'openDiff': {
      if (vscode.workspace.getConfiguration('offgrid').get<boolean>('developmentMock', false)) {
        await s.preview.open({ filePath: event.filePath, originalContent: 'const estado = \'antigo\';\n', proposedContent: 'const estado = \'novo\';\n', existed: true });
      } else {
        await s.preview.open(s.tools.getChange(event.filePath));
      }
      break;
    }
    case 'acceptReview': {
      const files = await s.tools.acceptChanges(); s.sessions.addMessage({ role: 'system', text: `Alterações aceitas: ${files.join(', ')}` }); await refreshUi(s); break;
    }
    case 'rejectReview': s.tools.rejectChanges(); s.sessions.addMessage({ role: 'system', text: 'Alterações rejeitadas. Nenhum arquivo foi salvo.' }); await refreshUi(s); break;
    case 'copyDiagnostics': await copyDiagnostics(s); break;
    case 'openLogs': await openOffgridFolder(s, 'logs'); break;
    case 'setDiagnosticsPanel':
      s.diagnosticsPanel = event.value;
      await vscode.workspace.getConfiguration('offgrid').update('diagnosticsPanel', event.value, vscode.ConfigurationTarget.Global);
      await refreshUi(s); break;
  }
}

async function submit(s: Services, text: string, mode: ConversationMode): Promise<void> {
  if (!text.trim()) return;
  s.sessions.addMessage({ role: 'user', text });
  s.sessions.updateMetadata({ mode, contextFiles: s.contextManager.priority(text), modelId: s.activeModelId, backend: s.engine.diagnostics.backend, contextSize: s.engine.diagnostics.contextSize ?? undefined });
  await refreshUi(s, true);
  const mock = vscode.workspace.getConfiguration('offgrid').get<boolean>('developmentMock', false);
  if (mock) { await mockSubmit(s, text, mode); return; }
  if (!s.engine.isLoaded) {
    vscode.window.showWarningMessage('Nenhum modelo carregado. Selecione um modelo no topo do painel.');
    await refreshUi(s); return;
  }
  const controller = new AbortController(); s.controller = controller;
  const messageId = randomUUID(); await s.view.streamStart(messageId);
  try {
    let response = '';
    if (mode === 'chat') {
      const prompt = await buildChatPrompt(s, text);
      response = await s.engine.prompt(prompt, { signal: controller.signal, onChunk: chunk => void s.view.streamChunk(messageId, chunk) });
    } else {
      const approvalMode = vscode.workspace.getConfiguration('offgrid').get<ApprovalMode>('agentApprovalMode', 'ask');
      const schemas = schemasForMode(approvalMode === 'readOnly' ? 'readOnly' : mode);
      const agentSystem = await buildAgentSystemPrompt(s, schemas, mode, text);
      response = await s.engine.runAgent({
        initialPrompt: text,
        systemPrompt: agentSystem,
        maxSteps: vscode.workspace.getConfiguration('offgrid').get<number>('maxAgentSteps', 10),
        diagnosticMode: vscode.workspace.getConfiguration('offgrid').get<boolean>('diagnosticMode', false),
        signal: controller.signal,
        executeTool: call => {
          if (!schemas.some(schema => schema.name === call.name)) return Promise.resolve({ callId: call.id, name: call.name, ok: false, content: null, error: `Ferramenta indisponível no modo ${mode}.`, durationMs: 0 });
          return s.tools.execute(call);
        }
      });
      await s.view.streamChunk(messageId, response);
      if (s.tools.pendingReview && approvalMode === 'full') {
        const files = await s.tools.acceptChanges();
        s.sessions.addMessage({ role: 'system', text: `Alterações aplicadas automaticamente com backup: ${files.join(', ')}` });
      }
    }
    s.sessions.addMessage({ role: 'assistant', text: response });
    s.sessions.updateMetadata({ lastError: undefined, backend: s.engine.diagnostics.backend });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as Error)?.name !== 'AbortError') {
      s.logger.error('agent', `Falha no modo ${mode}: ${message}`, error);
      s.sessions.addMessage({ role: 'system', text: `Erro: ${message}` });
      s.sessions.updateMetadata({ lastError: message });
    }
  } finally {
    s.controller = undefined; await s.view.streamEnd(messageId); await refreshUi(s);
  }
}

async function mockSubmit(s: Services, text: string, mode: ConversationMode): Promise<void> {
  await delay(350);
  let response = `Modo visual simulado · ${mode}. Pedido recebido: ${text}`;
  if (mode === 'agent') response = 'Simulação: ferramenta list_files executada; alteração preparada para revisão sem tocar no workspace.';
  s.sessions.addMessage({ role: 'assistant', text: response });
  await refreshUi(s);
}

async function loadModelById(s: Services, modelId: string, force: boolean): Promise<void> {
  let model: ModelDefinition;
  try {
    model = s.catalog.get(modelId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.logger.error('model', message, error);
    vscode.window.showErrorMessage(message);
    return;
  }

  let status = s.catalog.list(modelPathForActive(s), s.engine.diagnostics.modelPath, s.modelErrors)
    .find(item => item.id === modelId);
  if (!status) {
    const message = `Modelo não encontrado no catálogo: ${modelId}`;
    s.logger.error('model', message);
    vscode.window.showErrorMessage(message);
    return;
  }

  if (!fs.existsSync(status.filePath)) {
    const choice = await vscode.window.showInformationMessage(
      `${model.displayName} não está instalado (${model.approxSize}).`,
      { modal: true },
      'Baixar e carregar'
    );
    if (choice !== 'Baixar e carregar') {
      await refreshUi(s);
      return;
    }

    s.modelErrors[modelId] = '';
    await refreshUi(s, true);
    try {
      s.logger.info('model-install', `Iniciando instalação de ${model.displayName}.`);
      s.logger.info('model-install', `Origem: ${s.installer.baseUrl}`);
      s.logger.info('model-install', `Destino: ${status.filePath}`);
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Instalando ${model.displayName}`,
        cancellable: false
      }, async progress => {
        await s.installer.install(model, item => {
          s.logger.debug('model-install', item.message);
          progress.report({ message: item.message, increment: item.increment });
        });
      });
      status = s.catalog.list(modelPathForActive(s), s.engine.diagnostics.modelPath, s.modelErrors)
        .find(item => item.id === modelId);
      if (!status || !fs.existsSync(status.filePath)) {
        throw new Error('A instalação terminou, mas o arquivo GGUF não foi encontrado na pasta de modelos.');
      }
      s.logger.info('model-install', `Modelo instalado e validado: ${status.filePath}`);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const message = `Falha ao baixar ou instalar ${model.displayName}: ${cause}`;
      s.modelErrors[modelId] = message;
      s.logger.error('model-install', message, error);
      const action = await vscode.window.showErrorMessage(message, 'Abrir Output', 'Abrir pasta dos modelos', 'Abrir logs');
      if (action === 'Abrir Output') s.output.show(true);
      else if (action === 'Abrir pasta dos modelos') await openOffgridFolder(s, 'models');
      else if (action === 'Abrir logs') await openOffgridFolder(s, 'logs');
      await refreshUi(s);
      return;
    }
  }

  if (!force && s.engine.isLoaded && path.resolve(s.engine.diagnostics.modelPath) === path.resolve(status.filePath)) {
    await refreshUi(s);
    return;
  }

  const previous = s.activeModelId;
  s.activeModelId = modelId;
  s.modelErrors[modelId] = '';
  await s.context.globalState.update('offgrid.activeModelId', modelId);
  await refreshUi(s, true);

  try {
    const cfg = vscode.workspace.getConfiguration('offgrid');
    const options: EngineLoadOptions = {
      modelPath: status.filePath,
      gpu: parseBackend(cfg.get<unknown>('gpu', 'auto')),
      gpuLayers: parseGpuLayers(cfg.get<unknown>('gpuLayers', 'auto')),
      contextSize: cfg.get<number>('contextSize', 4096),
      maxTokens: cfg.get<number>('maxTokens', 1024),
      temperature: cfg.get<number>('temperature', 0.2),
      fallbackToCpu: cfg.get<boolean>('fallbackToCpu', true),
      adaptiveGpu: cfg.get<boolean>('adaptiveGpu', true)
    };
    const prompt = `${await readResource(s.context.extensionUri.fsPath, 'resources/system-prompt.md')}\n\n${buildTemporalContext()}`;
    s.logger.info('model', `Carregando ${model.displayName}. Caminho=${status.filePath}; backend=${options.gpu}; contexto=${options.contextSize}.`);
    await s.engine.load(options, prompt);
    vscode.window.showInformationMessage(`${model.displayName} carregado em ${s.engine.diagnostics.backend.toUpperCase()}.`);
  } catch (error) {
    const message = friendlyModelError(error, model.displayName);
    s.modelErrors[modelId] = message;

    // Um modelo só pode permanecer ativo quando o motor realmente continua
    // carregado. Em uma falha de carga, o EngineClient marca loaded=false;
    // portanto não devemos restaurar uma seleção antiga e exibi-la como ativa.
    const restoredModelId = s.engine.isLoaded ? previous : undefined;
    s.activeModelId = restoredModelId;
    await s.context.globalState.update('offgrid.activeModelId', restoredModelId);
    s.logger.error('model', message, error);
    const action = await vscode.window.showErrorMessage(message, 'Abrir Output', 'Abrir logs', 'Abrir pasta dos modelos');
    if (action === 'Abrir Output') s.output.show(true);
    else if (action === 'Abrir logs') await openOffgridFolder(s, 'logs');
    else if (action === 'Abrir pasta dos modelos') await openOffgridFolder(s, 'models');
  } finally {
    await refreshUi(s);
  }
}

async function restartEngine(s: Services): Promise<void> {
  const activeModelId = s.activeModelId;
  s.logger.info('model', 'Reiniciando o processo isolado do motor.');
  await s.engine.restart();
  if (activeModelId) {
    await loadModelById(s, activeModelId, true);
    return;
  }
  await refreshUi(s);
  vscode.window.showInformationMessage('Processo do motor reiniciado.');
}

async function clearActiveModelSelection(s: Services): Promise<void> {
  s.activeModelId = undefined;
  await s.context.globalState.update('offgrid.activeModelId', undefined);
}

async function unloadModel(s: Services): Promise<void> {
  const previousModelId = s.activeModelId;
  try {
    await s.engine.unload();
    await clearActiveModelSelection(s);
    s.logger.info('model', `Modelo descarregado e seleção ativa removida${previousModelId ? `: ${previousModelId}` : '.'}`);
    vscode.window.showInformationMessage('Modelo descarregado. Nenhum modelo permanece ativo.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Se o motor já ficou sem modelo apesar de uma falha tardia no processo de
    // descarregamento, a interface também deve abandonar a seleção antiga.
    if (!s.engine.isLoaded) await clearActiveModelSelection(s);

    s.logger.error('model', `Falha ao descarregar modelo: ${message}`, error);
    vscode.window.showErrorMessage(`Falha ao descarregar modelo: ${message}`);
  } finally {
    // Garante que uma atualização concorrente de diagnóstico não recoloque um
    // modelo antigo como ativo depois que o motor ficou descarregado.
    if (!s.engine.isLoaded && s.engine.diagnostics.engineState === 'unloaded') {
      await clearActiveModelSelection(s);
    }
    await refreshUi(s, false);
  }
}

async function manageModels(s: Services, preferredId?: string): Promise<void> {
  const models = s.catalog.list(modelPathForActive(s), s.engine.diagnostics.modelPath, s.modelErrors);
  let selected: ModelStatus | undefined;

  if (preferredId) selected = models.find(item => item.id === preferredId);
  else {
    type MenuItem = vscode.QuickPickItem & { model?: ModelStatus; folder?: OffgridFolder };
    const items: MenuItem[] = [
      ...models.map(model => ({ label: model.displayName, description: stateLabel(model), model })),
      { label: 'Pastas do Offgrid', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(folder-opened) Abrir pasta dos modelos', description: offgridFolderPath(s, 'models'), folder: 'models' },
      { label: '$(database) Abrir pasta de dados do Offgrid', description: offgridFolderPath(s, 'data'), folder: 'data' },
      { label: '$(output) Abrir pasta de logs', description: offgridFolderPath(s, 'logs'), folder: 'logs' }
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Modelos e pastas do Offgrid' });
    if (!picked) return;
    if (picked.folder) {
      await openOffgridFolder(s, picked.folder);
      return;
    }
    selected = picked.model;
  }

  if (!selected) return;
  const folderActions = ['Abrir pasta dos modelos', 'Abrir pasta de dados do Offgrid', 'Abrir pasta de logs'];
  const hasLocalFile = selected.fileSize > 0;
  const actions = hasLocalFile
    ? ['Carregar / ativar', 'Validar SHA-256', 'Reinstalar', 'Remover do disco', 'Ver detalhes', ...folderActions]
    : [selected.state === 'error' ? 'Tentar instalar novamente' : 'Instalar e carregar', 'Ver detalhes', ...folderActions];
  if (selected.state === 'loaded') actions.unshift('Descarregar da memória');
  const action = await vscode.window.showQuickPick(actions, { title: selected.displayName });
  if (!action) return;

  if (action === 'Instalar e carregar' || action === 'Tentar instalar novamente' || action === 'Carregar / ativar') {
    delete s.modelErrors[selected.id];
    await loadModelById(s, selected.id, action === 'Carregar / ativar');
  }
  else if (action === 'Descarregar da memória') await unloadModel(s);
  else if (action === 'Validar SHA-256') {
    const result = await s.installer.validate(selected);
    vscode.window.showInformationMessage(result.valid ? 'Modelo válido.' : `Modelo inválido. SHA atual: ${result.actual ?? 'ausente'}`);
  } else if (action === 'Reinstalar') {
    await s.installer.remove(selected);
    delete s.modelErrors[selected.id];
    await loadModelById(s, selected.id, true);
  } else if (action === 'Remover do disco') {
    if (selected.state === 'loaded' || selected.id === s.activeModelId) await unloadModel(s);
    const confirm = await vscode.window.showWarningMessage(`Remover ${selected.displayName} do disco?`, { modal: true }, 'Remover');
    if (confirm === 'Remover') {
      await s.installer.remove(selected);
      delete s.modelErrors[selected.id];
    }
  } else if (action === 'Abrir pasta dos modelos') await openOffgridFolder(s, 'models');
  else if (action === 'Abrir pasta de dados do Offgrid') await openOffgridFolder(s, 'data');
  else if (action === 'Abrir pasta de logs') await openOffgridFolder(s, 'logs');
  else vscode.window.showInformationMessage(`${selected.displayName}
${selected.description}
Hardware: ${selected.hardware}
Licença: ${selected.license}`);
  await refreshUi(s);
}

async function sessionAction(s: Services, action: string, id: string, value?: string): Promise<void> {
  if (action === 'switch') s.sessions.switch(id);
  else if (action === 'rename' && value) s.sessions.rename(id, value);
  else if (action === 'pin') s.sessions.pin(id);
  else if (action === 'duplicate') s.sessions.duplicate(id);
  else if (action === 'delete') s.sessions.delete(id);
  await refreshUi(s);
}

async function refreshUi(s: Services, busy = s.engine.isBusy): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('offgrid');
  const mock = cfg.get<boolean>('developmentMock', false);
  const contextState = s.contextManager.state;

  let engine: EngineDiagnostics = s.engine.diagnostics;

  // A interface só apresenta um modelo como ativo quando ele está realmente
  // carregado no motor. Isso evita que uma seleção persistida ou um refresh
  // atrasado mantenha o rótulo "ativo" depois de descarregar.
  if (!mock && engine.engineState === 'unloaded' && s.activeModelId) {
    await clearActiveModelSelection(s);
  }
  const hasLoadedModel = engine.loaded && Boolean(engine.modelPath);
  let activeModelId = hasLoadedModel ? s.activeModelId : undefined;
  let models = s.catalog.list(
    activeModelId ? modelPathForActive(s) : '',
    hasLoadedModel ? engine.modelPath : '',
    s.modelErrors
  );
  let pendingReview = s.tools.pendingReview;

  const mockModel = models[0];

  if (mock && mockModel) {
    activeModelId = mockModel.id;

    models = models.map(model => ({
      ...model,
      state:
        model.id === mockModel.id
          ? 'loaded'
          : model.lastError
            ? 'error'
            : model.fileSize > 0
              ? 'installed'
              : 'notInstalled'
    }));

    pendingReview = {
      summary: 'Simulação visual de alteração',
      files: ['src/exemplo.ts']
    };

    engine = {
      ...engine,
      loaded: true,
      loading: false,
      engineState: 'ready',
      modelPath: mockModel.fileName,
      backend: 'vulkan',
      contextSize: 4096,
      gpuLayers: 12,
      workerPid: 12345,
      resources: {
        capturedAt: new Date().toISOString(),
        platform: process.platform,
        systemRam: {
          totalBytes: 32 * 1024 ** 3,
          usedBytes: 20 * 1024 ** 3,
          freeBytes: 12 * 1024 ** 3
        },
        engineRam: {
          pid: 12345,
          workingSetBytes: 2.7 * 1024 ** 3
        },
        gpus: [
          {
            name: 'GPU simulada',
            totalBytes: 4 * 1024 ** 3,
            usedBytes: 2 * 1024 ** 3,
            freeBytes: 2 * 1024 ** 3,
            dedicated: true,
            source: 'nvidia-smi'
          }
        ]
      }
    };
  }

  const state: UiState = {
    version: s.context.extension.packageJSON.version,
    engine,
    models,
    activeModelId,
    mode: s.mode,
    diagnosticsPanel: s.diagnosticsPanel,
    pinnedFile: contextState.pinnedFile,
    autoFile: contextState.autoFile,
    contextItems: contextState.items,
    sessions: s.sessions.list(),
    currentSessionId: s.sessions.current().id,
    pendingReview,
    busy
  };

  s.statusBar.text =
    engine.engineState === 'loading'
      ? '$(loading~spin) Offgrid'
      : engine.loaded
        ? `$(debug-disconnect) ${shortModelName(engine.modelPath)} [${engine.backend.toUpperCase()}]`
        : '$(debug-disconnect) Offgrid';

  s.statusBar.tooltip = engine.lastError
    ? `Offgrid: ${engine.lastError}`
    : `Offgrid · Motor ${engine.engineState}`;

  await s.view.postState(state);
}

function startMonitoring(s: Services): void {
  const seconds = Math.max(10, vscode.workspace.getConfiguration('offgrid').get<number>('resourceRefreshSeconds', 15));
  s.monitor = setInterval(async () => {
    if (!vscode.workspace.getConfiguration('offgrid').get<boolean>('resourceMonitoring', true) || s.engine.isBusy) return;
    try { await s.engine.refreshResources(false); await refreshUi(s); } catch { /* diagnostic is best effort */ }
  }, seconds * 1000);
}

async function onConfigurationChanged(s: Services, event: vscode.ConfigurationChangeEvent): Promise<void> {
  if (event.affectsConfiguration('offgrid.logLevel')) s.logger.setLevel(vscode.workspace.getConfiguration('offgrid').get<LogLevel>('logLevel', 'debug'));
  if (event.affectsConfiguration('offgrid.diagnosticsPanel')) s.diagnosticsPanel = vscode.workspace.getConfiguration('offgrid').get<DiagnosticsPanelMode>('diagnosticsPanel', 'compact');
  await refreshUi(s);
}

async function restoreActiveModel(s: Services): Promise<string | undefined> {
  const stored = s.context.globalState.get<string>('offgrid.activeModelId');
  if (stored && s.catalog.manifest.models.some(item => item.id === stored)) {
    const installed = s.catalog.list().find(item => item.id === stored);
    if (installed && installed.fileSize > 0) return stored;
    await s.context.globalState.update('offgrid.activeModelId', undefined);
  }
  const configuredPath = vscode.workspace.getConfiguration('offgrid').get<string>('modelPath', '');
  const configured = s.catalog.manifest.models.find(item => path.basename(configuredPath).toLowerCase() === item.fileName.toLowerCase());
  if (!configured) return undefined;
  const installed = s.catalog.list().find(item => item.id === configured.id);
  return installed && installed.fileSize > 0 ? configured.id : undefined;
}

async function buildChatPrompt(s: Services, text: string): Promise<string> {
  const temporal = buildTemporalContext();
  const question = `<pergunta>\n${text}\n</pergunta>`;
  if (!vscode.workspace.getConfiguration('offgrid').get<boolean>('includeWorkspaceContext', true)) {
    return `${temporal}\n\n${question}`;
  }

  const files = s.contextManager.priority(text).slice(0, 5);
  const snippets: string[] = [];
  for (const reference of files) {
    const file = reference.split('#')[0];
    if (!file) continue;
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) break;
      const absolute = resolveInsideWorkspace(root, file);
      if (!absolute) continue;
      const content = await fsp.readFile(absolute, 'utf8');
      snippets.push(`<arquivo caminho="${file}">\n${content.slice(0, 16000)}\n</arquivo>`);
    } catch { /* optional */ }
  }

  return [temporal, ...snippets, question].filter(Boolean).join('\n\n');
}

async function buildAgentSystemPrompt(s: Services, schemas: ReturnType<typeof schemasForMode>, mode: ConversationMode, prompt: string): Promise<string> {
  const base = await readResource(s.context.extensionUri.fsPath, 'resources/agent-system-prompt.md');
  const priority = s.contextManager.priority(prompt);
  return [
    base,
    buildTemporalContext(),
    `Modo atual: ${mode}.`,
    `Ordem de contexto: ${priority.join(' → ') || 'nenhum arquivo explícito'}.`,
    'Ferramentas disponíveis:',
    ...schemas.map(tool => `- ${tool.name}: ${tool.description}\n  schema=${JSON.stringify(tool.inputSchema)}`)
  ].join('\n');
}

async function copyDiagnostics(s: Services): Promise<void> {
  const diagnostics = s.engine.diagnostics;
  const models = s.catalog.list(modelPathForActive(s), diagnostics.modelPath, s.modelErrors);
  const text = [
    `Offgrid version: ${s.context.extension.packageJSON.version}`,
    `VS Code version: ${vscode.version}`,
    `Node/Electron: ${process.version} / ${process.versions.electron ?? '—'}`,
    `OS: ${process.platform} ${process.arch}`,
    `Pasta de dados: ${offgridFolderPath(s, 'data')}`,
    `Pasta dos modelos: ${offgridFolderPath(s, 'models')}`,
    `Pasta de logs: ${offgridFolderPath(s, 'logs')}`,
    `Modelo ativo: ${s.activeModelId ?? 'nenhum'}`,
    `Modelo carregado: ${diagnostics.modelPath || 'nenhum'}`,
    `Backend: ${diagnostics.backend}`,
    `Estado: ${diagnostics.engineState}`,
    `Context size: ${diagnostics.contextSize ?? '—'}`,
    `GPU layers: ${diagnostics.gpuLayers}`,
    `PID: ${diagnostics.workerPid ?? '—'}`,
    `Último erro do motor: ${diagnostics.lastError ?? 'nenhum'}`,
    `Erro ao gravar logs: ${s.logger.lastFileError ?? 'nenhum'}`,
    '', 'Estado dos modelos:',
    ...models.map(model => `- ${model.id}: ${model.state}; arquivo=${model.filePath}; tamanho=${model.fileSize}; erro=${model.lastError ?? 'nenhum'}`),
    '', 'Últimas 100 linhas de log:', ...s.logger.recentLines()
  ].join('\n');
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('Diagnóstico copiado.');
}

async function openContextItem(value: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  const file = value.split('#')[0];
  if (!file) return;
  const absolute = resolveInsideWorkspace(root, file);
  if (!absolute) {
    vscode.window.showErrorMessage('O item de contexto aponta para fora do workspace.');
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(absolute), { preview: true });
}

async function openOffgridFolder(s: Services, folder: OffgridFolder): Promise<void> {
  const destination = offgridFolderPath(s, folder);
  await fsp.mkdir(destination, { recursive: true });
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destination));
}

function offgridFolderPath(s: Services, folder: OffgridFolder): string {
  if (folder === 'data') return s.context.globalStorageUri.fsPath;
  return path.join(s.context.globalStorageUri.fsPath, folder);
}

function resolveInsideWorkspace(root: string, relativeFile: string): string | undefined {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relativeFile);
  const relative = path.relative(absoluteRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return absolute;
}

function parseBackend(value: unknown): EngineLoadOptions['gpu'] {
  return value === 'cpu' || value === 'cuda' || value === 'vulkan' || value === 'metal' ? value : 'auto';
}
function parseGpuLayers(value: unknown): number | 'auto' {
  const number = Number(value);
  return value === 'auto' || !Number.isFinite(number) || number < 0 ? 'auto' : Math.floor(number);
}
function repositoryUrl(value: unknown): string { return typeof value === 'string' ? value : String((value as { url?: string })?.url ?? 'https://github.com/rmagnocopilot/offgrid'); }
function modelPathForActive(s: Services): string { const model = s.activeModelId ? s.catalog.list().find(item => item.id === s.activeModelId) : undefined; return model?.filePath ?? ''; }
function stateLabel(model: ModelStatus): string { return `${model.state} · ${model.approxSize}${model.lastError ? ` · ${model.lastError}` : ''}`; }
function shortModelName(file: string): string { return path.basename(file, '.gguf').replace('qwen2.5-coder-', 'Qwen ').replace('-instruct-q4_k_m', ''); }
function friendlyModelError(error: unknown, model: string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/cannot find module|node-llama-cpp/i.test(text)) return `Não foi possível iniciar ${model}: o runtime node-llama-cpp não foi encontrado ou não pôde ser carregado. Consulte os logs.`;
  if (/memory|allocate|vulkan|outofdevice/i.test(text)) return `Não foi possível carregar ${model}. Causa provável: memória GPU/RAM insuficiente. O Offgrid tentou perfis reduzidos e CPU. Consulte os logs.`;
  return `Não foi possível carregar ${model}: ${text}`;
}
function readResource(root: string, relative: string): Promise<string> { return fsp.readFile(path.join(root, relative), 'utf8'); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

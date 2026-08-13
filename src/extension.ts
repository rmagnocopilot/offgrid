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
import { loadProjectInstructions } from './context/ProjectInstructions';
import { buildAgentWorkspaceContext } from './agent/WorkspaceContextBuilder';
import { calculateAgentContextBudget, detectModelTier } from './agent/AgentContextBudget';
import {
  contextFallbacks, estimateRequiredBytes, estimateTaskComplexity, formatContextPlan, planContext, shouldExpandContext,
  type ContextMode, type ContextPlan, type ContextTaskEstimate
} from './context/AutomaticContextPlanner';
import { isDeviceMemoryError } from './llm/LlamaServerEngine';
import { tryPrepareSimpleEditFastPath } from './agent/SimpleEditFastPath';
import { tryPrepareStructuralEditFastPath } from './agent/StructuralEditFastPath';
import { tryPrepareDocumentationFastPath } from './agent/DocumentationFastPath';
import { tryPrepareTestGenerationFastPath } from './agent/TestGenerationFastPath';
import { tryPrepareJavaUnitTestFastPath } from './agent/JavaUnitTestFastPath';
import { tryPrepareAdaptivePatternFastPath } from './agent/AdaptivePatternFastPath';
import { tryPrepareBackendEndpointFastPath } from './agent/BackendEndpointFastPath';
import { tryPrepareBackendServiceFastPath } from './agent/BackendServiceFastPath';
import { tryPrepareFrontendCrudFastPath } from './agent/FrontendCrudFastPath';
import { tryPrepareFullStackFlowFastPath } from './agent/FullStackFlowFastPath';
import { tryPrepareFullStackRelationRefactorFastPath } from './agent/FullStackRelationRefactorFastPath';
import {
  analyzeBackendEndpointIntent, endpointTaskGuidance, existingEndpointResponse
} from './agent/BackendEndpointIntent';
import { analyzeBackendServiceIntent, serviceTaskGuidance } from './agent/BackendServiceIntent';
import { interpretLayeredTask } from './agent/LayeredTaskIntent';
import { analyzeFrontendCrudIntent, frontendCrudTaskGuidance } from './agent/FrontendCrudIntent';
import { analyzeFullStackFlowIntent, fullStackFlowTaskGuidance } from './agent/FullStackFlowIntent';
import { analyzeFullStackRelationRefactorIntent } from './agent/FullStackRelationRefactorIntent';
import {
  agentOutputTokenFloor,
  generatedFileContentIssue,
  isFileCreationTask,
  isJavaUnitTestCreationTask,
  javaUnitTestCreationTarget,
  workspaceRootCreationTarget
} from './agent/AgentTaskPolicy';
import { schemasForMode, validateToolArguments } from './tools/ToolRegistry';
import type {
  AgentAutonomy, ApprovalMode, ConversationMode, DiagnosticsPanelMode, EngineDiagnostics, EngineLoadOptions,
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
  /** Definido enquanto uma carga de modelo está prestes a iniciar ou em andamento. */
  pendingLoadModelId?: string;
  mode: ConversationMode;
  autonomy: AgentAutonomy;
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
    level: config.get<LogLevel>('logLevel', 'info'),
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
  const engine = new EngineClient(context.extensionUri.fsPath, context.globalStorageUri.fsPath, logger, catalog);
  await engine.init();
  const sessions = new SessionStore(context.globalStorageUri.fsPath);
  await sessions.init();
  // A conversa anterior permanece no histórico, mas cada nova abertura da
  // extensão começa em uma sessão vazia.
  sessions.archiveCurrent();
  const approval = new ApprovalService(() => vscode.workspace.getConfiguration('offgrid').get<ApprovalMode>('agentApprovalMode', 'ask'));
  const tools = new WorkspaceTools(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    approval,
    logger,
    () => services?.autonomy ?? 'assisted'
  );
  const contextManager = new ContextManager();
  const view = new ChatViewProvider(context.extensionUri);
  const preview = new ChangePreviewProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'offgrid.openChat'; statusBar.tooltip = 'Abrir Offgrid'; statusBar.show();

  services = {
    context, output, logger, engine, catalog, installer, sessions, tools, contextManager, view, preview, statusBar,
    mode: 'chat',
    autonomy: config.get<AgentAutonomy>('agentAutonomy', 'assisted'),
    diagnosticsPanel: config.get<DiagnosticsPanelMode>('diagnosticsPanel', 'compact'),
    modelErrors: {}
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
    case 'submit':
      s.mode = event.mode;
      s.autonomy = event.autonomy;
      await submit(s, event.text, event.mode);
      break;
    case 'setAutonomy':
      s.mode = event.mode;
      s.autonomy = event.value;
      await vscode.workspace.getConfiguration('offgrid').update(
        'agentAutonomy',
        event.value,
        vscode.ConfigurationTarget.Global
      );
      await refreshUi(s);
      break;
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
        await s.preview.open({ filePath: event.filePath, originalContent: 'const estado = \'antigo\';\n', proposedContent: 'const estado = \'novo\';\n', existed: true, kind: 'modified' });
      } else {
        await s.preview.open(s.tools.getChange(event.filePath));
      }
      break;
    }
    case 'acceptReviewFile': {
      const file = await s.tools.acceptChange(event.filePath);
      s.sessions.addMessage({ role: 'system', text: `Alteração aceita: ${file}` });
      await refreshUi(s);
      break;
    }
    case 'rejectReviewFile': {
      const file = s.tools.rejectChange(event.filePath);
      s.sessions.addMessage({ role: 'system', text: `Alteração descartada: ${file}` });
      await refreshUi(s);
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
    case 'setMode':
      // Persiste o modo imediatamente quando o select é alterado na webview,
      // antes do próximo submit. Evita que refreshUi sobrescreva o modo
      // com o valor antigo de s.mode.
      s.logger.debug('offgrid', `[UI] Modo alterado para: ${event.mode}`);
      s.mode = event.mode;
      break;
  }
}

async function submit(s: Services, text: string, mode: ConversationMode): Promise<void> {
  if (!text.trim()) return;
  s.sessions.addMessage({ role: 'user', text });
  s.sessions.updateMetadata({ mode, contextFiles: s.contextManager.priority(text), modelId: s.activeModelId, backend: s.engine.diagnostics.backend, contextSize: s.engine.diagnostics.contextSize ?? undefined });
  await refreshUi(s, true);
  const mock = vscode.workspace.getConfiguration('offgrid').get<boolean>('developmentMock', false);
  if (mock) { await mockSubmit(s, text, mode); return; }
  if (!s.engine.isLoaded && mode === 'chat') {
    vscode.window.showWarningMessage('Nenhum modelo carregado. Selecione um modelo no topo do painel.');
    await refreshUi(s); return;
  }
  const controller = new AbortController(); s.controller = controller;
  const messageId = randomUUID(); await s.view.streamStart(messageId);
  try {
    let response = '';
    if (mode === 'chat') {
      const chatPriority = s.contextManager.priority(text);
      await ensureAutomaticContextForTask(s, estimateTaskComplexity({
        request: text,
        estimatedFiles: Math.max(1, chatPriority.length)
      }));
      const prompt = await buildChatPrompt(s, text);
      response = await s.engine.prompt(prompt, { signal: controller.signal, onChunk: chunk => void s.view.streamChunk(messageId, chunk) });
    } else {
        s.logger.info(
          'agent',
          [
            '[Flow][0/6] Solicitação do Agente recebida.',
            `modo=${mode}`,
            `autonomia=${s.autonomy}`,
            `texto=${text.length} caracteres`,
            `workspace=${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'nenhum'}`
          ].join(' ')
        );
      const approvalMode = vscode.workspace
        .getConfiguration('offgrid')
        .get<ApprovalMode>('agentApprovalMode', 'ask');

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const initialPriority = s.contextManager.priority(text);
      const layeredTask = interpretLayeredTask(text);
      s.logger.info(
        'agent',
        [
          '[TaskIntent] Pedido interpretado.',
          `alvo=${layeredTask.targetLayer}`,
          `referências=${layeredTask.referenceLayers.join(',') || 'nenhuma'}`,
          `operação=${layeredTask.operation}`,
          `linguagem=${layeredTask.language}`,
          `confiança=${layeredTask.confidence}`,
          `ambíguo=${layeredTask.ambiguous}`
        ].join(' ')
      );
      const fullStackRelationRefactorAnalysis = mode === 'agent'
        ? await analyzeFullStackRelationRefactorIntent({
            request: text,
            workspaceRoot,
            priority: initialPriority,
            info: message => s.logger.info('agent', message),
            warn: message => s.logger.warn('agent', message)
          })
        : undefined;
      const fullStackFlowAnalysis = mode === 'agent' && !fullStackRelationRefactorAnalysis
        ? await analyzeFullStackFlowIntent({
            request: text,
            workspaceRoot,
            priority: initialPriority,
            info: message => s.logger.info('agent', message),
            warn: message => s.logger.warn('agent', message)
          })
        : undefined;
      const frontendCrudAnalysis = mode === 'agent' && !fullStackFlowAnalysis && !fullStackRelationRefactorAnalysis
        ? await analyzeFrontendCrudIntent({
            request: text,
            workspaceRoot,
            priority: initialPriority,
            info: message => s.logger.info('agent', message),
            warn: message => s.logger.warn('agent', message)
          })
        : undefined;
      const backendServiceAnalysis = mode === 'agent' && !frontendCrudAnalysis && !fullStackFlowAnalysis && !fullStackRelationRefactorAnalysis
        ? await analyzeBackendServiceIntent({
            request: text,
            workspaceRoot,
            priority: initialPriority,
            info: message => s.logger.info('agent', message),
            warn: message => s.logger.warn('agent', message)
          })
        : undefined;
      const backendEndpointAnalysis = mode === 'agent' && !frontendCrudAnalysis && !backendServiceAnalysis && !fullStackFlowAnalysis && !fullStackRelationRefactorAnalysis
        ? await analyzeBackendEndpointIntent({
            request: text,
            workspaceRoot,
            priority: initialPriority,
            info: message => s.logger.info('agent', message),
            warn: message => s.logger.warn('agent', message)
          })
        : undefined;
      const priority = fullStackRelationRefactorAnalysis?.priority.length
        ? fullStackRelationRefactorAnalysis.priority
        : fullStackFlowAnalysis?.priority.length
        ? fullStackFlowAnalysis.priority
        : frontendCrudAnalysis?.priority.length
          ? frontendCrudAnalysis.priority
          : backendServiceAnalysis?.priority.length
          ? backendServiceAnalysis.priority
          : backendEndpointAnalysis?.priority.length
            ? backendEndpointAnalysis.priority
            : initialPriority;

      const allSchemas = schemasForMode(
        approvalMode === 'readOnly' ? 'readOnly' : mode
      );
      const fileCreationTask = mode === 'agent' && isFileCreationTask(text);
      const genericFileCreationTask = fileCreationTask && !frontendCrudAnalysis && !backendServiceAnalysis && !backendEndpointAnalysis && !fullStackFlowAnalysis && !fullStackRelationRefactorAnalysis;
      const javaUnitTestTask = genericFileCreationTask && isJavaUnitTestCreationTask(text, priority);
      const rootCreationTarget = workspaceRootCreationTarget(
        layeredTask.explicitFiles,
        genericFileCreationTask
      );
      const contextPriority = rootCreationTarget ? [] : priority;
      let javaTestCreationTarget = javaUnitTestCreationTarget(text, contextPriority);
      const fileCreationTools = new Set([
        'list_files',
        'read_file',
        'create_file',
        'apply_changes'
      ]);
      // Testes Java já recebem classe-alvo + teste-exemplo pelo contexto
      // automático. list_files só aumenta o prompt e incentiva navegação
      // redundante; read_file permanece como fallback pontual.
      const javaUnitTestTools = new Set([
        'read_file',
        'run_java_coverage',
        'create_file',
        'apply_changes'
      ]);
      // Se já existe arquivo prioritário no contexto, get_active_file só faz o
      // modelo gastar uma etapa para descobrir algo que o prompt já informa.
      if (!contextPriority.length) fileCreationTools.add('get_active_file');
      const backendEndpointTools = new Set([
        'list_files',
        'list_directory_tree',
        'read_file',
        'search_codebase',
        'apply_edit',
        'apply_changes'
      ]);
      const backendServiceTools = new Set([
        'list_files',
        'read_file',
        'search_codebase',
        'apply_edit',
        'apply_changes'
      ]);
      const fullStackRelationRefactorTools = new Set([
        'list_files',
        'read_file',
        'search_codebase',
        'apply_edit',
        'apply_changes'
      ]);
      const fullStackFlowTools = new Set([
        'list_files',
        'list_directory_tree',
        'read_file',
        'search_codebase',
        'create_file',
        'apply_edit',
        'apply_changes'
      ]);
      const frontendCrudTools = new Set([
        'list_files',
        'read_file',
        'search_codebase',
        'apply_edit',
        'apply_changes'
      ]);
      if (!backendEndpointAnalysis?.resourceFile) backendEndpointTools.add('create_file');
      const schemas = frontendCrudAnalysis
        ? allSchemas.filter(schema => frontendCrudTools.has(schema.name))
        : backendServiceAnalysis
          ? allSchemas.filter(schema => backendServiceTools.has(schema.name))
          : backendEndpointAnalysis
            ? allSchemas.filter(schema => backendEndpointTools.has(schema.name))
            : javaUnitTestTask
              ? allSchemas.filter(schema => javaUnitTestTools.has(schema.name))
              : genericFileCreationTask
                ? allSchemas.filter(schema => fileCreationTools.has(schema.name))
                : allSchemas;
      const selectedSchemas = fullStackRelationRefactorAnalysis
        ? allSchemas.filter(schema => fullStackRelationRefactorTools.has(schema.name))
        : fullStackFlowAnalysis
        ? allSchemas.filter(schema => fullStackFlowTools.has(schema.name))
        : schemas;

      s.logger.debug(
        'agent',
        `[Flow][1/6] Catálogo preparado. ferramentas=${selectedSchemas.length}; autonomia=${s.autonomy}; segurança=${approvalMode}.`
      );

      if (backendEndpointAnalysis?.existingEndpoint) {
        response = existingEndpointResponse(backendEndpointAnalysis.existingEndpoint);
        await s.view.streamChunk(messageId, response);
        s.sessions.addMessage({ role: 'assistant', text: response });
        s.sessions.updateMetadata({
          lastError: undefined,
          backend: s.engine.diagnostics.backend
        });
        return;
      }

      if (mode === 'agent' && approvalMode !== 'readOnly') {
        const fullStackRelationRefactorFastPath = await tryPrepareFullStackRelationRefactorFastPath({
          request: text,
          workspaceRoot,
          analysis: fullStackRelationRefactorAnalysis,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (fullStackRelationRefactorFastPath) {
          response = fullStackRelationRefactorFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: fullStackRelationRefactorFastPath.complete ? undefined : response,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const fullStackFlowFastPath = await tryPrepareFullStackFlowFastPath({
          request: text,
          workspaceRoot,
          analysis: fullStackFlowAnalysis,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (fullStackFlowFastPath) {
          response = fullStackFlowFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: fullStackFlowFastPath.complete ? undefined : response,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const frontendCrudFastPath = await tryPrepareFrontendCrudFastPath({
          request: text,
          workspaceRoot,
          analysis: frontendCrudAnalysis,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (frontendCrudFastPath) {
          response = frontendCrudFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const backendServiceFastPath = await tryPrepareBackendServiceFastPath({
          request: text,
          workspaceRoot,
          analysis: backendServiceAnalysis,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (backendServiceFastPath) {
          response = backendServiceFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const backendEndpointFastPath = await tryPrepareBackendEndpointFastPath({
          request: text,
          workspaceRoot,
          analysis: backendEndpointAnalysis,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (backendEndpointFastPath) {
          response = backendEndpointFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const javaTestFastPath = await tryPrepareJavaUnitTestFastPath({
          request: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          priority,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (javaTestFastPath) {
          response = javaTestFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const testFastPath = await tryPrepareTestGenerationFastPath({
          request: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          priority,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (testFastPath) {
          response = testFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const adaptiveFastPath = await tryPrepareAdaptivePatternFastPath({
          request: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          priority,
          contextSize: s.engine.diagnostics.contextSize ?? 4_096,
          generate: params => s.engine.generateDirect({ ...params, signal: controller.signal }),
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (adaptiveFastPath) {
          response = adaptiveFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: adaptiveFastPath.complete ? undefined : response,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const documentationFastPath = await tryPrepareDocumentationFastPath({
          request: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          priority,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (documentationFastPath) {
          response = documentationFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const structuralFastPath = await tryPrepareStructuralEditFastPath({
          request: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          priority,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (structuralFastPath) {
          response = structuralFastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }

        const fastPath = await tryPrepareSimpleEditFastPath({
          request: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          priority,
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (fastPath) {
          response = fastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }
      }

      if (!s.engine.isLoaded) {
        response = 'Nenhum modelo está carregado. Os Fast Paths determinísticos foram avaliados, mas esta tarefa ainda precisa do modelo local.';
        await s.view.streamChunk(messageId, response);
        s.sessions.addMessage({ role: 'assistant', text: response });
        s.sessions.updateMetadata({ lastError: response, backend: s.engine.diagnostics.backend });
        return;
      }

      const taskContextEstimate = estimateTaskComplexity({
        request: text,
        estimatedFiles: rootCreationTarget ? 1 : Math.max(1, contextPriority.length),
        fullStack: Boolean(fullStackFlowAnalysis || fullStackRelationRefactorAnalysis),
        multiLayer: Boolean(frontendCrudAnalysis || backendServiceAnalysis || backendEndpointAnalysis),
        createsFiles: genericFileCreationTask && !rootCreationTarget
      });
      await ensureAutomaticContextForTask(s, taskContextEstimate);

      const contextSize = s.engine.diagnostics.contextSize ?? 4096;
      const configuredMaxTokens = vscode.workspace
        .getConfiguration('offgrid')
        .get<number>('maxTokens', 1024);
      const minimumOutputTokens = agentOutputTokenFloor(text, contextPriority);

      if (contextSize < 2_048) {
        throw Object.assign(
          new Error(
            [
              `O Modo Agente requer contexto de pelo menos 2048 tokens; o modelo foi carregado com ${contextSize}.`,
              'Use o contexto automático ou configure offgrid.contextSize como 4096 no modo manual e recarregue o modelo.'
            ].join(' ')
          ),
          { name: 'AgentContextError' }
        );
      }

      // Detecta o tier do modelo antes de montar o system prompt,
      // pois o tier determina qual variante do prompt será usada.
      const activeModelStatus = s.activeModelId
        ? s.catalog.list().find(item => item.id === s.activeModelId)
        : undefined;
      const modelFileSizeBytes = activeModelStatus?.fileSize ?? 0;
      const modelTier = detectModelTier(modelFileSizeBytes);

      const systemPromptStartedAt = Date.now();

      s.logger.debug(
        'agent',
        `[Flow][2/6] Iniciando montagem do prompt de sistema. modelTier=${modelTier}`
      );

      const compactAgentContext = contextSize <= 4_096;
      const baseAgentSystem = await buildAgentSystemPrompt(
        s,
        selectedSchemas,
        mode,
        text,
        modelTier,
        contextPriority,
        compactAgentContext
      );
      // OFFGRID_AGENTS_MD_AGENT: mantém as regras no prompt de sistema, mas
      // limita o volume em fallback 4K para não consumir toda a janela antes
      // mesmo do código de origem e do teste-exemplo.
      const agentInstructionContext = await loadProjectInstructions({
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        targetFiles: rootCreationTarget
          ? [rootCreationTarget]
          : s.contextManager.priority(text),
        ...(compactAgentContext
          ? { maxFiles: 3, maxCharsPerFile: 1_000, maxTotalChars: 1_400 }
          : {})
      });
      if (agentInstructionContext.files.length) {
        s.logger.debug('agent', `[AGENTS.md] Agente: ${agentInstructionContext.files.map(file => file.filePath).join(' → ')}`);
      }
      const agentSystem = [baseAgentSystem, agentInstructionContext.text]
        .filter(Boolean)
        .join('\n\n');

      s.logger.debug(
        'agent',
        `[Flow][2/6] Prompt de sistema concluído em ${Date.now() - systemPromptStartedAt} ms; caracteres=${agentSystem.length}.`
      );

      let creationTargetEnvelope = creationTargetInstruction(
        rootCreationTarget,
        javaTestCreationTarget,
        javaUnitTestTask
      );
      let taskEnvelope = [
        creationTargetEnvelope,
        `<tarefa_usuario>\n${text}\n</tarefa_usuario>`
      ].filter(Boolean).join('\n\n');
      const budget = calculateAgentContextBudget({
        contextSize,
        configuredMaxTokens,
        systemPromptChars: agentSystem.length,
        taskChars: taskEnvelope.length,
        modelFileSizeBytes,
        minimumOutputTokens,
        compactCodeInput: compactAgentContext || javaUnitTestTask
      });
      const contextStartedAt = Date.now();
      const effectiveMaxFiles = taskContextEstimate.complexity === 'simple'
        ? javaUnitTestTask
          ? Math.min(2, budget.maxFiles)
          : genericFileCreationTask && !rootCreationTarget
            ? Math.min(3, budget.maxFiles)
            : 1
        : budget.maxFiles;

      s.logger.info(
        'agent',
        [
          '[Flow][3/6] Iniciando análise automática do workspace.',
          `prioridade=${contextPriority.join(' → ') || 'nenhuma'}`,
          `modelTier=${budget.modelTier}`,
          `limiteArquivos=${effectiveMaxFiles}`,
          `limiteTotal=${budget.workspaceChars}`,
          `saídaReservada=${budget.maxOutputTokens} tokens`,
          `mínimoTarefa=${minimumOutputTokens || 'padrão'} tokens`,
          `margem=${budget.safetyTokens} tokens`,
          `continuaçãoReservada=${budget.continuationTokens} tokens`
        ].join(' ')
      );

      let workspaceContext = await buildAgentWorkspaceContext({
        workspaceRoot,
        priority: contextPriority,
        request: text,
        maxFiles: effectiveMaxFiles,
        maxCharsPerFile: budget.maxCharsPerFile,
        maxTotalChars: budget.workspaceChars,
        includeTestRelated: genericFileCreationTask && !rootCreationTarget
      });

      // Depois que as referências Java foram realmente resolvidas, conseguimos
      // derivar "mesmo pacote" com segurança a partir do teste-exemplo citado.
      if (!javaTestCreationTarget && javaUnitTestTask) {
        javaTestCreationTarget = javaUnitTestCreationTarget(
          text,
          contextPriority,
          workspaceContext.files.map(file => file.filePath)
        );
        if (javaTestCreationTarget) {
          creationTargetEnvelope = creationTargetInstruction(
            rootCreationTarget,
            javaTestCreationTarget,
            javaUnitTestTask
          );
          taskEnvelope = [
            creationTargetEnvelope,
            `<tarefa_usuario>\n${text}\n</tarefa_usuario>`
          ].filter(Boolean).join('\n\n');
        }
      }

      const contextCharacters = workspaceContext.files.reduce(
        (total, file) => total + file.content.length,
        0
      );

      s.logger.info(
        'agent',
        [
          `[Flow][3/6] Contexto concluído em ${Date.now() - contextStartedAt} ms.`,
          `arquivos=${workspaceContext.files.length}`,
          `caracteres=${contextCharacters}`
        ].join(' ')
      );
      let initialPrompt = [
        workspaceContext.text,
        taskEnvelope
      ].filter(Boolean).join('\n\n');
      s.logger.debug(
        'agent',
        [
          '[Flow][4/6] Prompt inicial concluído.',
          `caracteres=${initialPrompt.length}`,
          `arquivosContexto=${workspaceContext.files.length}`
        ].join(' ')
      );
      if (workspaceContext.files.length) {
        s.logger.debug('agent', `[Context] Arquivos carregados automaticamente: ${workspaceContext.files.map(file => file.filePath).join(', ')}`);
      }
      const agentStartedAt = Date.now();
      const configuredAgentSteps = vscode.workspace
        .getConfiguration('offgrid')
        .get<number>('maxAgentSteps', 10);
      const effectiveAgentSteps = genericFileCreationTask
        ? Math.min(configuredAgentSteps, 4)
        : configuredAgentSteps;
      s.logger.info(
        'agent',
        `[Flow][5/6] Iniciando AgentLoop; máximoEtapas=${effectiveAgentSteps}.`
      );

      let agentWriteExecutions = 0;
      const executeAgentTool = async (call: ToolCall) => {
        const tool = selectedSchemas.find(schema => schema.name === call.name);
        if (!tool) {
          const validNames = selectedSchemas.map(schema => schema.name).join(', ');
          return Promise.resolve({
            callId: call.id,
            name: call.name,
            ok: false,
            content: null,
            error: `Ferramenta "${call.name}" não existe. Ferramentas disponíveis no modo ${mode}: ${validNames}.`,
            durationMs: 0
          });
        }
        if (call.name === 'create_file' && rootCreationTarget) {
          const proposedPath = typeof call.arguments.filePath === 'string'
            ? call.arguments.filePath.replace(/\\/g, '/')
            : '';
          if (proposedPath !== rootCreationTarget) {
            s.logger.info('agent', `[Tool] Destino de create_file normalizado para a raiz: ${rootCreationTarget}.`);
          }
          call.arguments.filePath = rootCreationTarget;
        } else if (call.name === 'create_file' && javaTestCreationTarget) {
          const proposedPath = typeof call.arguments.filePath === 'string'
            ? call.arguments.filePath.replace(/\\/g, '/')
            : '';
          if (proposedPath !== javaTestCreationTarget) {
            s.logger.info('agent', `[Tool] Destino do teste Java normalizado: ${javaTestCreationTarget}.`);
          }
          call.arguments.filePath = javaTestCreationTarget;
        }
        if (call.name === 'create_file') {
          const contentIssue = generatedFileContentIssue(
            call.arguments.filePath,
            call.arguments.content,
            { request: text, sources: workspaceContext.files }
          );
          if (contentIssue) {
            s.logger.warn('agent', `[Tool] create_file rejeitado: ${contentIssue}`);
            return Promise.resolve({
              callId: call.id,
              name: call.name,
              ok: false,
              content: null,
              error: contentIssue,
              durationMs: 0
            });
          }
        }
        const validationError = validateToolArguments(tool, call.arguments);
        if (validationError) {
          s.logger.warn('agent', `[Tool] Argumentos rejeitados para ${call.name}: ${validationError}`);
          return Promise.resolve({ callId: call.id, name: call.name, ok: false, content: null, error: validationError, durationMs: 0 });
        }
        const result = await s.tools.execute(call);
        // Recuperação de contexto pode repetir com segurança depois de
        // ferramentas somente de leitura. Bloqueamos retry apenas quando uma
        // escrita realmente foi preparada/aplicada com sucesso.
        if (result.ok && tool.write) agentWriteExecutions += 1;
        return result;
      };

      const runAgentOnce = () => s.engine.runAgent({
        initialPrompt,
        taskReminder: taskEnvelope,
        systemPrompt: agentSystem,
        maxSteps: effectiveAgentSteps,
        diagnosticMode: vscode.workspace.getConfiguration('offgrid').get<boolean>('diagnosticMode', false),
        maxTokens: budget.maxOutputTokens,
        signal: controller.signal,
        executeTool: executeAgentTool,
        continuationPromptMaxChars: Math.max(900, budget.continuationTokens * 2),
        requiredWrite: genericFileCreationTask,
        expectedCreateFilePath: rootCreationTarget ?? javaTestCreationTarget
      });

      try {
        response = await runAgentOnce();
      } catch (error) {
        // Última barreira para fallback 4K: se a estimativa do tokenizer real
        // ainda for mais densa que nosso orçamento e nenhuma escrita tiver sido
        // preparada/aplicada, compacte origem + referência e tente uma única vez.
        // Leituras são idempotentes; nunca repetimos depois de side effects de escrita.
        if (
          contextSize <= 4_096
          && agentWriteExecutions === 0
          && isAgentContextWindowError(error)
          && workspaceContext.files.length > 0
        ) {
          s.logger.warn(
            'agent',
            '[Context] Prompt ainda excedeu 4K; aplicando compactação de emergência e repetindo uma única vez.'
          );
          workspaceContext = await buildAgentWorkspaceContext({
            workspaceRoot,
            priority: contextPriority,
            request: text,
            maxFiles: javaUnitTestTask ? 2 : Math.min(2, effectiveMaxFiles),
            maxCharsPerFile: 900,
            maxTotalChars: javaUnitTestTask ? 1_800 : 1_500,
            includeTestRelated: genericFileCreationTask && !rootCreationTarget
          });
          if (!javaTestCreationTarget && javaUnitTestTask) {
            javaTestCreationTarget = javaUnitTestCreationTarget(
              text,
              contextPriority,
              workspaceContext.files.map(file => file.filePath)
            );
          }
          creationTargetEnvelope = creationTargetInstruction(
            rootCreationTarget,
            javaTestCreationTarget,
            javaUnitTestTask
          );
          taskEnvelope = [
            creationTargetEnvelope,
            `<tarefa_usuario>\n${text}\n</tarefa_usuario>`
          ].filter(Boolean).join('\n\n');
          initialPrompt = [workspaceContext.text, taskEnvelope].filter(Boolean).join('\n\n');
          agentWriteExecutions = 0;
          response = await runAgentOnce();
        } else {
          throw error;
        }
      }
      s.logger.info(
        'agent',
        [
          `[Flow][5/6] AgentLoop concluído em ${Date.now() - agentStartedAt} ms.`,
          `resposta=${response.length} caracteres`,
          `revisãoPendente=${Boolean(s.tools.pendingReview)}`,
          `arquivosPropostos=${s.tools.pendingReview?.files.length ?? 0}`
        ].join(' ')
      );
      await s.view.streamChunk(messageId, response);
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
    s.controller = undefined;
    try { await s.view.streamEnd(messageId); } catch { /* webview pode ter sido destruída antes do término */ }
    await refreshUi(s, false);
  }
}

async function mockSubmit(s: Services, text: string, mode: ConversationMode): Promise<void> {
  await delay(350);
  let response = `Modo visual simulado · ${mode}. Pedido recebido: ${text}`;
  if (mode === 'agent') response = 'Simulação: ferramenta list_files executada; alteração preparada para revisão sem tocar no workspace.';
  s.sessions.addMessage({ role: 'assistant', text: response });
  await refreshUi(s);
}

interface ModelLoadRequest {
  contextOverride?: number;
  taskEstimate?: ContextTaskEstimate;
  reason?: string;
  throwOnError?: boolean;
}

async function loadModelById(
  s: Services,
  modelId: string,
  force: boolean,
  request: ModelLoadRequest = {}
): Promise<boolean> {
  let model: ModelDefinition;
  try {
    model = s.catalog.get(modelId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.logger.error('model', message, error);
    vscode.window.showErrorMessage(message);
    if (request.throwOnError) throw error;
    return false;
  }

  let status = s.catalog.list(modelPathForActive(s), s.engine.diagnostics.modelPath, s.modelErrors)
    .find(item => item.id === modelId);
  if (!status) {
    const message = `Modelo não encontrado no catálogo: ${modelId}`;
    s.logger.error('model', message);
    vscode.window.showErrorMessage(message);
    if (request.throwOnError) throw new Error(message);
    return false;
  }

  if (!fs.existsSync(status.filePath)) {
    const choice = await vscode.window.showInformationMessage(
      `${model.displayName} não está instalado (${model.approxSize}).`,
      { modal: true },
      'Baixar e carregar'
    );
    if (choice !== 'Baixar e carregar') {
      await refreshUi(s);
      return false;
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
      if (request.throwOnError) throw error;
      return false;
    }
  }

  const sameModelLoaded = s.engine.isLoaded
    && path.resolve(s.engine.diagnostics.modelPath) === path.resolve(status.filePath);
  if (!force && sameModelLoaded && request.contextOverride === undefined) {
    await refreshUi(s);
    return true;
  }

  const previous = s.activeModelId;
  s.activeModelId = modelId;
  s.pendingLoadModelId = modelId;
  s.modelErrors[modelId] = '';
  await s.context.globalState.update('offgrid.activeModelId', modelId);
  await refreshUi(s, true);

  try {
    const cfg = vscode.workspace.getConfiguration('offgrid');
    const contextPlan = await createContextPlan(s, model, status, request.taskEstimate);
    const selectedContext = request.contextOverride ?? contextPlan.contextSize;
    const minimumContext = model.contextProfile?.minimum ?? 4_096;
    const candidates = contextPlan.mode === 'manual'
      ? [selectedContext]
      : request.contextOverride === undefined
        ? contextPlan.fallbackContexts
        : contextFallbacks(selectedContext, minimumContext);

    s.logger.info('model', formatContextPlan(
      { ...contextPlan, contextSize: selectedContext, fallbackContexts: candidates },
      model.id,
      sameModelLoaded ? s.engine.diagnostics.contextSize : null
    ));
    if (request.reason) s.logger.info('model', `[ContextPlanner] motivo=${request.reason}`);

    const baseOptions: Omit<EngineLoadOptions, 'contextSize'> = {
      modelPath: status.filePath,
      gpu: parseBackend(cfg.get<unknown>('gpu', 'auto')),
      gpuLayers: parseGpuLayers(cfg.get<unknown>('gpuLayers', 'auto')),
      maxTokens: cfg.get<number>('maxTokens', 1024),
      temperature: cfg.get<number>('temperature', 0.2),
      fallbackToCpu: cfg.get<boolean>('fallbackToCpu', true),
      adaptiveGpu: cfg.get<boolean>('adaptiveGpu', true),
      promptMode: model.promptMode ?? 'default'
    };
    const prompt = `${await readResource(s.context.extensionUri.fsPath, 'resources/system-prompt.md')}\n\n${buildTemporalContext()}`;

    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      const contextSize = candidates[index]!;
      const options: EngineLoadOptions = { ...baseOptions, contextSize };
      try {
        s.logger.info(
          'model',
          `Carregando ${model.displayName}. Caminho=${status.filePath}; backend=${options.gpu}; contexto=${contextSize}; promptMode=${options.promptMode}.`
        );
        await s.engine.load(options, prompt);
        if (index > 0) {
          s.logger.warn('model', `[ContextPlanner] Carga concluída com fallback de contexto=${contextSize}.`);
        }
        vscode.window.setStatusBarMessage(
          `${model.displayName} carregado em ${s.engine.diagnostics.backend.toUpperCase()} · contexto ${contextSize}.`,
          2000);
        return true;
      } catch (error) {
        lastError = error;
        const next = candidates[index + 1];
        if (next === undefined || !isContextCapacityError(error)) throw error;
        s.logger.warn(
          'model',
          `[ContextPlanner] Falha de memória com contexto=${contextSize}; tentando ${next}.`,
          error
        );
      }
    }
    throw lastError ?? new Error('Não foi possível carregar o modelo.');
  } catch (error) {
    const message = friendlyModelError(error, model.displayName);
    s.modelErrors[modelId] = message;

    const restoredModelId = s.engine.isLoaded ? previous : undefined;
    s.activeModelId = restoredModelId;
    await s.context.globalState.update('offgrid.activeModelId', restoredModelId);
    s.logger.error('model', message, error);
    if (request.throwOnError) throw error;
    const action = await vscode.window.showErrorMessage(message, 'Abrir Output', 'Abrir logs', 'Abrir pasta dos modelos');
    if (action === 'Abrir Output') s.output.show(true);
    else if (action === 'Abrir logs') await openOffgridFolder(s, 'logs');
    else if (action === 'Abrir pasta dos modelos') await openOffgridFolder(s, 'models');
    return false;
  } finally {
    s.pendingLoadModelId = undefined;
    await refreshUi(s);
  }
}

async function createContextPlan(
  s: Services,
  model: ModelDefinition,
  status: ModelStatus,
  task?: ContextTaskEstimate
): Promise<ContextPlan> {
  const cfg = vscode.workspace.getConfiguration('offgrid');
  const mode = parseContextMode(cfg.get<unknown>('contextMode', 'automatic'));
  const resources = await s.engine.refreshResources(true, true);

  let reclaimableBytes = 0;
  if (s.engine.isLoaded && s.engine.diagnostics.contextSize) {
    const loadedStatus = s.catalog.list('', s.engine.diagnostics.modelPath, s.modelErrors)
      .find(item => item.state === 'loaded');
    if (loadedStatus) {
      reclaimableBytes = estimateRequiredBytes(
        loadedStatus,
        loadedStatus.fileSize,
        s.engine.diagnostics.contextSize
      );
    }
  }

  return planContext({
    mode,
    manualContextSize: cfg.get<number>('contextSize', 4_096),
    model,
    modelFileSizeBytes: status.fileSize,
    resources,
    currentContextSize: s.engine.diagnostics.contextSize,
    reclaimableBytes,
    task
  });
}

async function ensureAutomaticContextForTask(
  s: Services,
  task: ContextTaskEstimate
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('offgrid');
  if (parseContextMode(cfg.get<unknown>('contextMode', 'automatic')) !== 'automatic') return;
  if (!s.activeModelId || !s.engine.isLoaded) return;

  const model = s.catalog.get(s.activeModelId);
  const status = s.catalog.list(modelPathForActive(s), s.engine.diagnostics.modelPath, s.modelErrors)
    .find(item => item.id === s.activeModelId);
  if (!status) return;

  const plan = await createContextPlan(s, model, status, task);
  s.logger.info('agent', formatContextPlan(plan, model.id, s.engine.diagnostics.contextSize));
  if (!shouldExpandContext(s.engine.diagnostics.contextSize, plan)) return;

  s.logger.info(
    'agent',
    `[ContextPlanner] Ampliando contexto antes da geração: ${s.engine.diagnostics.contextSize} → ${plan.contextSize}.`
  );
  const loaded = await loadModelById(s, model.id, true, {
    contextOverride: plan.contextSize,
    taskEstimate: task,
    reason: `tarefa ${task.complexity} com ${task.estimatedFiles} arquivos estimados`,
    throwOnError: true
  });
  if (!loaded || !s.engine.isLoaded) {
    throw new Error('O contexto automático não pôde ser preparado para esta tarefa.');
  }
  s.sessions.updateMetadata({
    modelId: model.id,
    backend: s.engine.diagnostics.backend,
    contextSize: s.engine.diagnostics.contextSize ?? undefined
  });
}

function parseContextMode(value: unknown): ContextMode {
  return value === 'manual' ? 'manual' : 'automatic';
}

function isAgentContextWindowError(error: unknown): boolean {
  const candidate = error as { name?: unknown; message?: unknown };
  if (candidate?.name === 'ContextWindowError') return true;
  const text = typeof candidate?.message === 'string' ? candidate.message : String(error);
  return /(?:prompt|histórico).*excede.*janela de contexto|entradaEstimada=/i.test(text);
}

function isContextCapacityError(error: unknown): boolean {
  if (isDeviceMemoryError(error)) return true;
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return [
    'failed to allocate', 'cannot allocate', 'context', 'kv cache',
    'encerrou antes de ficar pronto', 'out of memory', 'not enough memory'
  ].some(fragment => text.toLowerCase().includes(fragment));
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
  // IMPORTANTE: não limpar quando há uma carga em andamento (loading ou isBusy),
  // pois loadModelById define activeModelId ANTES de iniciar o load — limpar
  // nesse intervalo apagaria a seleção recém-feita e a combo ficaria vazia
  // mesmo com o modelo carregado com sucesso.
  const loadInProgress = engine.loading || s.engine.isBusy || Boolean(s.pendingLoadModelId);
  if (!mock && engine.engineState === 'unloaded' && s.activeModelId && !loadInProgress) {
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
      files: [{ filePath: 'src/exemplo.ts', kind: 'modified' }]
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
    autonomy: s.autonomy,
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
  if (event.affectsConfiguration('offgrid.logLevel')) s.logger.setLevel(vscode.workspace.getConfiguration('offgrid').get<LogLevel>('logLevel', 'info'));
  if (event.affectsConfiguration('offgrid.diagnosticsPanel')) s.diagnosticsPanel = vscode.workspace.getConfiguration('offgrid').get<DiagnosticsPanelMode>('diagnosticsPanel', 'compact');
  if (event.affectsConfiguration('offgrid.agentAutonomy')) s.autonomy = vscode.workspace.getConfiguration('offgrid').get<AgentAutonomy>('agentAutonomy', 'assisted');
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
  // OFFGRID_AGENTS_MD_CHAT: regras permanentes do projeto.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const guideTargets = s.contextManager.priority(text);
  const projectInstructions = await loadProjectInstructions({
    workspaceRoot,
    targetFiles: guideTargets
  });
  if (projectInstructions.files.length) {
    s.logger.debug('agent', `[AGENTS.md] Chat: ${projectInstructions.files.map(file => file.filePath).join(' → ')}`);
  }
  const question = `<pergunta>\n${text}\n</pergunta>`;
  if (!vscode.workspace.getConfiguration('offgrid').get<boolean>('includeWorkspaceContext', true)) {
    return [temporal, projectInstructions.text, question].filter(Boolean).join('\n\n');
  }

  const files = s.contextManager.priority(text).slice(0, 5);
  const snippets: string[] = projectInstructions.text ? [projectInstructions.text] : [];
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

function creationTargetInstruction(
  rootCreationTarget: string | undefined,
  javaTestCreationTarget: string | undefined,
  javaUnitTestTask: boolean
): string {
  if (rootCreationTarget) {
    return [
      '<destino_criacao_obrigatorio>',
      `Crie exatamente o arquivo "${rootCreationTarget}" na raiz do workspace.`,
      'Não escolha subpasta e não use o arquivo ativo como destino ou contexto.',
      '</destino_criacao_obrigatorio>'
    ].join('\n');
  }
  if (javaTestCreationTarget) {
    return [
      '<destino_criacao_obrigatorio>',
      `O teste Java deve ser criado exatamente em "${javaTestCreationTarget}".`,
      'A classe de origem e o teste-exemplo já estão no contexto; siga o padrão existente.',
      'Não chame get_active_file para redescobrir a origem.',
      '</destino_criacao_obrigatorio>'
    ].join('\n');
  }
  if (javaUnitTestTask) {
    return [
      '<destino_criacao_obrigatorio>',
      'Crie o novo teste Java no mesmo pacote do teste-exemplo citado pelo usuário.',
      'A classe de origem já está no contexto; não chame get_active_file.',
      '</destino_criacao_obrigatorio>'
    ].join('\n');
  }
  return '';
}

async function buildAgentSystemPrompt(
  s: Services,
  schemas: ReturnType<typeof schemasForMode>,
  mode: ConversationMode,
  prompt: string,
  modelTier: 'small' | 'medium' | 'large' = 'large',
  priorityOverride?: string[],
  compact = false
): Promise<string> {
  const priority = priorityOverride ?? s.contextManager.priority(prompt);
  const taskGuidance = fullStackFlowTaskGuidance(prompt) ?? frontendCrudTaskGuidance(prompt) ?? serviceTaskGuidance(prompt) ?? endpointTaskGuidance(prompt);
  const javaTestContextReady = isJavaUnitTestCreationTask(prompt, priority) && priority.length > 0;
  const readBeforeWriteGuidance = javaTestContextReady
    ? 'A classe-alvo e as referências prioritárias já estão no contexto. Não releia arquivos já fornecidos; use read_file apenas se faltar informação indispensável.'
    : 'Leia antes de editar.';
  const toolSignatures = schemas.map(compactToolSignature);
  const coverageGuidance = schemas.some(tool => tool.name === 'run_java_coverage')
    ? 'Para cobertura Java existente, use run_java_coverage(filePath) quando a tarefa pedir JaCoCo/cobertura. A ferramenta executa o build já configurado, pede confirmação e retorna somente métodos sem cobertura ou parcialmente cobertos; nunca altere pom.xml/build.gradle para adicionar JaCoCo sem pedido explícito.'
    : undefined;

  // Modelos small (0.5B–1B) recebem prompt ultra-compacto: sem prosa,
  // só o essencial para o modelo entender o protocolo de ferramentas.
  // Modelos medium/large recebem o prompt completo com contexto rico.
  if (modelTier === 'small' || compact) {
    return [
      compact
        ? 'Agente Offgrid em contexto compacto. Use o contexto recebido e ferramentas; não invente caminhos ou conteúdo.'
        : 'Agente Offgrid. Use ferramentas; não invente caminhos ou conteúdo.',
      'Ferramenta: responda apenas JSON {"name":"nome","arguments":{...}}; sem Markdown.',
      'Só existem as ferramentas listadas abaixo. Nunca invente nomes de ferramenta.',
      `${readBeforeWriteGuidance} Finalize com apply_changes; nunca grave direto.`,
      coverageGuidance,
      'Ao criar arquivos, gere conteúdo completo; nunca use TODO, FIXME ou comentários de implementação pendente.',
      'Em create_file, content deve ser uma string JSON válida; escape quebras de linha e nunca use template literals com crases.',
      taskGuidance,
      ...toolSignatures
    ].join('\n');
  }

  const base = await readResource(s.context.extensionUri.fsPath, 'resources/agent-system-prompt.md');
  return [
    base,
    buildTemporalContext(),
    `Modo=${mode}; autonomia=${s.autonomy}.`,
    `Ordem de contexto: ${priority.join(' → ') || 'nenhum arquivo explícito'}.`,
    taskGuidance,
    'Para chamar ferramenta, responda somente JSON: {"name":"nome","arguments":{...}}. Sem Markdown ou explicação.',
    `${readBeforeWriteGuidance} Altere só o necessário; finalize com apply_changes; nunca grave direto.`,
    coverageGuidance,
    'Ao criar arquivos, gere conteúdo completo; nunca use TODO, FIXME ou comentários de implementação pendente.',
      'Em create_file, content deve ser uma string JSON válida; escape quebras de linha e nunca use template literals com crases.',
    s.autonomy === 'assisted'
      ? 'No modo Assistido, criação e exclusão exigem confirmação intermediária.'
      : 'No modo Autônomo, criação e exclusão continuam sujeitas à revisão final.',
    'Só existem as ferramentas listadas abaixo; nunca invente nomes de ferramenta.',
    ...toolSignatures
  ].join('\n');
}

function compactToolSignature(
  tool: ReturnType<typeof schemasForMode>[number]
): string {
  const inputSchema = tool.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(inputSchema.required ?? []);
  const argumentsText = Object.entries(inputSchema.properties ?? {})
    .map(([name, definition]) => {
      const property = definition as { type?: unknown };
      const type = typeof property.type === 'string'
        ? property.type.charAt(0)
        : '?';
      return `${name}${required.has(name) ? '' : '?'}:${type}`;
    })
    .join(',');

  return `${tool.name}(${argumentsText})`;
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
function shortModelName(file: string): string {
  const name = path.basename(file, '.gguf');
  if (name.toLowerCase() === 'qwen3-4b-q4_k_m') return 'Qwen3 4B';
  return name.replace('qwen2.5-coder-', 'Qwen ').replace('-instruct-q4_k_m', '');
}
function friendlyModelError(error: unknown, model: string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/llama-server|binário.*não encontrado|cannot find module/i.test(text)) return `Não foi possível iniciar ${model}: o servidor local não foi encontrado ou não pôde ser carregado. Consulte os logs.`;
  if (/memory|allocate|vulkan|outofdevice/i.test(text)) return `Não foi possível carregar ${model}. Causa provável: memória GPU/RAM insuficiente. O Offgrid tentou perfis reduzidos e CPU. Consulte os logs.`;
  return `Não foi possível carregar ${model}: ${text}`;
}
function readResource(root: string, relative: string): Promise<string> { return fsp.readFile(path.join(root, relative), 'utf8'); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
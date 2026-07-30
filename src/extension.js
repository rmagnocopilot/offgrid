'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { EngineProcessClient } = require('./engine-client');
const { isDeviceMemoryError } = require('./llama-engine');
const { summarizeResources, bytesToGb } = require('./resource-monitor');
const { ChatViewProvider } = require('./chat-view');
const { ModelInstaller } = require('./model-installer');
const { WorkspaceAgent } = require('./workspace-agent');
const { ChangePreviewProvider } = require('./change-preview');
const { SessionStore } = require('./session-store');
const { loadCatalog, repositoryReleaseBase, repositoryCoordinates } = require('./model-catalog');
const { FileLogger } = require('./file-logger');
const { extractExplicitFileReferences, basenameReference } = require('./agent-context');

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const output = vscode.window.createOutputChannel('Offgrid');
  const initialConfiguration = vscode.workspace.getConfiguration('offgrid');
  const fileLogger = new FileLogger({
    storagePath: context.globalStorageUri.fsPath,
    outputChannel: output,
    level: initialConfiguration.get('logLevel', 'debug'),
    diagnosticMode: initialConfiguration.get('diagnosticMode', false)
  });
  const writeRoutedLog = (category, message, fallbackLevel = 'debug') => {
    const text = String(message);
    const level = /\[(?:ERRO|ERROR)\]/i.test(text) ? 'error'
      : /\[WARN\]/i.test(text) ? 'warn'
        : /\[TRACE\]/i.test(text) ? 'trace'
          : fallbackLevel;
    fileLogger.log(category, level, text);
  };
  const log = message => writeRoutedLog('offgrid', message, 'info');
  const logAgent = message => {
    const text = String(message);
    writeRoutedLog('agent', text.startsWith('[Agent]') ? text : `[Agent] ${text}`, 'debug');
  };
  const logModel = message => {
    const text = String(message);
    if (text.includes('[Agent]')) writeRoutedLog('agent', text, 'debug');
    else if (text.includes('[Memory]') || text.includes('[Diagnostics]')) writeRoutedLog('diagnostics', text, 'debug');
    else writeRoutedLog('model', text, 'debug');
  };
  const engine = new EngineProcessClient({
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath,
    logger: logModel
  });
  const chat = new ChatViewProvider(context.extensionUri);
  const preview = new ChangePreviewProvider();
  const catalog = loadCatalog(context.extensionPath);
  const systemPrompt = fs.readFileSync(path.join(context.extensionPath, 'resources', 'system-prompt.md'), 'utf8');
  const agentSystemPrompt = fs.readFileSync(path.join(context.extensionPath, 'resources', 'agent-system-prompt.md'), 'utf8');
  let chatState = 'Aguardando';
  let agentState = 'Aguardando';
  const agent = new WorkspaceAgent(context, activity => {
    agentState = activity;
    logAgent(activity);
    refreshDashboard();
  }, message => logAgent(message));
  const sessions = new SessionStore(context.globalStorageUri.fsPath, log);
  await sessions.init();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'offgrid.manageModels';
  statusBar.text = '$(plug) Offgrid';
  statusBar.show();

  if (initialConfiguration.get('diagnosticMode', false)) {
    fileLogger.warn('offgrid', '[Diagnostics] Modo diagnóstico ativo. Logs podem conter caminhos, prévias de prompts e resultados de ferramentas.');
    const noticeKey = `offgrid.diagnosticNotice.${context.extension.packageJSON.version || 'current'}`;
    if (!context.globalState.get(noticeKey, false)) {
      vscode.window.showWarningMessage('Offgrid: o modo diagnóstico está ativo e pode registrar caminhos e trechos de código nos logs locais.');
      await context.globalState.update(noticeKey, true);
    }
  }

  let abortController = null;
  let currentInstaller = null;
  let pinnedUri = null;
  let pinLocked = false;
  let suppressReload = false;
  let reloadTimer = null;
  let contextEntries = sanitizeContextEntries(context.workspaceState.get('offgrid.contextEntries', []));

  const config = () => vscode.workspace.getConfiguration('offgrid');
  const options = () => ({
    modelPath: config().get('modelPath', ''),
    gpu: config().get('gpu', 'auto'),
    gpuLayers: config().get('gpuLayers', 'auto'),
    fallbackToCpu: config().get('fallbackToCpu', true),
    adaptiveGpu: config().get('adaptiveGpu', true),
    contextSize: config().get('contextSize', 4096),
    maxTokens: config().get('maxTokens', 1024),
    temperature: config().get('temperature', 0.2),
    agentMaxTokens: config().get('agentMaxTokens', 4096),
    maxAgentSteps: config().get('maxAgentSteps', 10),
    diagnosticMode: config().get('diagnosticMode', false)
  });
  let resourceTimer = null;
  let resourceRefreshRunning = false;
  const modelsDir = () => path.join(context.globalStorageUri.fsPath, 'models');
  const modelFile = model => path.join(modelsDir(), model.fileName);
  const relative = uri => uri ? vscode.workspace.asRelativePath(uri, true) : '';
  const usableContext = uri => Boolean(uri && uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri));

  function setPinned(uri, locked = pinLocked) {
    pinnedUri = usableContext(uri) ? uri : null;
    pinLocked = Boolean(locked && pinnedUri);
    chat.setPinnedFile(relative(pinnedUri), pinLocked);
    refreshContext();
  }
  function followEditor(editor = vscode.window.activeTextEditor) {
    if (!pinLocked && editor && usableContext(editor.document.uri)) setPinned(editor.document.uri, false);
  }
  function catalogForPath(filePath) {
    if (!filePath) return null;
    return catalog.models.find(model => path.resolve(modelFile(model)) === path.resolve(filePath)) || null;
  }
  function stateFor(model) {
    const target = modelFile(model);
    const configured = options().modelPath;
    return {
      target,
      installed: fs.existsSync(target),
      active: Boolean(configured && path.resolve(configured) === path.resolve(target)),
      loaded: Boolean(engine.isLoaded && engine.loadedModelPath && path.resolve(engine.loadedModelPath) === path.resolve(target))
    };
  }
  function refreshContext() {
    chat.setContextState({
      pinnedFile: relative(pinnedUri),
      pinnedLocked: pinLocked,
      entries: contextEntries.map(entry => ({ type: entry.type, label: entry.label }))
    });
  }
  function refreshDashboard() {
    const current = options();
    const loaded = catalogForPath(engine.loadedModelPath);
    chat.setModelState({
      models: catalog.models.map(model => ({
        id: model.id,
        name: model.displayName,
        approxSize: model.approxSize,
        ...stateFor(model)
      })),
      activeModelId: catalogForPath(current.modelPath)?.id || '',
      loadedModelId: loaded?.id || '',
      loadedModelName: loaded?.displayName || (engine.loadedModelPath ? path.basename(engine.loadedModelPath, '.gguf') : ''),
      backend: engine.isLoaded ? String(engine.backend || 'cpu').toUpperCase() : '—',
      contextSize: current.contextSize,
      gpuLayers: current.gpuLayers,
      chatState: engine.isLoaded ? chatState : (engine.isLoading ? 'Carregando' : 'Indisponível'),
      agentState: engine.isLoaded ? agentState : (engine.isLoading ? 'Aguardando modelo' : 'Indisponível'),
      engineState: engine.diagnostics.engineState || (engine.isLoaded ? 'ready' : 'notStarted'),
      engineStateLabel: engineStateLabel(engine.diagnostics.engineState || (engine.isLoaded ? 'ready' : 'notStarted')),
      loading: engine.isLoading,
      resources: summarizeResources(engine.diagnostics.resourceSnapshot),
      workerPid: engine.diagnostics.workerPid || null,
      selectedProfile: engine.diagnostics.selectedProfile || null,
      effectiveGpuLayers: engine.diagnostics.gpuLayers ?? current.gpuLayers,
      diagnosticsPanel: config().get('diagnosticsPanel', 'compact'),
      lastError: engine.diagnostics.lastError || ''
    });
    chat.setSessions(sessions.snapshot());
  }

  async function refreshResources(force = false) {
    if (!config().get('resourceMonitoring', true) || resourceRefreshRunning) return;
    resourceRefreshRunning = true;
    try {
      await engine.refreshDiagnostics(force);
      refreshDashboard();
    } catch (error) {
      log(`Falha ao atualizar recursos: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      resourceRefreshRunning = false;
    }
  }

  function startResourceTimer() {
    clearInterval(resourceTimer);
    if (!config().get('resourceMonitoring', true)) return;
    const seconds = Math.max(5, Number(config().get('resourceRefreshSeconds', 15)) || 15);
    resourceTimer = setInterval(() => refreshResources(false), seconds * 1000);
    resourceTimer.unref?.();
  }

  async function setModelPath(filePath) {
    suppressReload = true;
    try { await config().update('modelPath', filePath, vscode.ConfigurationTarget.Global); }
    finally { suppressReload = false; }
  }

  async function loadConfiguredModel(showErrors = true) {
    const current = options();
    if (!current.modelPath) {
      chatState = 'Sem modelo configurado';
      statusBar.text = '$(plug) Offgrid';
      refreshDashboard();
      return false;
    }
    const name = path.basename(current.modelPath, '.gguf');
    chatState = `Carregando ${name}`;
    statusBar.text = `$(loading~spin) ${name}`;
    refreshDashboard();
    log(`Carregando ${current.modelPath}; gpu=${current.gpu}; gpuLayers=${current.gpuLayers}; contexto=${current.contextSize}`);
    try {
      const diag = await engine.load(current, systemPrompt);
      const backend = String(diag.backend || 'cpu').toUpperCase();
      chatState = 'Pronto';
      agentState = 'Pronto';
      statusBar.text = `$(plug) ${name} [${backend}]`;
      await context.globalState.update('offgrid.lastFunctionalModelPath', current.modelPath);
      await sessions.updateMetadata({
        model: name,
        backend,
        contextSize: current.contextSize,
        lastError: '',
        contextFiles: [relative(pinnedUri), ...contextEntries.map(entry => entry.label)].filter(Boolean)
      });
      if (diag.lastFallback) {
        const from = typeof diag.lastFallback.from === 'object'
          ? `${diag.lastFallback.from.gpu}/${diag.lastFallback.from.gpuLayers}`
          : String(diag.lastFallback.from);
        const to = typeof diag.lastFallback.to === 'object'
          ? `${diag.lastFallback.to.gpu}/${diag.lastFallback.to.gpuLayers}`
          : String(diag.lastFallback.to || 'CPU');
        log(`Fallback ${from} → ${to}: ${diag.lastFallback.reason}`);
        vscode.window.showWarningMessage(`Offgrid ajustou o carregamento de ${name} para ${to} por falta de memória na tentativa anterior.`);
      }
      await refreshResources(true);
      const summary = summarizeResources(engine.diagnostics.resourceSnapshot);
      if (summary.lowMemory) {
        vscode.window.showWarningMessage(`Offgrid carregou o modelo, mas restam poucos recursos: ${summary.ram}. O Windows pode usar paginação.`);
      }
      refreshDashboard();
      return true;
    } catch (error) {
      chatState = 'Erro ao carregar';
      statusBar.text = '$(error) Offgrid';
      logModel(`[Load][ERRO] ${error instanceof Error ? error.stack || error.message : String(error)}`);
      await sessions.updateMetadata({ lastError: error instanceof Error ? error.message : String(error) });
      refreshDashboard();
      if (showErrors) await friendlyLoadError(error, current);
      return false;
    }
  }

  async function friendlyLoadError(error, current) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDeviceMemoryError(error)) {
      await refreshResources(true).catch(() => undefined);
      const snapshot = engine.diagnostics.resourceSnapshot;
      const summary = summarizeResources(snapshot);
      const gpu = [...(snapshot?.gpus || [])]
        .sort((a, b) => Number(b.availableBytes || 0) - Number(a.availableBytes || 0))[0];
      const modelName = path.basename(current.modelPath, '.gguf');
      const details = [
        `Não foi possível carregar ${modelName} usando ${String(current.gpu || 'auto').toUpperCase()}.`,
        '',
        'Causa provável: memória de GPU insuficiente.',
        gpu ? `GPU detectada: ${gpu.name} — ${bytesToGb(gpu.totalBytes) ?? '?'} GB totais; ${bytesToGb(gpu.availableBytes) ?? '?'} GB disponíveis.` : `GPU: ${summary.gpu}`,
        `RAM: ${summary.ram}`,
        '',
        'O Offgrid já tentou os perfis adaptativos disponíveis. Você pode forçar CPU, voltar ao Qwen 3B ou abrir os logs.'
      ].join('\n');
      fileLogger.error('model', `[Load][VRAM] ${details}
Erro original: ${error?.stack || message}`);
      const action = await vscode.window.showErrorMessage(
        details,
        { modal: true },
        'Carregar em CPU', 'Usar Qwen 3B', 'Abrir logs'
      );
      if (action === 'Carregar em CPU') {
        await config().update('gpu', 'cpu', vscode.ConfigurationTarget.Global);
        await config().update('gpuLayers', 0, vscode.ConfigurationTarget.Global);
        await loadConfiguredModel(true);
      } else if (action === 'Usar Qwen 3B') {
        const small = catalog.models.find(model => model.id.includes('3b'));
        if (small) await switchModel(small.id);
      } else if (action === 'Abrir logs') output.show(true);
      return;
    }
    const action = await vscode.window.showErrorMessage(`Offgrid: ${message}`, 'Abrir logs', 'Copiar diagnóstico');
    if (action === 'Abrir logs') output.show(true);
    else if (action === 'Copiar diagnóstico') await copyDiagnostics();
  }

  function releaseBaseUrl() {
    const custom = config().get('releaseBaseUrl', '').trim();
    return custom || repositoryReleaseBase(context.extension.packageJSON, catalog.releaseTag);
  }

  async function installModel(model, force = false) {
    await fsp.mkdir(modelsDir(), { recursive: true });
    const destination = modelFile(model);
    if (fs.existsSync(destination) && !force) {
      await setModelPath(destination);
      await loadConfiguredModel(true);
      return destination;
    }
    if (!model.commercialUse) {
      const accepted = await vscode.window.showWarningMessage(
        `${model.displayName} usa ${model.license} e não deve ser usado comercialmente.`,
        { modal: true }, 'Entendo: somente pesquisa'
      );
      if (accepted !== 'Entendo: somente pesquisa') return null;
    }
    if (force && fs.existsSync(destination)) {
      if (stateFor(model).loaded) await engine.unload();
      await fsp.rm(destination, { force: true });
    }
    const installed = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Instalando ${model.displayName}`,
      cancellable: true
    }, async (progress, token) => {
      const githubToken = await context.secrets.get('offgrid.githubToken');
      const installerOptions = { modelsDir: modelsDir(), baseUrl: releaseBaseUrl() };
      if (githubToken) {
        const assets = await loadGithubReleaseAssets(context.extension.packageJSON, catalog.releaseTag, githubToken);
        installerOptions.resolveAssetUrl = part => {
          const url = assets.get(part);
          if (!url) throw new Error(`Asset não encontrado: ${part}`);
          return url;
        };
        installerOptions.headers = {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/octet-stream',
          'User-Agent': 'offgrid'
        };
      }
      currentInstaller = new ModelInstaller({
        ...installerOptions,
        onProgress: event => {
          if (event.stage === 'download-start') progress.report({ message: `Parte ${event.partIndex + 1}/${event.partCount}` });
          else if (event.stage === 'download-progress' && event.total > 0) progress.report({ message: `${Math.floor(event.received / event.total * 100)}%` });
          else if (event.stage === 'assemble') progress.report({ message: 'Montando GGUF' });
          else if (event.stage === 'verify') progress.report({ message: 'Validando SHA-256' });
        }
      });
      token.onCancellationRequested(() => currentInstaller?.cancel());
      try { return await currentInstaller.install(model); }
      finally { currentInstaller = null; }
    });
    if (!installed) return null;
    await setModelPath(installed);
    vscode.window.showInformationMessage(`${model.displayName} instalado e validado.`);
    await loadConfiguredModel(true);
    return installed;
  }

  async function switchModel(modelId) {
    const model = catalog.models.find(item => item.id === modelId);
    if (!model) throw new Error('Modelo não encontrado.');
    if (!fs.existsSync(modelFile(model))) return installModel(model, false);

    const previousConfigured = options().modelPath;
    const previousLoaded = engine.loadedModelPath || context.globalState.get('offgrid.lastFunctionalModelPath', '');
    logModel('[ModelSwitch] Solicitação recebida.');
    logModel(`[ModelSwitch] Modelo atual: ${previousConfigured || 'nenhum'}.`);
    logModel(`[ModelSwitch] Modelo solicitado: ${modelFile(model)}.`);
    logModel(`[ModelSwitch] Backend solicitado: ${options().gpu}; GPU Layers=${options().gpuLayers}.`);
    if (previousLoaded && path.resolve(previousLoaded) === path.resolve(modelFile(model)) && engine.isLoaded) {
      logModel('[ModelSwitch] O modelo solicitado já está carregado.');
      return true;
    }

    try {
      if (engine.isLoaded) {
        logModel('[ModelSwitch] Descarregando modelo anterior.');
        await engine.unload();
        logModel('[ModelSwitch] Unload finalizado.');
      }
      await setModelPath(modelFile(model));
      logModel(`[ModelSwitch] Carregando novo modelo: ${model.displayName}.`);
      const loaded = await loadConfiguredModel(true);
      if (!loaded) throw new Error(`Falha ao carregar ${model.displayName}.`);
      logModel(`[ModelSwitch] Load concluído. Modelo=${model.displayName}; backend efetivo=${engine.backend}; GPU Layers=${engine.diagnostics.gpuLayers}.`);
      return true;
    } catch (error) {
      logModel(`[ModelSwitch][ERRO] Falha ao carregar modelo. ${error?.stack || error}`);
      const rollback = previousLoaded && fs.existsSync(previousLoaded) ? previousLoaded : previousConfigured;
      if (rollback && fs.existsSync(rollback) && path.resolve(rollback) !== path.resolve(modelFile(model))) {
        logModel(`[ModelSwitch] Revertendo para o último modelo funcional: ${rollback}.`);
        await setModelPath(rollback);
        const restored = await loadConfiguredModel(false);
        if (restored) vscode.window.showWarningMessage(`Não foi possível usar ${model.displayName}. O Offgrid restaurou ${path.basename(rollback, '.gguf')}.`);
      } else {
        await setModelPath(previousConfigured || '');
      }
      refreshDashboard();
      return false;
    }
  }

  async function unloadModel() {
    abortController?.abort();
    chatState = 'Descarregando';
    agentState = 'Aguardando modelo';
    refreshDashboard();
    try {
      const report = await engine.unload();
      chatState = 'Indisponível';
      agentState = 'Indisponível';
      statusBar.text = '$(debug-disconnect) Offgrid';
      refreshDashboard();
      const duration = Number(report?.durationMs || report?.diagnostics?.lastUnloadReport?.durationMs || 0);
      vscode.window.showInformationMessage(`Modelo descarregado da memória com sucesso${duration ? ` em ${duration} ms` : ''}.`);
      return report;
    } catch (error) {
      chatState = 'Erro';
      agentState = 'Erro';
      refreshDashboard();
      const action = await vscode.window.showErrorMessage('Falha ao descarregar modelo da memória. Consulte Exibir → Saída → Offgrid.', 'Abrir logs');
      if (action === 'Abrir logs') output.show(true);
      throw error;
    }
  }

  async function validateModel(model) {
    const target = modelFile(model);
    if (!fs.existsSync(target)) throw new Error('O modelo não está instalado.');
    const stat = await fsp.stat(target);
    const expectedSize = Number(model.sizeBytes || 0);
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(target);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    const actualHash = hash.digest('hex').toLowerCase();
    const expectedHash = String(model.sha256 || '').toLowerCase();
    const valid = (!expectedSize || stat.size === expectedSize) && (!expectedHash || actualHash === expectedHash);
    logModel(`[ModelValidation] ${model.displayName}; bytes=${stat.size}; sha256=${actualHash}; válido=${valid}.`);
    if (!valid) throw new Error(`O arquivo ${model.fileName} não corresponde ao tamanho ou SHA-256 esperado.`);
    vscode.window.showInformationMessage(`${model.displayName} foi validado com sucesso.`);
    return { valid, size: stat.size, sha256: actualHash };
  }

  async function removeModel(model) {
    const state = stateFor(model);
    if (!state.installed) return;
    const answer = await vscode.window.showWarningMessage(`Remover ${model.displayName}?`, { modal: true }, 'Remover');
    if (answer !== 'Remover') return;
    if (state.loaded) await unloadModel();
    await fsp.rm(state.target, { force: true });
    if (state.active) await setModelPath('');
    refreshDashboard();
  }

  async function manageModels() {
    const selected = await vscode.window.showQuickPick([
      ...catalog.models.map(model => {
        const state = stateFor(model);
        const status = state.loaded ? 'Carregado' : state.active ? 'Ativo' : state.installed ? 'Instalado' : 'Não instalado';
        return {
          label: `${state.loaded ? '$(play-circle)' : state.installed ? '$(check)' : '$(cloud-download)'} ${model.displayName}`,
          description: `${status} · ${model.approxSize}`,
          detail: `${model.hardware} · ${model.license}`,
          model
        };
      }),
      { label: '$(folder-opened) Selecionar outro GGUF', local: true }
    ], { title: 'Offgrid — Modelos', matchOnDescription: true, matchOnDetail: true });
    if (!selected) return;
    if (selected.local) return selectLocalModel();
    const model = selected.model;
    const state = stateFor(model);
    const actions = [];
    if (!state.installed) actions.push({ label: '$(cloud-download) Instalar e carregar', id: 'install' });
    else {
      if (!state.loaded) actions.push({ label: '$(play) Carregar / ativar', id: 'load' });
      if (state.loaded) actions.push({ label: '$(debug-disconnect) Descarregar da memória', id: 'unload' });
      actions.push({ label: '$(verified-filled) Validar arquivo', id: 'validate' });
      actions.push({ label: '$(refresh) Reinstalar', id: 'reinstall' });
      actions.push({ label: '$(trash) Remover', id: 'remove' });
    }
    actions.push({ label: '$(info) Ver detalhes', id: 'details' });
    const action = await vscode.window.showQuickPick(actions, { title: model.displayName });
    if (!action) return;
    if (action.id === 'install') await installModel(model);
    else if (action.id === 'load') await switchModel(model.id);
    else if (action.id === 'unload') await unloadModel();
    else if (action.id === 'validate') await validateModel(model);
    else if (action.id === 'reinstall') await installModel(model, true);
    else if (action.id === 'remove') await removeModel(model);
    else if (action.id === 'details') {
      vscode.window.showInformationMessage(`${model.displayName}\n${model.approxSize}\n${model.hardware}\nLicença: ${model.license}`, { modal: true });
    }
  }

  async function selectLocalModel() {
    const chosen = await vscode.window.showOpenDialog({
      title: 'Selecionar modelo GGUF',
      filters: { 'Modelo GGUF': ['gguf'] },
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false
    });
    if (!chosen?.length) return;
    await setModelPath(chosen[0].fsPath);
    await loadConfiguredModel(true);
  }

  async function persistContext() {
    await context.workspaceState.update('offgrid.contextEntries', contextEntries);
    refreshContext();
  }

  async function manageContext() {
    const choice = await vscode.window.showQuickPick([
      { label: '$(file-add) Adicionar arquivo ativo', id: 'file' },
      { label: '$(selection) Adicionar seleção atual', id: 'selection' },
      { label: '$(folder-opened) Adicionar pasta', id: 'folder' },
      { label: '$(list-tree) Ver/remover itens', id: 'list' },
      { label: '$(clear-all) Limpar contexto adicional', id: 'clear' }
    ], { title: 'Offgrid — Contexto' });
    if (!choice) return;
    const editor = vscode.window.activeTextEditor;
    if (choice.id === 'file') {
      if (!editor || !usableContext(editor.document.uri)) return vscode.window.showWarningMessage('Abra um arquivo do workspace.');
      const filePath = relative(editor.document.uri);
      if (!contextEntries.some(item => item.type === 'file' && item.path === filePath)) contextEntries.push({ type: 'file', path: filePath, label: filePath });
      await persistContext();
    } else if (choice.id === 'selection') {
      if (!editor || editor.selection.isEmpty) return vscode.window.showWarningMessage('Selecione um trecho primeiro.');
      contextEntries.push({
        type: 'selection',
        path: relative(editor.document.uri),
        label: `${relative(editor.document.uri)}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
        languageId: editor.document.languageId,
        text: editor.document.getText(editor.selection).slice(0, 12000)
      });
      await persistContext();
    } else if (choice.id === 'folder') {
      const folder = (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }))?.[0];
      if (!folder || !vscode.workspace.getWorkspaceFolder(folder)) return;
      const filePath = relative(folder);
      if (!contextEntries.some(item => item.type === 'folder' && item.path === filePath)) contextEntries.push({ type: 'folder', path: filePath, label: filePath });
      await persistContext();
    } else if (choice.id === 'list') {
      if (!contextEntries.length) return vscode.window.showInformationMessage('Nenhum contexto adicional.');
      const item = await vscode.window.showQuickPick(contextEntries.map((entry, index) => ({ label: entry.label, description: entry.type, index })), { title: 'Selecione para remover' });
      if (item) { contextEntries.splice(item.index, 1); await persistContext(); }
    } else if (choice.id === 'clear') {
      contextEntries = [];
      await persistContext();
    }
  }

  function resolveWorkspacePath(relativePath) {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const direct = vscode.Uri.joinPath(folder.uri, relativePath);
      if (fs.existsSync(direct.fsPath)) return direct;
      const withoutRoot = String(relativePath).replace(new RegExp(`^${escapeRegExp(folder.name)}[\\\\/]`), '');
      const candidate = vscode.Uri.joinPath(folder.uri, withoutRoot);
      if (fs.existsSync(candidate.fsPath)) return candidate;
    }
    return null;
  }

  async function buildWorkspaceContext() {
    if (!config().get('includeWorkspaceContext', true)) return '';
    const sections = [];
    const seen = new Set();
    async function addFile(uri, heading, maxChars) {
      if (!uri || !usableContext(uri) || seen.has(uri.fsPath)) return;
      seen.add(uri.fsPath);
      const document = await vscode.workspace.openTextDocument(uri);
      let text = document.getText();
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n...[arquivo truncado]`;
      sections.push(`${heading}\nCaminho: ${relative(uri)}\nLinguagem: ${document.languageId}\n\n${text}`);
    }
    const mainUri = pinnedUri || vscode.window.activeTextEditor?.document.uri;
    if (mainUri) await addFile(mainUri, 'ARQUIVO FIXADO — PONTO DE PARTIDA', 22000);
    for (const entry of contextEntries) {
      if (entry.type === 'file') await addFile(resolveWorkspacePath(entry.path), 'ARQUIVO ADICIONAL', 12000);
      else if (entry.type === 'selection') sections.push(`SELEÇÃO ADICIONADA\nOrigem: ${entry.label}\n\n${String(entry.text || '').slice(0, 12000)}`);
      else if (entry.type === 'folder') {
        const pattern = entry.path && entry.path !== '.' ? `${entry.path.replace(/\\/g, '/')}/**/*` : '**/*';
        const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,out,dist,build,coverage,.next,.venv,venv,target}/**', 80);
        sections.push(`PASTA ADICIONADA: ${entry.label}\n${files.map(relative).sort().join('\n')}`);
      }
    }
    if (vscode.workspace.workspaceFolders?.length) {
      const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,build,coverage,.next,.venv,venv,target}/**', 100);
      sections.push(`ARQUIVOS DO WORKSPACE — AMOSTRA\n${files.map(relative).sort().join('\n')}`);
    }
    return sections.length ? `\n\n<contexto_workspace>\n${sections.join('\n\n')}\n</contexto_workspace>` : '';
  }

  function transcriptWithoutCurrentUser() {
    const items = sessions.getRecentTranscript(10);
    const usable = items.at(-1)?.role === 'user' ? items.slice(0, -1) : items;
    return usable.map(item => `${item.role === 'user' ? 'Usuário' : 'Assistente'}: ${item.text}`).join('\n\n');
  }

  async function runChat(text) {
    abortController = new AbortController();
    chat.addMessage('assistant', '');
    chatState = 'Gerando resposta';
    refreshDashboard();
    try {
      await engine.clearHistory();
      const history = transcriptWithoutCurrentUser();
      const workspace = await buildWorkspaceContext();
      const prompt = [history ? `<historico_sessao>\n${history}\n</historico_sessao>` : '', text, workspace].filter(Boolean).join('\n\n');
      const result = await engine.prompt(prompt, {
        signal: abortController.signal,
        onChunk: chunk => chat.appendAssistant(chunk)
      });
      if (result) await sessions.addMessage('assistant', result, 'chat');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        chat.appendAssistant(`\n\n[Erro: ${error instanceof Error ? error.message : String(error)}]`);
        log(`Erro no Chat: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
    } finally {
      abortController = null;
      chat.finishAssistant();
      chatState = engine.isLoaded ? 'Pronto' : 'Sem modelo';
      refreshDashboard();
    }
  }

  async function resolveExplicitFiles(text) {
    const references = extractExplicitFileReferences(text);
    if (!references.length) return { references: [], matches: [] };
    logAgent(`Arquivos citados no prompt: ${references.join(', ')}`);
    const allMatches = [];
    for (const reference of references) {
      const basename = basenameReference(reference);
      const direct = resolveWorkspacePath(reference);
      if (direct) {
        const located = relative(direct);
        logAgent(`Caminho citado localizado diretamente: ${located}`);
        allMatches.push(located);
        continue;
      }
      const safeName = basename.replace(/[\[\]{}*?]/g, '');
      if (!safeName) continue;
      const pattern = `**/${safeName}`;
      logAgent(`Buscando arquivo citado: ${pattern}`);
      const found = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,out,dist,build,coverage,.next,.venv,venv,target}/**', 20);
      for (const uri of found) allMatches.push(relative(uri));
    }
    const matches = [...new Set(allMatches)];
    logAgent(`Arquivos citados localizados: ${matches.join(', ') || 'nenhum'}`);
    if (matches.length) logAgent('Priorizando os arquivos citados pelo usuário sobre o arquivo fixado.');
    return { references, matches };
  }

  async function agentPrompt(text, requestedMode = 'agent') {
    const explicit = await resolveExplicitFiles(text);
    const hints = [];
    if (explicit.references.length) {
      hints.push(`Arquivos explicitamente citados pelo usuário: ${explicit.references.join(', ')}`);
      if (explicit.matches.length) hints.push(`Caminhos localizados para os arquivos citados: ${explicit.matches.join(', ')}`);
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && usableContext(editor.document.uri) && !editor.selection.isEmpty) {
      hints.push(`Seleção ativa: ${relative(editor.document.uri)}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`);
    }
    const mainUri = pinnedUri || editor?.document.uri;
    if (mainUri && usableContext(mainUri)) {
      hints.push(`Arquivo fixado/ativo: ${relative(mainUri)}`);
      logAgent(`Arquivo fixado atual: ${relative(mainUri)}`);
    }
    for (const entry of contextEntries) hints.push(`Contexto adicional (${entry.type}): ${entry.label}`);

    const modeInstructions = requestedMode === 'plan'
      ? 'MODO PLANEJAR: pesquise e leia os arquivos necessários, mas não prepare nem aplique alterações. Entregue um plano detalhado.'
      : requestedMode === 'readOnly'
        ? 'MODO SOMENTE LEITURA: pesquise e leia os arquivos necessários, sem preparar alterações. Responda com a análise solicitada.'
        : 'MODO AGENTE: prepare mudanças com stageReplace/stageFile e finalize com applyChanges para abrir a revisão.';

    return [
      `Tarefa: ${text}`,
      `Modo solicitado: ${requestedMode}`,
      `Workspace(s): ${(vscode.workspace.workspaceFolders || []).map(folder => folder.name).join(', ')}`,
      ...hints,
      modeInstructions,
      explicit.references.length
        ? 'Prioridade obrigatória: comece pelos arquivos citados explicitamente pelo usuário. O arquivo fixado é secundário nesta tarefa.'
        : 'Comece pela seleção ativa; depois use o arquivo fixado/ativo e pesquise arquivos relacionados.',
      'Consulte node_modules apenas como leitura. Não imprima somente JSON de ferramenta: use as ferramentas e prossiga até concluir.'
    ].filter(Boolean).join('\n\n');
  }

  async function runAgent(text, requestedMode = 'agent') {
    if (agent.hasPendingReview) {
      chat.addMessage('system', 'Existe uma revisão pendente. Aceite ou rejeite antes de iniciar outra tarefa.');
      return chat.finishAssistant();
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      chat.addMessage('system', 'Abra um workspace antes de usar o Agente.');
      return chat.finishAssistant();
    }
    if (!vscode.workspace.isTrusted) {
      chat.addMessage('system', 'O Agente exige um workspace confiável.');
      return chat.finishAssistant();
    }

    const requestedReadOnly = requestedMode === 'plan' || requestedMode === 'readOnly';
    const approval = requestedReadOnly
      ? 'readOnly'
      : config().get('agentApprovalMode', config().get('agentRequireReview', true) ? 'ask' : 'full');
    if (config().get('agentRequireConfirmation', true) && approval !== 'readOnly') {
      const answer = await vscode.window.showWarningMessage(
        'O Offgrid poderá ler e preparar alterações em arquivos permitidos do workspace. Pastas protegidas permanecem somente leitura.',
        { modal: true }, approval === 'full' ? 'Executar e aplicar automaticamente' : 'Executar agente'
      );
      if (!answer) {
        chat.addMessage('system', 'Execução cancelada.');
        return chat.finishAssistant();
      }
    }

    agent.reset();
    abortController = new AbortController();
    chat.addMessage('assistant', '');
    agentState = 'Iniciando';
    refreshDashboard();
    let streamed = false;
    const startedAt = Date.now();
    try {
      logAgent('runAgent iniciado.');
      logAgent(`Texto recebido: ${text}`);
      logAgent(`Workspace(s): ${(vscode.workspace.workspaceFolders || []).map(folder => folder.name).join(', ')}`);
      logAgent(`Modelo ativo: ${engine.loadedModelPath || 'nenhum'}`);
      logAgent(`Backend atual: ${engine.backend || 'cpu'}`);
      logAgent(`Modo=${requestedMode}; aprovação=${approval}; maxSteps=${options().maxAgentSteps}`);
      const functions = await agent.createFunctions({ readOnly: approval === 'readOnly' });
      logAgent(`Funções disponíveis: ${Object.keys(functions).join(', ')}`);
      const prompt = await agentPrompt(text, requestedMode);
      logAgent(`Prompt montado. Caracteres=${prompt.length}`);
      if (options().diagnosticMode) fileLogger.trace('agent', `Prompt preview:\n${prompt.slice(0, 12000)}`);
      agentState = requestedMode === 'plan' ? 'Planejando' : 'Executando ferramentas';
      refreshDashboard();
      const result = await engine.runAgent(prompt, {
        functions,
        agentSystemPrompt,
        maxTokens: options().agentMaxTokens,
        maxAgentSteps: options().maxAgentSteps,
        diagnosticMode: options().diagnosticMode,
        signal: abortController.signal,
        onChunk: chunk => { streamed = true; chat.appendAssistant(chunk); }
      });
      if (!streamed && result) chat.appendAssistant(result);
      if (result) await sessions.addMessage('assistant', result, requestedMode);
      await sessions.updateMetadata({
        mode: requestedMode,
        model: path.basename(engine.loadedModelPath || '', '.gguf'),
        backend: String(engine.backend || 'cpu').toUpperCase(),
        contextSize: options().contextSize,
        contextFiles: [relative(pinnedUri), ...contextEntries.map(entry => entry.label)].filter(Boolean),
        lastError: ''
      });

      if (approval === 'readOnly') {
        agent.reset();
        chat.addMessage('system', requestedMode === 'plan'
          ? 'Modo Planejar: nenhum arquivo foi alterado.'
          : 'Modo Somente leitura: nenhum arquivo foi alterado.');
      } else {
        if (agent.hasStagedChanges && !agent.hasPendingReview) agent.preparePendingReview('Alterações propostas pelo agente');
        const review = agent.getPendingReview();
        if (review && approval === 'ask') {
          chat.showChangeReview(review);
          chat.addMessage('system', 'Nenhum arquivo foi salvo. Abra os diffs e aceite ou rejeite.');
        } else if (review && approval === 'full') {
          const applied = await agent.acceptPendingChanges();
          chat.addMessage('system', `${applied.files.length} arquivo(s) salvo(s) automaticamente.`);
        }
      }
      agentState = 'Pronto';
      logAgent(`runAgent concluído em ${Date.now() - startedAt} ms.`);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        const details = error instanceof Error ? error.stack || error.message : String(error);
        fileLogger.error('agent', `ERRO no modo agente: ${details}`);
        agentState = 'Erro';
        const message = error instanceof Error ? error.message : String(error);
        await sessions.updateMetadata({ mode: requestedMode, lastError: message });
        chat.appendAssistant(/no sequences left/i.test(message)
          ? '\n\n[Não foi possível iniciar o Agente porque o motor não obteve uma sequência. Use “Offgrid: Reiniciar Agente” e consulte os logs.]'
          : `\n\n[Erro do agente: ${message}. Consulte Exibir → Saída → Offgrid.]`);
      }
    } finally {
      if (!agent.hasPendingReview) agent.staged.clear();
      abortController = null;
      chat.finishAssistant();
      refreshDashboard();
    }
  }

  async function switchSession(id) {
    await sessions.select(id);
    await engine.clearHistory().catch(error => log(`Falha ao limpar histórico: ${error.message || error}`));
    chat.loadSession(sessions.getMessages());
    refreshDashboard();
  }
  async function newSession() {
    await sessions.create();
    await engine.clearHistory().catch(() => undefined);
    chat.loadSession([]);
    refreshDashboard();
  }
  async function manageSessions() {
    const selected = await vscode.window.showQuickPick(sessions.snapshot().sessions.map(session => ({
      label: `${session.pinned ? '$(pinned)' : '$(comment-discussion)'} ${session.title}`,
      description: `${session.messageCount} mensagem(ns)`,
      session
    })), { title: 'Offgrid — Sessões' });
    if (!selected) return;
    const action = await vscode.window.showQuickPick([
      { label: '$(open-preview) Abrir', id: 'open' },
      { label: '$(edit) Renomear', id: 'rename' },
      { label: selected.session.pinned ? '$(pinned-dirty) Desafixar' : '$(pin) Fixar', id: 'pin' },
      { label: '$(copy) Duplicar', id: 'duplicate' },
      { label: '$(trash) Excluir', id: 'delete' }
    ], { title: selected.session.title });
    if (!action) return;
    if (action.id === 'open') await switchSession(selected.session.id);
    else if (action.id === 'rename') {
      const title = await vscode.window.showInputBox({ value: selected.session.title, title: 'Renomear sessão' });
      if (title) await sessions.rename(selected.session.id, title);
    } else if (action.id === 'pin') await sessions.togglePin(selected.session.id);
    else if (action.id === 'duplicate') { await sessions.duplicate(selected.session.id); chat.loadSession(sessions.getMessages()); }
    else if (action.id === 'delete') { await sessions.delete(selected.session.id); chat.loadSession(sessions.getMessages()); }
    refreshDashboard();
  }

  async function buildDiagnosticText({ includeLogs = true } = {}) {
    await refreshResources(true).catch(() => undefined);
    const current = options();
    const diag = engine.diagnostics;
    const snapshot = diag.resourceSnapshot;
    const summary = summarizeResources(snapshot);
    const review = agent.getPendingReview();
    const lines = [
      `Offgrid version: ${context.extension.packageJSON.version}`,
      `VS Code version: ${vscode.version}`,
      `Node: ${process.versions.node || '—'}`,
      `Electron: ${process.versions.electron || '—'}`,
      `OS: ${process.platform} ${process.arch} ${require('node:os').release()}`,
      `Modelos instalados: ${catalog.models.filter(model => fs.existsSync(modelFile(model))).map(model => model.displayName).join(', ') || 'nenhum'}`,
      `Modelo ativo: ${current.modelPath || 'nenhum'}`,
      `Modelo carregado: ${diag.modelPath || 'nenhum'}`,
      `Backend: ${diag.backend || 'cpu'}`,
      `Estado do motor: ${diag.engineState || 'não iniciado'}`,
      `PID do motor: ${diag.workerPid || 'não iniciado'}`,
      `Context size: ${current.contextSize}`,
      `Max tokens: ${current.maxTokens}`,
      `Agent max tokens: ${current.agentMaxTokens}`,
      `Max agent steps: ${current.maxAgentSteps}`,
      `GPU Layers: ${current.gpuLayers}`,
      `Fallback CPU: ${current.fallbackToCpu ? 'ativado' : 'desativado'}`,
      `Nível de log: ${config().get('logLevel', 'debug')}`,
      `Modo diagnóstico: ${config().get('diagnosticMode', false) ? 'ativado' : 'desativado'}`,
      `Painel de diagnóstico: ${config().get('diagnosticsPanel', 'compact')}`,
      `RAM total/livre: ${summary.ram}`,
      `RAM do motor: ${summary.engine}`,
      `GPU/VRAM: ${summary.gpu}`,
      `Chat: ${chatState}`,
      `Agente: ${agentState}`,
      `Revisão pendente: ${review ? review.files.join(', ') : 'não'}`,
      `Arquivo fixado: ${relative(pinnedUri) || 'nenhum'}`,
      `Contextos adicionais: ${contextEntries.map(entry => entry.label).join(', ') || 'nenhum'}`,
      `Perfil selecionado: ${diag.selectedProfile ? JSON.stringify(diag.selectedProfile) : 'nenhum'}`,
      `Último fallback: ${diag.lastFallback ? JSON.stringify(diag.lastFallback) : 'nenhum'}`,
      `Último erro: ${diag.lastError || 'nenhum'}`,
      `Pasta de logs: ${fileLogger.logsPath}`
    ];
    if (includeLogs) lines.push('', 'Últimas 100 linhas de log:', ...fileLogger.lastLines(100));
    return lines.join('\n');
  }

  async function copyDiagnostics() {
    const text = await buildDiagnosticText({ includeLogs: true });
    await vscode.env.clipboard.writeText(text);
    fileLogger.info('diagnostics', 'Diagnóstico copiado para a área de transferência.');
    vscode.window.showInformationMessage('Diagnóstico do Offgrid copiado.');
    return text;
  }

  async function showModelDiagnostics() {
    const text = await buildDiagnosticText({ includeLogs: false });
    fileLogger.info('diagnostics', `Diagnóstico do modelo:\n${text}`);
    const action = await vscode.window.showInformationMessage(text, { modal: true }, 'Copiar diagnóstico', 'Abrir logs', 'Abrir pasta de logs');
    if (action === 'Copiar diagnóstico') await copyDiagnostics();
    else if (action === 'Abrir logs') output.show(true);
    else if (action === 'Abrir pasta de logs') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fileLogger.logsPath));
  }

  async function showResourceDiagnostics() {
    await refreshResources(true);
    const diag = engine.diagnostics;
    const snapshot = diag.resourceSnapshot;
    const summary = summarizeResources(snapshot);
    const gpuLines = (snapshot?.gpus || []).map(gpu => [
      `GPU: ${gpu.name}`,
      `  Fonte: ${gpu.source}`,
      `  Total: ${bytesToGb(gpu.totalBytes) ?? '—'} GB`,
      `  Em uso: ${bytesToGb(gpu.usedBytes) ?? '—'} GB`,
      `  Disponível: ${bytesToGb(gpu.availableBytes) ?? '—'} GB`,
      gpu.note ? `  Observação: ${gpu.note}` : ''
    ].filter(Boolean).join('\n'));
    const text = [
      `Sistema: ${snapshot?.platform || process.platform}${process.platform === 'win32' ? ' (recursos avançados habilitados)' : ' (modo compatível; VRAM avançada somente no Windows)'}`,
      `RAM: ${summary.ram}`,
      `RAM do processo do motor: ${summary.engine}`,
      `Estado do motor: ${diag.engineState || 'não iniciado'}`,
      `Processo do motor: ${diag.workerPid || 'não iniciado'}`,
      `GPU principal: ${summary.gpu}`,
      ...gpuLines,
      `Tentativas planejadas: ${(diag.attempts || []).map(item => `${item.gpu}/${item.gpuLayers}`).join(' → ') || 'nenhuma'}`
    ].join('\n');
    fileLogger.info('diagnostics', `Diagnóstico de recursos:\n${text}`);
    const action = await vscode.window.showInformationMessage(text, { modal: true }, 'Copiar diagnóstico', 'Abrir logs');
    if (action === 'Copiar diagnóstico') await copyDiagnostics();
    else if (action === 'Abrir logs') output.show(true);
  }

  async function showAgentDiagnostics() {
    const review = agent.getPendingReview();
    const activeSession = sessions.snapshot().sessions.find(item => item.id === sessions.snapshot().activeSessionId);
    const text = [
      `Agente: ${agentState}`,
      `Modelo carregado: ${engine.isLoaded ? 'sim' : 'não'}`,
      `Backend: ${engine.backend || 'cpu'}`,
      `Estado do motor: ${engine.diagnostics.engineState || 'não iniciado'}`,
      `Revisão pendente: ${review ? 'sim' : 'não'}`,
      `Arquivos pendentes: ${review?.files?.join(', ') || 'nenhum'}`,
      `Arquivo fixado: ${relative(pinnedUri) || 'nenhum'}`,
      `Contextos adicionais: ${contextEntries.length}`,
      `Metadados da sessão: ${JSON.stringify(activeSession?.metadata || {})}`
    ].join('\n');
    fileLogger.info('agent', `Diagnóstico:\n${text}`);
    const action = await vscode.window.showInformationMessage(text, { modal: true }, 'Copiar diagnóstico', 'Abrir logs');
    if (action === 'Copiar diagnóstico') await copyDiagnostics();
    else if (action === 'Abrir logs') output.show(true);
  }

  chat.onSubmit(async (text, mode = 'chat') => {
    if (!text) return chat.finishAssistant();
    const labels = { agent: 'Agente', plan: 'Planejar', readOnly: 'Somente leitura' };
    chat.addMessage('user', labels[mode] ? `[${labels[mode]}] ${text}` : text);
    await sessions.addMessage('user', text, mode);
    refreshDashboard();
    if (!engine.isLoaded) {
      chat.addMessage('system', 'Tentando carregar o modelo ativo...');
      if (!await loadConfiguredModel(true)) {
        chat.addMessage('system', 'Não foi possível carregar o modelo. Consulte Exibir → Saída → Offgrid.');
        return chat.finishAssistant();
      }
    }
    if (['agent', 'plan', 'readOnly'].includes(mode)) await runAgent(text, mode);
    else await runChat(text);
  });
  chat.onAbort(() => abortController?.abort());

  chat.onAction(async message => {
    try {
      if (message.type === 'pinCurrent') {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !usableContext(editor.document.uri)) return vscode.window.showWarningMessage('Abra um arquivo do workspace.');
        setPinned(editor.document.uri, true);
      } else if (message.type === 'unpin') {
        pinLocked = false; pinnedUri = null; followEditor(); refreshContext();
      } else if (message.type === 'openPinned' && pinnedUri) await vscode.window.showTextDocument(pinnedUri, { preview: false });
      else if (message.type === 'manageContext') await manageContext();
      else if (message.type === 'manageModels') await manageModels();
      else if (message.type === 'switchModel') await switchModel(message.modelId);
      else if (message.type === 'unloadModel') await unloadModel();
      else if (message.type === 'openSettings') await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
      else if (message.type === 'showDiagnostics') await showModelDiagnostics();
      else if (message.type === 'showResources') await showResourceDiagnostics();
      else if (message.type === 'copyDiagnostics') await copyDiagnostics();
      else if (message.type === 'openLogsFolder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fileLogger.logsPath));
      else if (message.type === 'newSession') await newSession();
      else if (message.type === 'selectSession') await switchSession(message.sessionId);
      else if (message.type === 'manageSessions') await manageSessions();
      else if (message.type === 'renameSession') {
        const current = sessions.snapshot().sessions.find(item => item.id === message.sessionId);
        const title = await vscode.window.showInputBox({ value: current?.title || '', title: 'Renomear sessão' });
        if (title) await sessions.rename(message.sessionId, title);
        refreshDashboard();
      } else if (message.type === 'deleteSession') {
        await sessions.delete(message.sessionId); chat.loadSession(sessions.getMessages()); refreshDashboard();
      } else if (message.type === 'duplicateSession') {
        await sessions.duplicate(message.sessionId); chat.loadSession(sessions.getMessages()); refreshDashboard();
      } else if (message.type === 'pinSession') {
        await sessions.togglePin(message.sessionId); refreshDashboard();
      } else if (message.type === 'openDiff') await preview.open(agent.getPendingChange(message.filePath));
      else if (message.type === 'acceptChanges') {
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Aplicando alterações do Offgrid', cancellable: false }, () => agent.acceptPendingChanges());
        preview.clear();
        chat.updateChangeReview('accepted', `${result.files.length} arquivo(s) salvo(s).`);
        const action = await vscode.window.showInformationMessage(`Offgrid salvou ${result.files.length} arquivo(s).`, 'Desfazer alterações');
        if (action === 'Desfazer alterações') await vscode.commands.executeCommand('offgrid.undoLastAgentChanges');
      } else if (message.type === 'rejectChanges') {
        const files = agent.rejectPendingChanges();
        preview.clear();
        chat.updateChangeReview('rejected', `${files.length} alteração(ões) rejeitada(s).`);
      }
    } catch (error) {
      log(`Erro em ação do chat: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      vscode.window.showErrorMessage(`Offgrid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('offgrid-diff', preview),
    vscode.commands.registerCommand('offgrid.openChat', () => vscode.commands.executeCommand('workbench.view.extension.offgrid')),
    vscode.commands.registerCommand('offgrid.manageModels', manageModels),
    vscode.commands.registerCommand('offgrid.selectLocalModel', selectLocalModel),
    vscode.commands.registerCommand('offgrid.reloadModel', () => loadConfiguredModel(true)),
    vscode.commands.registerCommand('offgrid.unloadModel', unloadModel),
    vscode.commands.registerCommand('offgrid.restartEngine', async () => {
      abortController?.abort();
      await engine.restart();
      chatState = 'Motor reiniciado';
      agentState = 'Aguardando modelo';
      refreshDashboard();
      if (options().modelPath) await loadConfiguredModel(true);
    }),
    vscode.commands.registerCommand('offgrid.showResourceDiagnostics', showResourceDiagnostics),
    vscode.commands.registerCommand('offgrid.copyDiagnostics', copyDiagnostics),
    vscode.commands.registerCommand('offgrid.openLogsFolder', () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fileLogger.logsPath))),
    vscode.commands.registerCommand('offgrid.clearHardwareProfile', async () => {
      const current = options();
      await engine.refreshDiagnostics(true);
      await engine.profiles.clear(current.modelPath, engine.diagnostics.resourceSnapshot);
      vscode.window.showInformationMessage('Perfil automático de hardware removido. O próximo carregamento testará novamente as opções.');
    }),
    vscode.commands.registerCommand('offgrid.restartAgent', async () => {
      abortController?.abort();
      agent.rejectPendingChanges();
      agent.reset();
      await engine.clearHistory();
      agentState = 'Reiniciado';
      refreshDashboard();
      vscode.window.showInformationMessage('Estado do Agente reiniciado.');
    }),
    vscode.commands.registerCommand('offgrid.clearAgentState', async () => {
      abortController?.abort();
      agent.rejectPendingChanges();
      agent.reset();
      preview.clear();
      agentState = 'Estado limpo';
      refreshDashboard();
    }),
    vscode.commands.registerCommand('offgrid.reloadChatSession', async () => {
      await engine.clearHistory();
      chatState = 'Sessão recarregada';
      refreshDashboard();
    }),
    vscode.commands.registerCommand('offgrid.showModelDiagnostics', showModelDiagnostics),
    vscode.commands.registerCommand('offgrid.showAgentDiagnostics', showAgentDiagnostics),
    vscode.commands.registerCommand('offgrid.newSession', newSession),
    vscode.commands.registerCommand('offgrid.manageSessions', manageSessions),
    vscode.commands.registerCommand('offgrid.manageContext', manageContext),
    vscode.commands.registerCommand('offgrid.pinActiveFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && usableContext(editor.document.uri)) setPinned(editor.document.uri, true);
    }),
    vscode.commands.registerCommand('offgrid.unpinFile', () => {
      pinLocked = false; pinnedUri = null; followEditor(); refreshContext();
    }),
    vscode.commands.registerCommand('offgrid.setGithubToken', async () => {
      const token = await vscode.window.showInputBox({ title: 'Token do GitHub', password: true, ignoreFocusOut: true });
      if (token === undefined) return;
      if (token.trim()) await context.secrets.store('offgrid.githubToken', token.trim());
      else await context.secrets.delete('offgrid.githubToken');
    }),
    vscode.commands.registerCommand('offgrid.clearChat', async () => {
      await sessions.clearActive();
      chat.loadSession([]);
      await engine.clearHistory();
      refreshDashboard();
    }),
    vscode.commands.registerCommand('offgrid.undoLastAgentChanges', async () => {
      try {
        const files = await agent.undoLastChanges();
        vscode.window.showInformationMessage(`Alterações desfeitas em ${files.length} arquivo(s).`);
      } catch (error) {
        vscode.window.showErrorMessage(`Offgrid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => followEditor(editor)),
    vscode.workspace.onDidChangeConfiguration(event => {
      fileLogger.configure({ level: config().get('logLevel', 'debug'), diagnosticMode: config().get('diagnosticMode', false) });
      if (event.affectsConfiguration('offgrid.diagnosticMode') && config().get('diagnosticMode', false)) {
        fileLogger.warn('offgrid', '[Diagnostics] Modo diagnóstico ativado. Logs podem conter caminhos, prévias de prompts e resultados de ferramentas.');
        vscode.window.showWarningMessage('Offgrid: o modo diagnóstico pode registrar caminhos e trechos de código nos logs locais.');
      }
      if (suppressReload) return;
      if (['offgrid.modelPath', 'offgrid.gpu', 'offgrid.gpuLayers', 'offgrid.contextSize', 'offgrid.fallbackToCpu', 'offgrid.adaptiveGpu'].some(key => event.affectsConfiguration(key))) {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => loadConfiguredModel(false), 350);
      }
      if (event.affectsConfiguration('offgrid.resourceMonitoring') || event.affectsConfiguration('offgrid.resourceRefreshSeconds')) {
        startResourceTimer();
        refreshResources(true);
      }
      refreshDashboard();
    }),
    statusBar,
    output,
    { dispose: () => { clearTimeout(reloadTimer); clearInterval(resourceTimer); preview.clear(); engine.dispose(); } }
  );

  followEditor();
  refreshContext();
  chat.loadSession(sessions.getMessages());
  refreshDashboard();
  startResourceTimer();
  await refreshResources(true);
  log(`Offgrid ${context.extension.packageJSON.version || ''} ativado. Plataforma=${process.platform}; motor isolado=sim.`);
  try {
    await autoSelectBundledModel(context, catalog);
    if (config().get('autoLoadModel', true)) await loadConfiguredModel(false);
  } catch (error) {
    log(`Falha na inicialização: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}


function engineStateLabel(value) {
  const labels = {
    notStarted: 'não iniciado',
    loading: 'carregando',
    ready: 'pronto',
    unloading: 'descarregando',
    unloaded: 'descarregado',
    error: 'erro'
  };
  return labels[value] || value || 'não iniciado';
}

function sanitizeContextEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(entry => entry && ['file', 'folder', 'selection'].includes(entry.type) && typeof entry.label === 'string').slice(0, 30);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadGithubReleaseAssets(packageJson, releaseTag, token) {
  const { owner, repository } = repositoryCoordinates(packageJson);
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(releaseTag)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'offgrid' }
  });
  if (!response.ok) throw new Error(`Não foi possível ler o Release privado: HTTP ${response.status}.`);
  const release = await response.json();
  return new Map((release.assets || []).map(asset => [asset.name, asset.url]));
}

async function autoSelectBundledModel(context, catalog) {
  const config = vscode.workspace.getConfiguration('offgrid');
  if (config.get('modelPath', '')) return;
  for (const model of [...catalog.models].sort((a, b) => Number(b.commercialUse) - Number(a.commercialUse))) {
    const candidate = path.join(context.extensionPath, 'models', model.fileName);
    if (fs.existsSync(candidate)) {
      await config.update('modelPath', candidate, vscode.ConfigurationTarget.Global);
      return;
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };

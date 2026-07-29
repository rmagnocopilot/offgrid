'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
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

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const output = vscode.window.createOutputChannel('Offgrid');
  const log = message => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  const logAgent = message => log(`[Agent] ${message}`);
  const engine = new EngineProcessClient({
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath,
    logger: log
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
  });
  const sessions = new SessionStore(context.globalStorageUri.fsPath, log);
  await sessions.init();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'offgrid.manageModels';
  statusBar.text = '$(plug) Offgrid';
  statusBar.show();

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
    agentMaxTokens: config().get('agentMaxTokens', 4096)
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
      chatState,
      agentState,
      loading: engine.isLoading,
      resources: summarizeResources(engine.diagnostics.resourceSnapshot),
      workerPid: engine.diagnostics.workerPid || null,
      selectedProfile: engine.diagnostics.selectedProfile || null
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
      log(`ERRO ao carregar: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      refreshDashboard();
      if (showErrors) await friendlyLoadError(error, current);
      return false;
    }
  }

  async function friendlyLoadError(error, current) {
    if (isDeviceMemoryError(error)) {
      const action = await vscode.window.showErrorMessage(
        `Memória de GPU insuficiente para ${path.basename(current.modelPath, '.gguf')}.`,
        'Tentar em CPU', 'Usar Qwen 3B', 'Abrir logs'
      );
      if (action === 'Tentar em CPU') {
        await config().update('gpu', 'cpu', vscode.ConfigurationTarget.Global);
        await loadConfiguredModel(true);
      } else if (action === 'Usar Qwen 3B') {
        const small = catalog.models.find(model => model.id.includes('3b'));
        if (small) await switchModel(small.id);
      } else if (action === 'Abrir logs') output.show(true);
      return;
    }
    const action = await vscode.window.showErrorMessage(`Offgrid: ${error instanceof Error ? error.message : String(error)}`, 'Abrir logs');
    if (action === 'Abrir logs') output.show(true);
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
    await setModelPath(modelFile(model));
    await loadConfiguredModel(true);
  }

  async function unloadModel() {
    abortController?.abort();
    await engine.unload();
    chatState = 'Modelo descarregado';
    agentState = 'Aguardando modelo';
    statusBar.text = '$(debug-disconnect) Offgrid';
    refreshDashboard();
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
      actions.push({ label: '$(refresh) Reinstalar', id: 'reinstall' });
      actions.push({ label: '$(trash) Remover', id: 'remove' });
    }
    actions.push({ label: '$(info) Ver detalhes', id: 'details' });
    const action = await vscode.window.showQuickPick(actions, { title: model.displayName });
    if (!action) return;
    if (action.id === 'install') await installModel(model);
    else if (action.id === 'load') await switchModel(model.id);
    else if (action.id === 'unload') await unloadModel();
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

  async function agentPrompt(text) {
    const hints = [];
    const mainUri = pinnedUri || vscode.window.activeTextEditor?.document.uri;
    if (mainUri && usableContext(mainUri)) hints.push(`Arquivo fixado: ${relative(mainUri)}`);
    for (const entry of contextEntries) hints.push(`Contexto adicional (${entry.type}): ${entry.label}`);
    return [
      `Tarefa: ${text}`,
      `Workspace(s): ${(vscode.workspace.workspaceFolders || []).map(folder => folder.name).join(', ')}`,
      ...hints,
      'Comece pelo arquivo fixado, pesquise arquivos relacionados e consulte node_modules apenas como leitura.',
      'Quando a escrita estiver disponível, prepare as mudanças e finalize com applyChanges.'
    ].filter(Boolean).join('\n\n');
  }

  async function runAgent(text) {
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
    const approval = config().get('agentApprovalMode', config().get('agentRequireReview', true) ? 'ask' : 'full');
    if (config().get('agentRequireConfirmation', true) && approval !== 'readOnly') {
      const answer = await vscode.window.showWarningMessage(
        'O Offgrid poderá ler e alterar arquivos permitidos do workspace. Pastas protegidas permanecem somente leitura.',
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
    try {
      logAgent('runAgent iniciado.');
      logAgent(`Texto: ${text}`);
      logAgent(`Engine carregado=${engine.isLoaded}; backend=${engine.backend || 'cpu'}; aprovação=${approval}`);
      const functions = await agent.createFunctions({ readOnly: approval === 'readOnly' });
      logAgent(`Funções criadas: ${Object.keys(functions).length}`);
      const prompt = await agentPrompt(text);
      logAgent(`Prompt montado. Caracteres=${prompt.length}`);
      agentState = 'Executando ferramentas';
      refreshDashboard();
      const result = await engine.runAgent(prompt, {
        functions,
        agentSystemPrompt,
        maxTokens: options().agentMaxTokens,
        signal: abortController.signal,
        onChunk: chunk => { streamed = true; chat.appendAssistant(chunk); }
      });
      if (!streamed && result) chat.appendAssistant(result);
      if (result) await sessions.addMessage('assistant', result, 'agent');

      if (approval === 'readOnly') {
        agent.reset();
        chat.addMessage('system', 'Modo Somente leitura: nenhum arquivo foi alterado.');
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
      logAgent('runAgent concluído.');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        const details = error instanceof Error ? error.stack || error.message : String(error);
        logAgent(`ERRO: ${details}`);
        agentState = 'Erro';
        const message = error instanceof Error ? error.message : String(error);
        chat.appendAssistant(/no sequences left/i.test(message)
          ? '\n\n[O motor não conseguiu obter uma sequência. Execute “Offgrid: Reiniciar Agente” e consulte Exibir → Saída → Offgrid.]'
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

  async function showModelDiagnostics() {
    const current = options();
    const diag = engine.diagnostics;
    const text = [
      `Versão: ${context.extension.packageJSON.version}`,
      `Modelo configurado: ${current.modelPath || 'nenhum'}`,
      `Modelo carregado: ${diag.modelPath || 'nenhum'}`,
      `Backend: ${diag.backend}`,
      `Contexto: ${current.contextSize}`,
      `GPU Layers: ${current.gpuLayers}`,
      `Fallback CPU: ${current.fallbackToCpu ? 'ativado' : 'desativado'}`,
      `Sequências adquiridas: ${diag.sequenceAcquisitions}`,
      `Processo do motor: ${diag.workerPid || 'não iniciado'}`,
      `RAM do motor: ${bytesToGb(diag.processMemory?.rssBytes) ?? '—'} GB`,
      `RAM do sistema: ${summarizeResources(diag.resourceSnapshot).ram}`,
      `GPU/VRAM: ${summarizeResources(diag.resourceSnapshot).gpu}`,
      `Perfil selecionado: ${diag.selectedProfile ? JSON.stringify(diag.selectedProfile) : 'nenhum'}`,
      `Último fallback: ${diag.lastFallback ? JSON.stringify(diag.lastFallback) : 'nenhum'}`,
      `Último erro: ${diag.lastError || 'nenhum'}`
    ].join('\n');
    log(`Diagnóstico do modelo:\n${text}`);
    const action = await vscode.window.showInformationMessage(text, { modal: true }, 'Abrir logs');
    if (action === 'Abrir logs') output.show(true);
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
      `Processo do motor: ${diag.workerPid || 'não iniciado'}`,
      `GPU principal: ${summary.gpu}`,
      ...gpuLines,
      `Tentativas planejadas: ${(diag.attempts || []).map(item => `${item.gpu}/${item.gpuLayers}`).join(' → ') || 'nenhuma'}`
    ].join('\n');
    log(`Diagnóstico de recursos:
${text}`);
    const action = await vscode.window.showInformationMessage(text, { modal: true }, 'Abrir logs');
    if (action === 'Abrir logs') output.show(true);
  }

  async function showAgentDiagnostics() {
    const review = agent.getPendingReview();
    const text = [
      `Agente: ${agentState}`,
      `Modelo carregado: ${engine.isLoaded ? 'sim' : 'não'}`,
      `Backend: ${engine.backend || 'cpu'}`,
      `Revisão pendente: ${review ? 'sim' : 'não'}`,
      `Arquivos pendentes: ${review?.files?.join(', ') || 'nenhum'}`,
      `Arquivo fixado: ${relative(pinnedUri) || 'nenhum'}`,
      `Contextos adicionais: ${contextEntries.length}`
    ].join('\n');
    logAgent(`Diagnóstico:\n${text}`);
    const action = await vscode.window.showInformationMessage(text, { modal: true }, 'Abrir logs');
    if (action === 'Abrir logs') output.show(true);
  }

  chat.onSubmit(async (text, mode = 'chat') => {
    if (!text) return chat.finishAssistant();
    chat.addMessage('user', mode === 'agent' ? `[Agente] ${text}` : text);
    await sessions.addMessage('user', text, mode);
    refreshDashboard();
    if (!engine.isLoaded) {
      chat.addMessage('system', 'Tentando carregar o modelo ativo...');
      if (!await loadConfiguredModel(true)) {
        chat.addMessage('system', 'Não foi possível carregar o modelo. Consulte Exibir → Saída → Offgrid.');
        return chat.finishAssistant();
      }
    }
    if (mode === 'agent') await runAgent(text);
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

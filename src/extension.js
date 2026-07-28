'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { LlamaEngine } = require('./llama-engine');
const { ChatViewProvider } = require('./chat-view');
const { ModelInstaller } = require('./model-installer');
const { WorkspaceAgent } = require('./workspace-agent');
const { ChangePreviewProvider } = require('./change-preview');
const { loadCatalog, repositoryReleaseBase, repositoryCoordinates } = require('./model-catalog');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const output = vscode.window.createOutputChannel('Offgrid');
  const log = message => {
    const timestamp = new Date().toISOString();
    output.appendLine(`[${timestamp}] ${message}`);
  };
  const engine = new LlamaEngine(log);
  const chat = new ChatViewProvider(context.extensionUri);
  const changePreview = new ChangePreviewProvider();
  const catalog = loadCatalog(context.extensionPath);
  const systemPrompt = fs.readFileSync(path.join(context.extensionPath, 'resources', 'system-prompt.md'), 'utf8');
  const agentSystemPrompt = fs.readFileSync(path.join(context.extensionPath, 'resources', 'agent-system-prompt.md'), 'utf8');
  const agent = new WorkspaceAgent(context, activity => chat.setStatus(`Agente · ${activity}`, 'agent'));
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'offgrid.manageModels';
  statusBar.text = '$(plug) Offgrid';
  statusBar.tooltip = 'Gerenciar modelos locais';
  statusBar.show();

  let generationAbort = null;
  let currentInstaller = null;
  let pinnedUri = null;
  let pinLocked = false;

  function relativePath(uri) {
    if (!uri) return '';
    return vscode.workspace.asRelativePath(uri, true);
  }

  function canUseAsContext(uri) {
    return Boolean(uri && uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri));
  }

  function setPinnedUri(uri, locked = pinLocked) {
    pinnedUri = canUseAsContext(uri) ? uri : null;
    pinLocked = Boolean(locked && pinnedUri);
    chat.setPinnedFile(relativePath(pinnedUri), pinLocked);
  }

  function followActiveEditor(editor = vscode.window.activeTextEditor) {
    if (pinLocked) return;
    if (editor && canUseAsContext(editor.document.uri)) setPinnedUri(editor.document.uri, false);
  }

  followActiveEditor();

  async function modelOptions() {
    const config = vscode.workspace.getConfiguration('offgrid');
    return {
      modelPath: config.get('modelPath', ''),
      gpu: config.get('gpu', 'auto'),
      contextSize: config.get('contextSize', 4096),
      maxTokens: config.get('maxTokens', 1024),
      temperature: config.get('temperature', 0.2),
      agentMaxTokens: config.get('agentMaxTokens', 4096)
    };
  }

  async function loadConfiguredModel(showErrors = true) {
    const options = await modelOptions();
    if (!options.modelPath) {
      chat.setStatus('Nenhum modelo configurado. Abra o gerenciador de modelos.');
      statusBar.text = '$(plug) Offgrid';
      log('Nenhum modelPath configurado.');
      return false;
    }

    const modelName = path.basename(options.modelPath, '.gguf');
    chat.setStatus(`Carregando ${modelName}...`);
    statusBar.text = `$(loading~spin) ${modelName}`;
    log(`Solicitado carregamento de ${options.modelPath}; gpu=${options.gpu}; contexto=${options.contextSize}`);
    try {
      await engine.load(options, systemPrompt);
      const backend = engine.backend ? String(engine.backend).toUpperCase() : 'CPU';
      chat.setStatus(`Pronto · ${modelName} · ${backend}`);
      statusBar.text = `$(plug) ${modelName} [${backend}]`;
      log(`Modelo pronto: ${modelName}; backend=${backend}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof Error ? error.stack || error.message : String(error);
      log(`ERRO ao carregar modelo: ${details}`);
      chat.setStatus(`Erro ao carregar: ${message}`);
      statusBar.text = '$(error) Offgrid';
      if (showErrors) {
        const action = await vscode.window.showErrorMessage(
          `Offgrid: não foi possível carregar o modelo. ${message}`,
          'Abrir logs'
        );
        if (action === 'Abrir logs') output.show(true);
      }
      return false;
    }
  }

  function resolveReleaseBaseUrl() {
    const configured = vscode.workspace.getConfiguration('offgrid').get('releaseBaseUrl', '').trim();
    return configured || repositoryReleaseBase(context.extension.packageJSON, catalog.releaseTag);
  }

  async function manageModels() {
    const modelsDir = path.join(context.globalStorageUri.fsPath, 'models');
    await fsp.mkdir(modelsDir, { recursive: true });

    const items = [];
    for (const model of catalog.models) {
      const installed = fs.existsSync(path.join(modelsDir, model.fileName));
      items.push({
        label: `${installed ? '$(check)' : '$(cloud-download)'} ${model.displayName}`,
        description: `${model.approxSize} · ${model.hardware}`,
        detail: `${model.description} Licença: ${model.license}`,
        model,
        installed
      });
    }
    items.push({
      label: '$(folder-opened) Selecionar outro arquivo GGUF',
      description: 'Usar um modelo já existente no computador',
      local: true
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Offgrid — Modelos',
      placeHolder: 'Escolha um modelo para instalar ou ativar',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!selected) return;
    if (selected.local) {
      await selectLocalModel();
      return;
    }

    const model = selected.model;
    const destination = path.join(modelsDir, model.fileName);
    if (selected.installed) {
      await vscode.workspace.getConfiguration('offgrid').update('modelPath', destination, vscode.ConfigurationTarget.Global);
      await loadConfiguredModel();
      return;
    }

    if (!model.commercialUse) {
      const acceptance = await vscode.window.showWarningMessage(
        `${model.displayName} usa ${model.license} e não deve ser usado para fins comerciais. Continue somente para pesquisa autorizada.`,
        { modal: true },
        'Entendo: somente pesquisa'
      );
      if (acceptance !== 'Entendo: somente pesquisa') return;
    }

    let baseUrl;
    try {
      baseUrl = resolveReleaseBaseUrl();
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Instalando ${model.displayName}`,
      cancellable: true
    }, async (progress, token) => {
      const githubToken = await context.secrets.get('offgrid.githubToken');
      const installerOptions = { modelsDir, baseUrl };
      if (githubToken) {
        const assets = await loadGithubReleaseAssets(context.extension.packageJSON, catalog.releaseTag, githubToken);
        installerOptions.resolveAssetUrl = part => {
          const url = assets.get(part);
          if (!url) throw new Error(`Asset não encontrado no Release: ${part}`);
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
          if (event.stage === 'download-start') {
            progress.report({ message: `Parte ${event.partIndex + 1}/${event.partCount}` });
          } else if (event.stage === 'download-progress' && event.total > 0) {
            const percent = Math.floor((event.received / event.total) * 100);
            progress.report({ message: `Parte ${event.partIndex + 1}/${event.partCount}: ${percent}%` });
          } else if (event.stage === 'assemble') {
            progress.report({ message: `Montando arquivo ${event.partIndex + 1}/${event.partCount}` });
          } else if (event.stage === 'verify') {
            progress.report({ message: 'Validando SHA-256' });
          }
        }
      });
      token.onCancellationRequested(() => currentInstaller?.cancel());
      try {
        const installedPath = await currentInstaller.install(model);
        await vscode.workspace.getConfiguration('offgrid').update('modelPath', installedPath, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`${model.displayName} instalado e validado.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error?.name !== 'AbortError') vscode.window.showErrorMessage(`Falha na instalação: ${message}`);
      } finally {
        currentInstaller = null;
      }
    });

    await loadConfiguredModel(false);
  }

  async function selectLocalModel() {
    const selected = await vscode.window.showOpenDialog({
      title: 'Selecionar modelo GGUF',
      filters: { 'Modelo GGUF': ['gguf'] },
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false
    });
    if (!selected?.length) return;
    await vscode.workspace.getConfiguration('offgrid').update('modelPath', selected[0].fsPath, vscode.ConfigurationTarget.Global);
    await loadConfiguredModel();
  }

  async function buildWorkspaceContext() {
    if (!vscode.workspace.getConfiguration('offgrid').get('includeWorkspaceContext', true)) return '';
    const sections = [];
    const contextUri = pinnedUri || vscode.window.activeTextEditor?.document.uri;

    if (contextUri && canUseAsContext(contextUri)) {
      const document = await vscode.workspace.openTextDocument(contextUri);
      const activeEditor = vscode.window.activeTextEditor;
      const selectedText = activeEditor?.document.uri.toString() === contextUri.toString() && !activeEditor.selection.isEmpty
        ? document.getText(activeEditor.selection)
        : '';
      let documentText = document.getText();
      const maxChars = 24000;
      if (documentText.length > maxChars) documentText = `${documentText.slice(0, maxChars)}\n...[arquivo truncado]`;
      sections.push(`## Arquivo fixado — ponto de partida\nCaminho: ${relativePath(contextUri)}\nLinguagem: ${document.languageId}\n\n\`\`\`${document.languageId}\n${documentText}\n\`\`\``);
      if (selectedText) sections.push(`## Seleção atual do arquivo fixado\n\n\`\`\`${document.languageId}\n${selectedText.slice(0, 12000)}\n\`\`\``);
    }

    if (vscode.workspace.workspaceFolders?.length) {
      const files = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,out,dist,build,coverage,.next,.venv,venv,target}/**',
        120
      );
      const tree = files.map(uri => vscode.workspace.asRelativePath(uri)).sort().join('\n');
      if (tree) sections.push(`## Arquivos do workspace (amostra)\n${tree}`);
    }

    return sections.length ? `\n\n<contexto_workspace>\n${sections.join('\n\n')}\n</contexto_workspace>` : '';
  }

  async function runChat(text) {
    generationAbort = new AbortController();
    chat.addMessage('assistant', '');
    chat.setStatus('Gerando resposta...');
    try {
      const workspaceContext = await buildWorkspaceContext();
      await engine.prompt(`${text}${workspaceContext}`, {
        signal: generationAbort.signal,
        onChunk: chunk => chat.appendAssistant(chunk)
      });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        chat.appendAssistant(`\n\n[Erro: ${error instanceof Error ? error.message : String(error)}]`);
      }
    } finally {
      generationAbort = null;
      chat.finishAssistant();
      const options = await modelOptions();
      chat.setStatus(`Pronto · ${path.basename(options.modelPath || 'sem modelo', '.gguf')}`);
    }
  }

  async function agentTaskPrompt(text) {
    const hints = [];
    const contextUri = pinnedUri || vscode.window.activeTextEditor?.document.uri;
    if (contextUri && canUseAsContext(contextUri)) {
      hints.push(`Arquivo fixado e ponto de partida obrigatório: ${relativePath(contextUri)}`);
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document.uri.toString() === contextUri.toString() && !activeEditor.selection.isEmpty) {
        const selected = activeEditor.document.getText(activeEditor.selection).slice(0, 6000);
        hints.push(`Seleção atual (apenas pista; releia o arquivo antes de editar):\n${selected}`);
      }
    }
    const roots = (vscode.workspace.workspaceFolders || []).map(folder => folder.name).join(', ');
    return [
      `Tarefa solicitada: ${text}`,
      roots ? `Workspace(s): ${roots}` : '',
      ...hints,
      'Comece lendo o arquivo fixado, pesquise os arquivos relacionados e consulte node_modules somente quando necessário.',
      'Prepare as alterações e chame applyChanges. Essa ferramenta NÃO salva: ela envia a proposta para revisão visual do usuário.'
    ].filter(Boolean).join('\n\n');
  }

  async function runAgent(text) {
    if (agent.hasPendingReview) {
      chat.addMessage('system', 'Existe uma revisão pendente. Aceite ou rejeite as alterações atuais antes de iniciar outra tarefa.');
      chat.finishAssistant();
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      chat.addMessage('system', 'Abra uma pasta ou workspace antes de usar o modo Agente.');
      chat.finishAssistant();
      return;
    }
    if (!vscode.workspace.isTrusted) {
      chat.addMessage('system', 'O modo Agente exige um workspace confiável no VS Code.');
      chat.finishAssistant();
      return;
    }

    const requireConfirmation = vscode.workspace.getConfiguration('offgrid').get('agentRequireConfirmation', true);
    if (requireConfirmation) {
      const confirmation = await vscode.window.showWarningMessage(
        'O Offgrid poderá ler arquivos do workspace e de node_modules. Ele preparará uma proposta; nada será salvo até você revisar os diffs e aceitar.',
        { modal: true },
        'Executar agente'
      );
      if (confirmation !== 'Executar agente') {
        chat.addMessage('system', 'Execução do agente cancelada.');
        chat.finishAssistant();
        return;
      }
    }

    agent.reset();
    generationAbort = new AbortController();
    chat.addMessage('assistant', '');
    chat.setStatus('Agente · iniciando análise...');
    let streamed = false;
    try {
      const functions = await agent.createFunctions();
      const options = await modelOptions();
      const result = await engine.runAgent(await agentTaskPrompt(text), {
        functions,
        agentSystemPrompt,
        maxTokens: options.agentMaxTokens,
        signal: generationAbort.signal,
        onChunk: chunk => {
          streamed = true;
          chat.appendAssistant(chunk);
        }
      });
      if (!streamed && result) chat.appendAssistant(result);

      if (agent.hasStagedChanges && !agent.hasPendingReview) {
        agent.preparePendingReview('Alterações propostas pelo agente');
      }
      const review = agent.getPendingReview();
      if (review) {
        const requireReview = vscode.workspace.getConfiguration('offgrid').get('agentRequireReview', true);
        if (requireReview) {
          chat.showChangeReview(review);
          chat.addMessage('system', 'Nenhum arquivo foi salvo ainda. Abra os diffs e escolha Aceitar alterações ou Rejeitar.');
        } else {
          const result = await agent.acceptPendingChanges();
          chat.addMessage('system', `${result.files.length} arquivo(s) aceito(s) e salvo(s) automaticamente.`);
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        chat.appendAssistant(`\n\n[Erro do agente: ${error instanceof Error ? error.message : String(error)}]`);
      }
    } finally {
      if (!agent.hasPendingReview) agent.staged.clear();
      generationAbort = null;
      chat.finishAssistant();
      const options = await modelOptions();
      chat.setStatus(`Pronto · ${path.basename(options.modelPath || 'sem modelo', '.gguf')}`);
    }
  }

  chat.onSubmit(async (text, mode = 'chat') => {
    if (!text) {
      chat.finishAssistant();
      return;
    }
    chat.addMessage('user', mode === 'agent' ? `[Agente] ${text}` : text);
    if (!engine.isLoaded) {
      chat.addMessage('system', 'O modelo ainda não está carregado. Tentando carregar a configuração atual...');
      const loaded = await loadConfiguredModel(true);
      if (!loaded) {
        chat.addMessage('system', 'Não foi possível carregar o modelo. Consulte Exibir → Saída → Offgrid.');
        chat.finishAssistant();
        return;
      }
    }

    if (mode === 'agent') await runAgent(text);
    else await runChat(text);
  });

  chat.onAbort(() => generationAbort?.abort());

  chat.onAction(async message => {
    try {
      if (message.type === 'pinCurrent') {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !canUseAsContext(editor.document.uri)) {
          vscode.window.showWarningMessage('Abra um arquivo do workspace antes de fixá-lo.');
          return;
        }
        setPinnedUri(editor.document.uri, true);
      } else if (message.type === 'unpin') {
        pinLocked = false;
        pinnedUri = null;
        followActiveEditor();
        chat.setPinnedFile(relativePath(pinnedUri), false);
      } else if (message.type === 'openPinned') {
        if (pinnedUri) await vscode.window.showTextDocument(pinnedUri, { preview: false });
      } else if (message.type === 'openDiff' && typeof message.filePath === 'string') {
        await changePreview.open(agent.getPendingChange(message.filePath));
      } else if (message.type === 'acceptChanges') {
        const result = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Aplicando alterações aceitas do Offgrid',
          cancellable: false
        }, () => agent.acceptPendingChanges());
        changePreview.clear();
        chat.updateChangeReview('accepted', `${result.files.length} arquivo(s) aceito(s) e salvo(s).`);
        const action = await vscode.window.showInformationMessage(
          `Offgrid salvou ${result.files.length} arquivo(s).`,
          'Desfazer alterações'
        );
        if (action === 'Desfazer alterações') await vscode.commands.executeCommand('offgrid.undoLastAgentChanges');
      } else if (message.type === 'rejectChanges') {
        const files = agent.rejectPendingChanges();
        changePreview.clear();
        chat.updateChangeReview('rejected', `${files.length} alteração(ões) rejeitada(s). Nenhum arquivo foi salvo.`);
      }
    } catch (error) {
      const details = error instanceof Error ? error.stack || error.message : String(error);
      log(`Erro em ação do chat: ${details}`);
      vscode.window.showErrorMessage(`Offgrid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('offgrid-diff', changePreview),
    vscode.commands.registerCommand('offgrid.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.offgrid');
    }),
    vscode.commands.registerCommand('offgrid.manageModels', manageModels),
    vscode.commands.registerCommand('offgrid.selectLocalModel', selectLocalModel),
    vscode.commands.registerCommand('offgrid.reloadModel', () => loadConfiguredModel(true)),
    vscode.commands.registerCommand('offgrid.pinActiveFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && canUseAsContext(editor.document.uri)) setPinnedUri(editor.document.uri, true);
    }),
    vscode.commands.registerCommand('offgrid.unpinFile', () => {
      pinLocked = false; pinnedUri = null; followActiveEditor(); chat.setPinnedFile(relativePath(pinnedUri), false);
    }),
    vscode.commands.registerCommand('offgrid.setGithubToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Token do GitHub',
        prompt: 'Necessário somente para Releases privados. O token será guardado no SecretStorage do VS Code.',
        password: true,
        ignoreFocusOut: true
      });
      if (token === undefined) return;
      if (token.trim()) {
        await context.secrets.store('offgrid.githubToken', token.trim());
        vscode.window.showInformationMessage('Token do GitHub salvo com segurança.');
      } else {
        await context.secrets.delete('offgrid.githubToken');
        vscode.window.showInformationMessage('Token do GitHub removido.');
      }
    }),
    vscode.commands.registerCommand('offgrid.clearChat', async () => {
      chat.clear();
      await engine.clearHistory(systemPrompt);
    }),
    vscode.commands.registerCommand('offgrid.undoLastAgentChanges', async () => {
      try {
        const files = await agent.undoLastChanges();
        vscode.window.showInformationMessage(`Alterações desfeitas em ${files.length} arquivo(s).`);
      } catch (error) {
        vscode.window.showErrorMessage(`Offgrid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => followActiveEditor(editor)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('offgrid.modelPath')
        || event.affectsConfiguration('offgrid.gpu')
        || event.affectsConfiguration('offgrid.contextSize')) {
        loadConfiguredModel(false);
      }
    }),
    statusBar,
    output,
    { dispose: () => { changePreview.clear(); engine.dispose(); } }
  );

  chat.setPinnedFile(relativePath(pinnedUri), pinLocked);
  log(`Offgrid ${context.extension.packageJSON.version || ''} ativado.`);
  autoSelectBundledModel(context, catalog)
    .then(() => loadConfiguredModel(false))
    .catch(error => log(`Falha na inicialização: ${error instanceof Error ? error.stack || error.message : String(error)}`));
}


async function loadGithubReleaseAssets(packageJson, releaseTag, token) {
  const { owner, repository } = repositoryCoordinates(packageJson);
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(releaseTag)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'offgrid'
    }
  });
  if (!response.ok) {
    throw new Error(`Não foi possível ler o Release privado: HTTP ${response.status}.`);
  }
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

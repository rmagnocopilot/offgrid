'use strict';

const crypto = require('node:crypto');

class ChatViewProvider {
  static viewType = 'offgrid.chatView';

  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.submitHandler = null;
    this.abortHandler = null;
    this.actionHandler = null;
    this.pendingPinnedState = { filePath: '', locked: false };
    this.pendingModelState = { models: [], chatState: 'Aguardando', agentState: 'Aguardando' };
    this.pendingSessions = { activeSessionId: '', sessions: [] };
    this.pendingMessages = [];
    this.pendingContextState = { entries: [] };
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.#html(view.webview);
    view.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'send' && typeof message.text === 'string') {
        await this.submitHandler?.(message.text.trim(), message.mode === 'agent' ? 'agent' : 'chat');
      } else if (message?.type === 'abort') {
        this.abortHandler?.();
      } else if (typeof message?.type === 'string') {
        await this.actionHandler?.(message);
      }
    });
    this.setPinnedFile(this.pendingPinnedState.filePath, this.pendingPinnedState.locked);
    this.setModelState(this.pendingModelState);
    this.setSessions(this.pendingSessions);
    this.setContextState(this.pendingContextState);
    this.loadSession(this.pendingMessages);
  }

  onSubmit(handler) { this.submitHandler = handler; }
  onAbort(handler) { this.abortHandler = handler; }
  onAction(handler) { this.actionHandler = handler; }

  addMessage(role, text, streaming = false) {
    this.view?.webview.postMessage({ type: 'message', role, text, streaming });
  }

  appendAssistant(text) {
    this.view?.webview.postMessage({ type: 'appendAssistant', text });
  }

  finishAssistant() {
    this.view?.webview.postMessage({ type: 'finishAssistant' });
  }

  setStatus(text, state = 'idle') {
    this.view?.webview.postMessage({ type: 'status', text, state });
  }

  setPinnedFile(filePath, locked = false) {
    this.pendingPinnedState = { filePath: filePath || '', locked: Boolean(locked) };
    this.view?.webview.postMessage({ type: 'pinnedFile', filePath: filePath || '', locked: Boolean(locked) });
  }

  setContextState(state) {
    this.pendingContextState = state || { entries: [] };
    this.view?.webview.postMessage({ type: 'contextState', ...this.pendingContextState });
  }

  setModelState(state) {
    this.pendingModelState = state || { models: [] };
    this.view?.webview.postMessage({ type: 'modelState', ...this.pendingModelState });
  }

  setSessions(state) {
    this.pendingSessions = state || { activeSessionId: '', sessions: [] };
    this.view?.webview.postMessage({ type: 'sessions', ...this.pendingSessions });
  }

  loadSession(messages) {
    this.pendingMessages = Array.isArray(messages) ? messages : [];
    this.view?.webview.postMessage({ type: 'loadSession', messages: this.pendingMessages });
  }

  showChangeReview(review) {
    this.view?.webview.postMessage({
      type: 'changeReview',
      summary: review?.summary || 'Alterações propostas pelo agente',
      files: Array.isArray(review?.files) ? review.files : []
    });
  }

  updateChangeReview(status, message = '') {
    this.view?.webview.postMessage({ type: 'changeReviewStatus', status, message });
  }

  clear() {
    this.loadSession([]);
  }

  reveal() {
    this.view?.show?.(true);
  }

  #html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); overflow: hidden; }
  #app { height: 100vh; display: grid; grid-template-rows: auto auto auto 1fr auto; position: relative; }
  #topbar, #sessionbar, #contextBar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  #topbar { background: var(--vscode-editor-background); }
  #modelSelect, #sessionSelect { flex: 1; min-width: 0; }
  #statusPanel { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; display: grid; grid-template-columns: 1fr 1fr; gap: 3px 8px; opacity: .95; }
  .status-label { opacity: .7; }
  #pinnedLabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  #contextCount { font-size: 10px; opacity: .8; white-space: nowrap; }
  #messages { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .message { padding: 10px 11px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  .user { background: var(--vscode-inputOption-activeBackground); border: 1px solid var(--vscode-inputOption-activeBorder); }
  .assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .system { opacity: .85; border-left: 3px solid var(--vscode-descriptionForeground); border-radius: 0; }
  .review { padding: 11px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editor-background); border-radius: 8px; }
  .review h3 { font-size: 13px; margin: 0 0 6px; }
  .review-summary { font-size: 12px; opacity: .9; margin-bottom: 8px; white-space: pre-wrap; }
  .review-files { display: grid; gap: 5px; margin-bottom: 9px; }
  .file-button { text-align: left; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .review-actions { display: flex; gap: 7px; }
  .review-status { margin-top: 7px; font-size: 12px; opacity: .9; }
  #composer { padding: 10px; border-top: 1px solid var(--vscode-panel-border); display: grid; gap: 8px; }
  textarea { width: 100%; min-height: 72px; resize: vertical; padding: 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
  .toolbar { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  select { min-width: 0; padding: 5px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
  .mode-help { font-size: 10px; opacity: .8; text-align: right; }
  .buttons { display: flex; gap: 8px; }
  button { border: 0; padding: 7px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.small { padding: 4px 7px; font-size: 11px; }
  button.icon { min-width: 28px; padding: 4px 6px; }
  button:disabled { opacity: .5; cursor: default; }
  #sessionDrawer { position: absolute; z-index: 30; inset: 0 auto 0 0; width: min(320px, 90vw); background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-panel-border); box-shadow: 4px 0 18px rgba(0,0,0,.35); display: none; grid-template-rows: auto auto 1fr; }
  #sessionDrawer.open { display: grid; }
  #drawerHeader { display: flex; align-items: center; justify-content: space-between; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  #sessionSearch { margin: 8px; padding: 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
  #sessionList { overflow-y: auto; padding: 6px; display: grid; align-content: start; gap: 5px; }
  .session-item { border: 1px solid transparent; padding: 7px; background: var(--vscode-editor-background); display: grid; gap: 5px; }
  .session-item.active { border-color: var(--vscode-focusBorder); }
  .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .session-meta { font-size: 10px; opacity: .7; }
  .session-actions { display: flex; gap: 4px; flex-wrap: wrap; }
</style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <select id="modelSelect" title="Modelo ativo"></select>
    <button id="manageModels" class="secondary icon" title="Gerenciar modelos">⚙</button>
    <button id="unloadModel" class="secondary icon" title="Descarregar modelo da memória">⏏</button>
    <button id="diagnostics" class="secondary icon" title="Diagnóstico do modelo">ⓘ</button>
    <button id="resources" class="secondary icon" title="RAM e VRAM">▥</button>
  </div>
  <div id="sessionbar">
    <button id="openSessions" class="secondary small">Sessões</button>
    <select id="sessionSelect" title="Sessão atual"></select>
    <button id="newSession" class="small" title="Nova sessão">＋</button>
  </div>
  <div>
    <div id="statusPanel">
      <div><span class="status-label">Modelo:</span> <span id="statusModel">—</span></div>
      <div><span class="status-label">Backend:</span> <span id="statusBackend">—</span></div>
      <div><span class="status-label">Contexto:</span> <span id="statusContext">—</span></div>
      <div><span class="status-label">Chat:</span> <span id="statusChat">Aguardando</span></div>
      <div><span class="status-label">Agente:</span> <span id="statusAgent">Aguardando</span></div>
      <div><span class="status-label">RAM:</span> <span id="statusRam">—</span></div>
      <div><span class="status-label">Motor:</span> <span id="statusEngine">—</span></div>
      <div><span class="status-label">GPU:</span> <span id="statusGpu">—</span></div>
      <div><button id="openSettings" class="secondary small">Configurações</button></div>
    </div>
    <div id="contextBar">
      <span id="pinnedLabel">Arquivo de contexto: nenhum</span>
      <span id="contextCount">0 extras</span>
      <button id="manageContext" class="secondary small">Contexto</button>
      <button id="openPinned" class="secondary small" title="Abrir arquivo fixado">Abrir</button>
      <button id="pinCurrent" class="secondary small" title="Fixar a aba atual">Fixar</button>
      <button id="unpin" class="secondary small" title="Acompanhar a aba ativa">Auto</button>
    </div>
  </div>
  <div id="messages"><div class="message system">Tudo é executado localmente. Escolha o modelo no topo e use o arquivo fixado como ponto de partida.</div></div>
  <div id="composer">
    <div class="toolbar">
      <select id="mode">
        <option value="chat">Chat — somente resposta</option>
        <option value="agent">Agente — altera arquivos</option>
      </select>
      <span id="modeHelp" class="mode-help">Não modifica o workspace.</span>
    </div>
    <textarea id="input" placeholder="Pergunte sobre o código... (Ctrl+Enter para enviar)"></textarea>
    <div class="buttons"><button id="send">Enviar</button><button id="abort" class="secondary" disabled>Parar</button></div>
  </div>
  <aside id="sessionDrawer">
    <div id="drawerHeader"><strong>Sessões</strong><button id="closeSessions" class="secondary small">Fechar</button></div>
    <input id="sessionSearch" placeholder="Buscar sessão...">
    <div id="sessionList"></div>
  </aside>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const abort = document.getElementById('abort');
  const mode = document.getElementById('mode');
  const modeHelp = document.getElementById('modeHelp');
  const pinnedLabel = document.getElementById('pinnedLabel');
  const openPinned = document.getElementById('openPinned');
  const modelSelect = document.getElementById('modelSelect');
  const sessionSelect = document.getElementById('sessionSelect');
  const sessionDrawer = document.getElementById('sessionDrawer');
  const sessionList = document.getElementById('sessionList');
  const sessionSearch = document.getElementById('sessionSearch');
  let currentAssistant = null;
  let currentReview = null;
  let sessionsState = { activeSessionId: '', sessions: [] };
  let modelState = { models: [] };

  function add(role, text) {
    const el = document.createElement('div');
    el.className = 'message ' + role;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function renderMessages(items) {
    messages.innerHTML = '';
    if (!items.length) add('system', 'Nova sessão. O processamento ocorre localmente.');
    items.forEach(item => add(item.role || 'system', item.mode === 'agent' && item.role === 'user' ? '[Agente] ' + item.text : item.text));
    currentAssistant = null;
    currentReview = null;
  }

  function showReview(summary, files) {
    const card = document.createElement('div');
    card.className = 'review';
    const title = document.createElement('h3');
    title.textContent = 'Revisar alterações do agente';
    const description = document.createElement('div');
    description.className = 'review-summary';
    description.textContent = summary;
    const fileList = document.createElement('div');
    fileList.className = 'review-files';
    files.forEach(filePath => {
      const button = document.createElement('button');
      button.className = 'secondary file-button';
      button.textContent = 'Ver diff: ' + filePath;
      button.title = 'Linhas removidas em vermelho e adicionadas em verde';
      button.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', filePath }));
      fileList.appendChild(button);
    });
    const actions = document.createElement('div');
    actions.className = 'review-actions';
    const accept = document.createElement('button');
    accept.textContent = 'Aceitar alterações';
    accept.addEventListener('click', () => vscode.postMessage({ type: 'acceptChanges' }));
    const reject = document.createElement('button');
    reject.className = 'secondary';
    reject.textContent = 'Rejeitar';
    reject.addEventListener('click', () => vscode.postMessage({ type: 'rejectChanges' }));
    actions.append(accept, reject);
    const status = document.createElement('div');
    status.className = 'review-status';
    card.append(title, description, fileList, actions, status);
    messages.appendChild(card);
    messages.scrollTop = messages.scrollHeight;
    currentReview = { card, status };
  }

  function renderModels() {
    modelSelect.innerHTML = '';
    if (!modelState.models?.length) {
      const option = document.createElement('option'); option.textContent = 'Nenhum modelo'; modelSelect.appendChild(option); return;
    }
    modelState.models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      const status = model.loaded ? 'carregado' : model.active ? 'ativo' : model.installed ? 'instalado' : 'não instalado';
      option.textContent = model.name + ' — ' + status;
      if (model.id === modelState.activeModelId || (!modelState.activeModelId && model.id === modelState.loadedModelId)) option.selected = true;
      modelSelect.appendChild(option);
    });
    document.getElementById('statusModel').textContent = modelState.loadedModelName || 'nenhum';
    document.getElementById('statusBackend').textContent = modelState.backend || '—';
    document.getElementById('statusContext').textContent = String(modelState.contextSize || '—') + (modelState.gpuLayers !== undefined ? ' · camadas ' + modelState.gpuLayers : '');
    document.getElementById('statusChat').textContent = modelState.chatState || 'Aguardando';
    document.getElementById('statusAgent').textContent = modelState.agentState || 'Aguardando';
    document.getElementById('statusRam').textContent = modelState.resources?.ram || '—';
    document.getElementById('statusEngine').textContent = modelState.resources?.engine || '—';
    document.getElementById('statusGpu').textContent = modelState.resources?.gpu || '—';
  }

  function renderSessions() {
    sessionSelect.innerHTML = '';
    sessionsState.sessions.forEach(session => {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = (session.pinned ? '📌 ' : '') + session.title;
      option.selected = session.id === sessionsState.activeSessionId;
      sessionSelect.appendChild(option);
    });
    renderSessionDrawer();
  }

  function renderSessionDrawer() {
    const query = sessionSearch.value.trim().toLowerCase();
    sessionList.innerHTML = '';
    sessionsState.sessions.filter(session => !query || session.title.toLowerCase().includes(query)).forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item' + (session.id === sessionsState.activeSessionId ? ' active' : '');
      const title = document.createElement('div'); title.className = 'session-title'; title.textContent = (session.pinned ? '📌 ' : '') + session.title;
      title.addEventListener('click', () => { vscode.postMessage({ type: 'selectSession', sessionId: session.id }); sessionDrawer.classList.remove('open'); });
      const meta = document.createElement('div'); meta.className = 'session-meta'; meta.textContent = session.messageCount + ' mensagem(ns)';
      const actions = document.createElement('div'); actions.className = 'session-actions';
      const buttons = [
        ['Abrir', 'selectSession'],
        ['Renomear', 'renameSession'],
        [session.pinned ? 'Desafixar' : 'Fixar', 'pinSession'],
        ['Duplicar', 'duplicateSession'],
        ['Excluir', 'deleteSession']
      ];
      buttons.forEach(([label, type]) => {
        const button = document.createElement('button'); button.className = 'secondary small'; button.textContent = label;
        button.addEventListener('click', () => vscode.postMessage({ type, sessionId: session.id }));
        actions.appendChild(button);
      });
      item.append(title, meta, actions); sessionList.appendChild(item);
    });
  }

  function submit() {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    input.value = '';
    send.disabled = true;
    abort.disabled = false;
    vscode.postMessage({ type: 'send', text, mode: mode.value });
  }

  modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'switchModel', modelId: modelSelect.value }));
  sessionSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectSession', sessionId: sessionSelect.value }));
  mode.addEventListener('change', () => {
    const agent = mode.value === 'agent';
    modeHelp.textContent = agent ? 'Pesquisa o projeto; escrita depende do modo de aprovação.' : 'Não modifica o workspace.';
    input.placeholder = agent ? 'Descreva a alteração. O arquivo fixado será o ponto de partida...' : 'Pergunte sobre o arquivo fixado... (Ctrl+Enter para enviar)';
  });
  document.getElementById('manageModels').addEventListener('click', () => vscode.postMessage({ type: 'manageModels' }));
  document.getElementById('unloadModel').addEventListener('click', () => vscode.postMessage({ type: 'unloadModel' }));
  document.getElementById('diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'showDiagnostics' }));
  document.getElementById('resources').addEventListener('click', () => vscode.postMessage({ type: 'showResources' }));
  document.getElementById('openSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  document.getElementById('openSessions').addEventListener('click', () => sessionDrawer.classList.add('open'));
  document.getElementById('closeSessions').addEventListener('click', () => sessionDrawer.classList.remove('open'));
  sessionSearch.addEventListener('input', renderSessionDrawer);
  document.getElementById('manageContext').addEventListener('click', () => vscode.postMessage({ type: 'manageContext' }));
  document.getElementById('pinCurrent').addEventListener('click', () => vscode.postMessage({ type: 'pinCurrent' }));
  document.getElementById('unpin').addEventListener('click', () => vscode.postMessage({ type: 'unpin' }));
  openPinned.addEventListener('click', () => vscode.postMessage({ type: 'openPinned' }));
  send.addEventListener('click', submit);
  abort.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); submit(); } });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'message') currentAssistant = add(message.role, message.text || '');
    else if (message.type === 'appendAssistant') {
      if (!currentAssistant || !currentAssistant.classList.contains('assistant')) currentAssistant = add('assistant', '');
      currentAssistant.textContent += message.text; messages.scrollTop = messages.scrollHeight;
    } else if (message.type === 'finishAssistant') {
      currentAssistant = null; send.disabled = false; abort.disabled = true; input.focus();
    } else if (message.type === 'status') {
      document.getElementById('statusChat').textContent = message.text;
    } else if (message.type === 'pinnedFile') {
      const modeText = message.locked ? 'Fixado' : 'Aba ativa';
      pinnedLabel.textContent = message.filePath ? modeText + ': ' + message.filePath : 'Arquivo de contexto: nenhum';
      pinnedLabel.title = message.filePath || ''; openPinned.disabled = !message.filePath;
    } else if (message.type === 'contextState') {
      document.getElementById('contextCount').textContent = (message.entries?.length || 0) + ' extras';
    } else if (message.type === 'modelState') {
      modelState = message; renderModels();
    } else if (message.type === 'sessions') {
      sessionsState = message; renderSessions();
    } else if (message.type === 'loadSession') {
      renderMessages(message.messages || []);
    } else if (message.type === 'changeReview') {
      showReview(message.summary, message.files || []);
    } else if (message.type === 'changeReviewStatus' && currentReview) {
      currentReview.status.textContent = message.message || message.status;
      currentReview.card.querySelectorAll('button').forEach(button => { button.disabled = true; });
      if (message.status === 'accepted') currentReview.card.style.borderColor = 'var(--vscode-testing-iconPassed)';
      if (message.status === 'rejected') currentReview.card.style.opacity = '.7';
    } else if (message.type === 'clear') {
      renderMessages([]);
    }
  });
</script>
</body>
</html>`;
  }
}

module.exports = { ChatViewProvider };

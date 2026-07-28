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
    this.view?.webview.postMessage({ type: 'clear' });
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
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  #app { height: 100vh; display: grid; grid-template-rows: auto auto 1fr auto; }
  #status { padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; opacity: .9; }
  #contextBar { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
  #pinnedLabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
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
  select { min-width: 150px; padding: 6px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
  .mode-help { font-size: 11px; opacity: .8; }
  .buttons { display: flex; gap: 8px; }
  button { border: 0; padding: 7px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.small { padding: 4px 7px; font-size: 11px; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<div id="app">
  <div id="status">Configure um modelo no gerenciador.</div>
  <div id="contextBar">
    <span id="pinnedLabel">Arquivo de contexto: nenhum</span>
    <button id="openPinned" class="secondary small" title="Abrir arquivo fixado">Abrir</button>
    <button id="pinCurrent" class="secondary small" title="Fixar a aba de código atual">Fixar aba</button>
    <button id="unpin" class="secondary small" title="Voltar a acompanhar automaticamente a aba ativa">Auto</button>
  </div>
  <div id="messages"><div class="message system">Tudo é executado localmente. O arquivo de contexto mostrado acima é o ponto de partida da conversa e do agente.</div></div>
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
  let currentAssistant = null;
  let currentReview = null;

  function add(role, text) {
    const el = document.createElement('div');
    el.className = 'message ' + role;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
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
      button.title = 'Abrir comparação com linhas removidas em vermelho e adicionadas em verde';
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
    currentReview = { card, actions, status };
  }

  function submit() {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    input.value = '';
    send.disabled = true;
    abort.disabled = false;
    vscode.postMessage({ type: 'send', text, mode: mode.value });
  }

  mode.addEventListener('change', () => {
    const agent = mode.value === 'agent';
    modeHelp.textContent = agent
      ? 'Pesquisa o projeto; toda escrita exige revisão e aceite.'
      : 'Não modifica o workspace.';
    input.placeholder = agent
      ? 'Descreva a alteração. O arquivo fixado será o ponto de partida...'
      : 'Pergunte sobre o arquivo fixado... (Ctrl+Enter para enviar)';
  });
  document.getElementById('pinCurrent').addEventListener('click', () => vscode.postMessage({ type: 'pinCurrent' }));
  document.getElementById('unpin').addEventListener('click', () => vscode.postMessage({ type: 'unpin' }));
  openPinned.addEventListener('click', () => vscode.postMessage({ type: 'openPinned' }));
  send.addEventListener('click', submit);
  abort.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); submit(); }
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'message') {
      currentAssistant = add(message.role, message.text || '');
    } else if (message.type === 'appendAssistant') {
      if (!currentAssistant || !currentAssistant.classList.contains('assistant')) currentAssistant = add('assistant', '');
      currentAssistant.textContent += message.text;
      messages.scrollTop = messages.scrollHeight;
    } else if (message.type === 'finishAssistant') {
      currentAssistant = null; send.disabled = false; abort.disabled = true; input.focus();
    } else if (message.type === 'status') {
      document.getElementById('status').textContent = message.text;
    } else if (message.type === 'pinnedFile') {
      const modeText = message.locked ? 'Fixado' : 'Aba ativa';
      pinnedLabel.textContent = message.filePath ? modeText + ': ' + message.filePath : 'Arquivo de contexto: nenhum';
      pinnedLabel.title = message.filePath || '';
      openPinned.disabled = !message.filePath;
    } else if (message.type === 'changeReview') {
      showReview(message.summary, message.files || []);
    } else if (message.type === 'changeReviewStatus' && currentReview) {
      currentReview.status.textContent = message.message || message.status;
      currentReview.card.querySelectorAll('button').forEach(button => { button.disabled = true; });
      if (message.status === 'accepted') currentReview.card.style.borderColor = 'var(--vscode-testing-iconPassed)';
      if (message.status === 'rejected') currentReview.card.style.opacity = '.7';
    } else if (message.type === 'clear') {
      messages.innerHTML = ''; currentAssistant = null; currentReview = null;
    }
  });
</script>
</body>
</html>`;
  }
}

module.exports = { ChatViewProvider };
